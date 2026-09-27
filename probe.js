/* AAL — ANDROID_HTTPS_PWA_CAPABILITY_PROBE_V2
 * Sonde jetable. Aucune dépendance, aucune construction.
 * Les fixtures audio sont identiques à la sonde v1 (même signal mulberry32, graine 12345). */
"use strict";

const PROBE = "vs1-android-https-pwa-capability";
const VERSION = "2.0.0";
const N = 12000, SEED = 12345;
const VS1_MIN_QUOTA_MB = 100;          // pack VS1 ≈ 24 Mo + essais ; marge × 4
const DB_NAME = "vs1probe-v2";
const OPFS_MARKER = "vs1-marker.json";
const OPFS_OFFLINE = "vs1-offline.json";

const R = {                              // rapport brut (JSON exporté)
  probe: PROBE, version: VERSION, when: new Date().toISOString(),
  href: location.href, origin: location.origin, protocol: location.protocol,
  executionContext: "UNKNOWN", executionEvidence: [],
  secure: window.isSecureContext, displayMode: "unknown",
  navigatorStandalone: ("standalone" in navigator) ? navigator.standalone : null,
  referrer: document.referrer || "", ua: navigator.userAgent,
  navigationType: null, bootId: null, sameBrowsingSession: null, networkReachable: null,
  serviceWorker: { status: "NOT_TESTED" }, offline: { status: "NOT_TESTED" },
  idb: { status: "NOT_TESTED" }, idbMarker: {},
  opfs: { status: "NOT_TESTED" }, opfsMarker: {},
  quota: null, usage: null,
  persistedBefore: null, persistRequestResult: null, persistedAfter: null,
  audioRate: null, ctx48: null, baseLatency: null, outputLatency: null,
  wav: null, flac: null, flac441: null, speed: null,
  classification: null, runHistory: [], errors: []
};

/* ---------- utilitaires ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const errObj = (e) => ({ name: (e && e.name) || "Error", message: String((e && e.message) || e) });
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms + " ms : " + label)), ms))]);
function rid() { const a = new Uint32Array(2); crypto.getRandomValues(a); return a[0].toString(36) + a[1].toString(36); }

function displayMode() {
  for (const m of ["fullscreen", "standalone", "minimal-ui", "browser"])
    if (matchMedia(`(display-mode: ${m})`).matches) return m;
  return "unknown";
}

function classify() {
  const ev = []; const p = location.protocol; const dm = R.displayMode;
  const wv = /; wv\)/.test(navigator.userAgent);
  if (p === "content:") { ev.push("protocol=content:"); return ["CONTENT_URI", ev]; }
  if (p === "file:") { ev.push("protocol=file:"); return ["FILE_URI", ev]; }
  if (wv) ev.push("UA contient le jeton WebView « ; wv) »");
  if (p === "https:" && ["standalone", "fullscreen", "minimal-ui"].includes(dm) && !wv) {
    ev.push(`display-mode=${dm}`, "protocol=https:");
    return ["INSTALLED_PWA", ev];
  }
  if (wv) { ev.push(`display-mode=${dm}`); return ["ANDROID_WEBVIEW", ev]; }
  if (p === "https:" && dm === "browser") { ev.push("display-mode=browser", "protocol=https:"); return ["HTTPS_BROWSER_TAB", ev]; }
  ev.push(`protocol=${p}`, `display-mode=${dm}`, "aucune règle ne s'applique (localhost, iframe…)");
  return ["UNKNOWN", ev];
}

/* ---------- IndexedDB ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("blob"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("IndexedDB bloquée"));
  });
}
function idbDo(db, store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store); let out;
    const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const idbGet = (db, k) => idbDo(db, "kv", "readonly", (s) => s.get(k));
const idbPut = (db, k, v) => idbDo(db, "kv", "readwrite", (s) => s.put(v, k));

/* ---------- OPFS ---------- */
function opfsContext() { return { protocol: location.protocol, origin: location.origin, secure: window.isSecureContext, displayMode: R.displayMode }; }
async function opfsRoot() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    const e = new Error("navigator.storage.getDirectory absent"); e.name = "NotSupported"; throw e;
  }
  return navigator.storage.getDirectory();
}
async function opfsReadJson(name) {
  const root = await opfsRoot();
  try { const fh = await root.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }
  catch (e) { if (e && e.name === "NotFoundError") return null; throw e; }
}
async function opfsWriteJson(name, obj) {
  const root = await opfsRoot(); const fh = await root.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(JSON.stringify(obj)); await w.close();
}

/* ---------- réseau ---------- */
async function networkReachable() {
  try { await withTimeout(fetch("__netcheck?t=" + Date.now(), { cache: "no-store" }), 4000, "netcheck"); return true; }
  catch (_) { return false; }        // toute réponse HTTP (même 404) = réseau joignable
}

/* ---------- service worker ---------- */
async function setupServiceWorker() {
  const sw = { status: "FAIL", supported: "serviceWorker" in navigator, registered: false, activated: false,
    controlledAtLoad: !!(navigator.serviceWorker && navigator.serviceWorker.controller), controlled: false,
    scope: null, cacheName: null, cacheMissing: null, error: null };
  if (!sw.supported) { sw.error = { name: "NotSupported", message: "navigator.serviceWorker absent" }; return sw; }
  try {
    const reg = await withTimeout(navigator.serviceWorker.register("sw.js", { scope: "./" }), 8000, "register");
    sw.registered = true; sw.scope = reg.scope;
    const ready = await withTimeout(navigator.serviceWorker.ready, 15000, "ready");
    const act = ready.active;
    if (act && act.state !== "activated") {
      await withTimeout(new Promise((res) => act.addEventListener("statechange", () => { if (act.state === "activated") res(); })), 8000, "activation").catch(() => {});
    }
    sw.activated = !!act && act.state === "activated";
    if (!navigator.serviceWorker.controller) {
      await withTimeout(new Promise((res) => navigator.serviceWorker.addEventListener("controllerchange", res, { once: true })), 5000, "controllerchange").catch(() => {});
    }
    sw.controlled = !!navigator.serviceWorker.controller;
    if (sw.controlled) {
      const st = await withTimeout(new Promise((res) => {
        navigator.serviceWorker.addEventListener("message", function h(ev) {
          if (ev.data && ev.data.type === "cache-status") { navigator.serviceWorker.removeEventListener("message", h); res(ev.data); }
        });
        navigator.serviceWorker.controller.postMessage("cache-status");
      }), 5000, "cache-status").catch((e) => ({ error: errObj(e) }));
      sw.cacheName = st.cache || null; sw.cacheMissing = st.missing || null;
    }
    sw.status = sw.registered && sw.activated && sw.controlled ? "PASS" : "FAIL";
  } catch (e) { sw.error = errObj(e); sw.status = "FAIL"; }
  return sw;
}

/* ---------- marqueurs de persistance ---------- */
async function checkMarkers(db) {
  const boot = R.bootId; const same = R.sameBrowsingSession;
  // IndexedDB
  const im = db ? await idbGet(db, "marker").catch(() => null) : null;
  R.idbMarker = evalMarker(im, boot, same, db ? null : "IndexedDB indisponible");
  // OPFS
  let om = null, oerr = null;
  try { om = await opfsReadJson(OPFS_MARKER); } catch (e) { oerr = Object.assign(errObj(e), opfsContext()); }
  R.opfsMarker = evalMarker(om, boot, same, oerr);
  // Perte inattendue : IndexedDB dit « OPFS écrit » mais le fichier a disparu.
  if (im && im.opfsWritten && !om && !oerr) {
    R.opfsMarker.acrossReload = same ? "FAIL" : R.opfsMarker.acrossReload;
    R.opfsMarker.acrossRestart = same ? R.opfsMarker.acrossRestart : "FAIL";
    R.opfsMarker.note = "IndexedDB indique qu'un marqueur OPFS a été écrit au lancement " + im.bootId + ", mais le fichier est absent.";
  }
  // Résultats cumulés : un PASS obtenu à un lancement précédent reste acquis ; un FAIL est définitif.
  if (db) {
    const saved = (await idbGet(db, "markerResults").catch(() => null)) || {};
    const merge = (a, b) => (a === "FAIL" || b === "FAIL") ? "FAIL" : (a === "PASS" || b === "PASS") ? "PASS" : "NOT_TESTED";
    const out = {};
    for (const [k, m] of [["idb", R.idbMarker], ["opfs", R.opfsMarker]]) {
      for (const f of ["acrossReload", "acrossRestart"]) {
        const prevVal = saved[k + "." + f] ? saved[k + "." + f].status : "NOT_TESTED";
        const v = merge(prevVal, m[f]);
        out[k + "." + f] = { status: v, ctx: v === prevVal && saved[k + "." + f] ? saved[k + "." + f].ctx : R.executionContext };
        m[f] = v; m[f + "Context"] = out[k + "." + f].ctx;
      }
    }
    await idbPut(db, "markerResults", out).catch(() => {});
  }
}
function evalMarker(m, boot, same, err) {
  const out = { found: !!m, previous: m || null, acrossReload: "NOT_TESTED", acrossRestart: "NOT_TESTED", error: err || null };
  if (err) { out.acrossReload = out.acrossRestart = "FAIL"; return out; }
  if (!m) return out;                                         // premier lancement dans ce contexte
  if (same && m.bootId === boot) out.acrossReload = "PASS";   // même session de navigation, page rechargée
  if (!same && m.bootId !== boot) out.acrossRestart = "PASS"; // nouvelle session (onglet fermé ou navigateur relancé)
  return out;
}
async function writeMarkers(db) {
  const m = { bootId: R.bootId, t: new Date().toISOString(), ctx: R.executionContext, href: location.href, opfsWritten: false };
  try { await opfsWriteJson(OPFS_MARKER, m); m.opfsWritten = true; } catch (_) {}
  if (db) {
    await idbPut(db, "marker", m).catch(() => {});
    const h = (await idbGet(db, "history").catch(() => null)) || [];
    h.push({ bootId: R.bootId, t: m.t, ctx: R.executionContext, displayMode: R.displayMode,
             sameSession: R.sameBrowsingSession, net: R.networkReachable, opfsWritten: m.opfsWritten });
    await idbPut(db, "history", h.slice(-20)).catch(() => {});
    R.runHistory = h.slice(-20);
  }
}

/* ---------- test hors ligne ---------- */
async function evaluateOffline(db) {
  const prep = db ? await idbGet(db, "offlinePrep").catch(() => null) : null;
  const off = { status: "NOT_TESTED", prepared: !!prep, networkReachableNow: R.networkReachable, detail: "" };
  if (!prep) { off.detail = "Test non préparé : bouton « Préparer le test hors ligne »."; return off; }
  off.preparedAt = prep.t; off.preparedIn = prep.ctx;
  if (prep.result) { Object.assign(off, prep.result); off.detail = "Résultat enregistré lors d'un lancement précédent."; return off; }
  if (R.networkReachable) { off.status = "PENDING"; off.detail = "Préparé. Coupe le réseau (mode avion), ferme puis rouvre la sonde."; return off; }
  // Hors ligne et la page s'est chargée : vérifier l'état local.
  const idbOk = !!(prep && prep.token);
  let opfsOk = null, opfsErr = null;
  if (prep.opfs) {
    try { const o = await opfsReadJson(OPFS_OFFLINE); opfsOk = !!(o && o.token === prep.token); }
    catch (e) { opfsOk = false; opfsErr = Object.assign(errObj(e), opfsContext()); }
  }
  const pageFromCache = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  off.pageStartedOffline = true; off.controlledByServiceWorker = pageFromCache;
  off.idbMarker = idbOk ? "PRESENT" : "MISSING";
  off.opfsMarker = prep.opfs ? (opfsOk ? "PRESENT" : "MISSING") : "NOT_APPLICABLE";
  if (opfsErr) off.opfsError = opfsErr;
  off.status = pageFromCache && idbOk && (opfsOk !== false) ? "PASS" : "FAIL";
  off.detail = "Lancement hors ligne vérifié le " + new Date().toISOString() + " en contexte " + R.executionContext + ".";
  prep.result = { status: off.status, pageStartedOffline: true, controlledByServiceWorker: pageFromCache,
                  idbMarker: off.idbMarker, opfsMarker: off.opfsMarker, verifiedAt: new Date().toISOString(), verifiedIn: R.executionContext };
  await idbPut(db, "offlinePrep", prep).catch(() => {});
  return off;
}
async function prepareOffline() {
  const msg = $("offline-msg");
  try {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { msg.textContent = "Impossible : la page n'est pas contrôlée par le service worker. Recharge la page puis réessaie."; return; }
    if (R.serviceWorker.cacheMissing && R.serviceWorker.cacheMissing.length) { msg.textContent = "Cache incomplet : " + R.serviceWorker.cacheMissing.join(", ") + ". Recharge la page en ligne."; return; }
    const db = await idbOpen(); const token = rid(); let opfs = false;
    try { await opfsWriteJson(OPFS_OFFLINE, { token, t: new Date().toISOString() }); opfs = true; } catch (_) {}
    await idbPut(db, "offlinePrep", { token, t: new Date().toISOString(), ctx: R.executionContext, opfs });
    R.offline = { status: "PENDING", prepared: true, detail: "Préparé. Coupe le réseau (mode avion), ferme puis rouvre la sonde." };
    msg.textContent = "Préparé. Active le mode avion, ferme complètement la sonde, puis rouvre-la depuis la même icône ou le même onglet.";
    render();
  } catch (e) { msg.textContent = "Échec de la préparation : " + e.name + " — " + e.message; }
}

/* ---------- audio ---------- */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return (t ^ t >>> 14) >>> 0; }; }
function expected() { const g = mulberry32(SEED), x = new Int16Array(N); for (let i = 0; i < N; i++) x[i] = ((g() >>> 16) - 32768) >> 2; return x; }
function wav(x, sr) {
  const buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, x[i], true); return buf;
}
function cmp(decoded, exp) {
  const ch = decoded.getChannelData(0);
  if (ch.length !== exp.length) return { status: "FAIL", bitExact: false, samples: ch.length, maxDiffLsb: null };
  let m = 0; for (let i = 0; i < exp.length; i++) { const d = Math.abs(Math.round(ch[i] * 32768) - exp[i]); if (d > m) m = d; }
  return { status: m === 0 ? "PASS" : "FAIL", bitExact: m === 0, samples: ch.length, maxDiffLsb: m };
}
async function audioTests() {
  const exp = expected();
  try {
    const ctx = new AudioContext(); await ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0; o.connect(g).connect(ctx.destination); o.start();
    await new Promise((r) => setTimeout(r, 400)); o.stop();
    R.audioRate = ctx.sampleRate;
    R.baseLatency = typeof ctx.baseLatency === "number" ? +(ctx.baseLatency * 1000).toFixed(1) : null;
    R.outputLatency = typeof ctx.outputLatency === "number" ? +(ctx.outputLatency * 1000).toFixed(1) : null;
    await ctx.close();
  } catch (e) { R.errors.push({ test: "audioDefault", ...errObj(e) }); }
  let c48;
  try { c48 = new AudioContext({ sampleRate: 48000 }); R.ctx48 = { status: c48.sampleRate === 48000 ? "PASS" : "FAIL", sampleRate: c48.sampleRate }; }
  catch (e) { R.ctx48 = { status: "FAIL", ...errObj(e) }; }
  if (!c48) return;
  try { R.wav = cmp(await c48.decodeAudioData(wav(exp, 48000)), exp); } catch (e) { R.wav = { status: "FAIL", ...errObj(e) }; }
  let flacBuf = null;
  try { flacBuf = await (await fetch("fixture-48k.flac")).arrayBuffer(); R.flac = cmp(await c48.decodeAudioData(flacBuf.slice(0)), exp); }
  catch (e) { R.flac = { status: "FAIL", ...errObj(e) }; }
  try {
    const b = await (await fetch("fixture-44k1.flac")).arrayBuffer(); const d = await c48.decodeAudioData(b);
    const c = cmp(d, exp); R.flac441 = { status: "INFO", resampled: !c.bitExact, samples: d.length };
  } catch (e) { R.flac441 = { status: "FAIL", ...errObj(e) }; }
  if (flacBuf) {
    try { const t0 = performance.now(); for (let i = 0; i < 20; i++) await c48.decodeAudioData(flacBuf.slice(0));
      const ms = (performance.now() - t0) / 20; R.speed = { status: ms < 30 ? "PASS" : "WARN", msPerDecode: +ms.toFixed(2), est280StimuliS: +(ms * 280 / 1000).toFixed(2) }; }
    catch (e) { R.speed = { status: "FAIL", ...errObj(e) }; }
  }
  try { await c48.close(); } catch (_) {}
}

/* ---------- stockage (actif) ---------- */
async function storageTests() {
  // IndexedDB écriture/lecture 512 Ko
  try {
    const db = await idbOpen(); const data = new Uint8Array(512 * 1024).map((_, i) => i & 255);
    await idbDo(db, "blob", "readwrite", (s) => s.put(data, "k"));
    const back = await idbDo(db, "blob", "readonly", (s) => s.get("k"));
    const ok = !!back && back.length === data.length && back[1000] === data[1000] && back[data.length - 1] === data[data.length - 1];
    R.idb = { status: ok ? "PASS" : "FAIL", bytes: data.length };
  } catch (e) { R.idb = { status: "FAIL", ...errObj(e) }; }
  // OPFS disponibilité puis écriture/lecture 1 Mo
  const ctx = opfsContext();
  const available = !!(navigator.storage && typeof navigator.storage.getDirectory === "function");
  try {
    const root = await opfsRoot();
    const fh = await root.getFileHandle("vs1-test.bin", { create: true }); const w = await fh.createWritable();
    const data = new Uint8Array(1024 * 1024).map((_, i) => (i * 7) & 255); await w.write(data); await w.close();
    const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    let ok = buf.length === data.length; for (let i = 0; ok && i < buf.length; i += 4099) ok = buf[i] === data[i];
    R.opfs = { status: ok ? "PASS" : "FAIL", available, createWriteRead: ok ? "PASS" : "FAIL", bytes: data.length };
  } catch (e) { R.opfs = { status: "FAIL", available, createWriteRead: "FAIL", error: errObj(e), context: ctx }; }
  // Persistance : trois valeurs séparées
  try { R.persistedBefore = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { R.errors.push({ test: "persistedBefore", ...errObj(e) }); }
  try { R.persistRequestResult = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch (e) { R.errors.push({ test: "persist", ...errObj(e) }); }
  try { R.persistedAfter = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { R.errors.push({ test: "persistedAfter", ...errObj(e) }); }
  try { const est = await navigator.storage.estimate(); R.quota = Math.round((est.quota || 0) / 1048576); R.usage = +((est.usage || 0) / 1048576).toFixed(1); }
  catch (e) { R.errors.push({ test: "estimate", ...errObj(e) }); }
}

/* ---------- classement (règles du micro-gate §8) ---------- */
function classifyStorage() {
  const authoritative = ["HTTPS_BROWSER_TAB", "INSTALLED_PWA"].includes(R.executionContext);
  const red = []; const pending = [];
  const opfsOk = R.opfs.status === "PASS"; const idbOk = R.idb.status === "PASS";
  if (R.opfs.status === "FAIL") red.push("OPFS indisponible ou inutilisable");
  if (R.idb.status === "FAIL") red.push("IndexedDB inutilisable");
  for (const [k, m] of [["IndexedDB", R.idbMarker], ["OPFS", R.opfsMarker]]) {
    if (m.acrossReload === "FAIL" || m.acrossRestart === "FAIL") red.push(`Marqueur ${k} perdu`);
  }
  if (R.offline.status === "FAIL") red.push("PWA hors ligne sans accès à l'état local");
  if (R.quota !== null && R.quota < VS1_MIN_QUOTA_MB) red.push(`Quota ${R.quota} Mo < ${VS1_MIN_QUOTA_MB} Mo`);
  if (R.opfsMarker.acrossReload === "NOT_TESTED") pending.push("persistance OPFS au rechargement");
  if (R.opfsMarker.acrossRestart === "NOT_TESTED") pending.push("persistance OPFS au redémarrage");
  if (R.executionContext === "INSTALLED_PWA" && R.offline.status !== "PASS" && R.offline.status !== "FAIL") pending.push("relance hors ligne");
  if (R.opfs.status === "NOT_TESTED") pending.push("tests actifs (bouton « Lancer »)");
  const verdict = !authoritative ? "DIAGNOSTIC_ONLY" : red.length ? "RED" : pending.length ? "INCOMPLETE" : "GREEN";
  R.classification = {
    authorityForPwaTarget: authoritative ? "YES" : "NO",
    OPFS_FUNCTIONAL: opfsOk ? "YES" : (R.opfs.status === "NOT_TESTED" ? "NOT_TESTED" : "NO"),
    IDB_FUNCTIONAL: idbOk ? "YES" : (R.idb.status === "NOT_TESTED" ? "NOT_TESTED" : "NO"),
    DURABILITY_GUARANTEE: R.persistedAfter === true ? "PERSISTENT" : (R.persistedAfter === false ? "BEST_EFFORT" : "UNKNOWN"),
    QUOTA_SUFFICIENT_FOR_VS1: R.quota === null ? "UNKNOWN" : (R.quota >= VS1_MIN_QUOTA_MB ? "YES" : "NO"),
    STORAGE_ARCHITECTURE: verdict, redReasons: red, pending
  };
}

/* ---------- affichage ---------- */
const PILL = (s) => `<span class="pill ${esc(String(s).replace(/[^A-Z_]/g, ""))}">${esc(s)}</span>`;
function kv(rows) { return rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join(""); }
function st(x) { return x && x.status ? x.status : "NOT_TESTED"; }
function render() {
  classifyStorage();
  const c = R.classification;
  $("ctx-class").textContent = R.executionContext;
  $("ctx-class").className = "ctx-class " + (c.authorityForPwaTarget === "YES" ? "auth" : "diag");
  $("ctx-authority").textContent = c.authorityForPwaTarget === "YES" ? "Contexte faisant autorité pour la cible PWA" : "Diagnostic seulement : ne fait pas autorité pour la PWA";
  $("ctx").innerHTML = kv([
    ["href", `<span class="mono">${esc(R.href)}</span>`], ["origin", `<span class="mono">${esc(R.origin)}</span>`],
    ["protocol", esc(R.protocol)], ["isSecureContext", esc(R.secure)], ["display-mode", esc(R.displayMode)],
    ["navigator.standalone", esc(R.navigatorStandalone === null ? "absent" : R.navigatorStandalone)],
    ["referrer", esc(R.referrer || "(vide)")],
    ["service worker", esc(R.serviceWorker.controlledAtLoad ? "contrôlait la page au chargement" : "ne contrôlait pas la page au chargement")],
    ["navigation", esc(`${R.navigationType} · ${R.sameBrowsingSession ? "même session (rechargement)" : "nouvelle session de navigation"}`)],
    ["réseau", esc(R.networkReachable ? "joignable" : "injoignable (hors ligne)")],
    ["preuves", esc(R.executionEvidence.join(" · "))], ["userAgent", `<span class="mono">${esc(R.ua)}</span>`]
  ]);
  $("verdict").innerHTML = kv([
    ["STORAGE_ARCHITECTURE", PILL(c.STORAGE_ARCHITECTURE)], ["OPFS_FUNCTIONAL", PILL(c.OPFS_FUNCTIONAL)],
    ["IDB_FUNCTIONAL", PILL(c.IDB_FUNCTIONAL)], ["DURABILITY_GUARANTEE", PILL(c.DURABILITY_GUARANTEE)],
    ["QUOTA_SUFFICIENT_FOR_VS1", PILL(c.QUOTA_SUFFICIENT_FOR_VS1)], ["SERVICE_WORKER", PILL(st(R.serviceWorker))],
    ["OFFLINE_RELOAD", PILL(st(R.offline))],
    ["Motifs RED", esc(c.redReasons.join(" ; ") || "aucun")], ["En attente", esc(c.pending.join(" ; ") || "rien")]
  ]);
  const opfsErr = R.opfs.error ? ` · ${esc(R.opfs.error.name)} : ${esc(R.opfs.error.message)}` : "";
  $("storage").innerHTML = kv([
    ["IndexedDB écriture/lecture 512 Ko", PILL(st(R.idb)) + (R.idb.message ? " " + esc(R.idb.message) : "")],
    ["Marqueur IndexedDB · rechargement", PILL(R.idbMarker.acrossReload || "NOT_TESTED")],
    ["Marqueur IndexedDB · redémarrage", PILL(R.idbMarker.acrossRestart || "NOT_TESTED")],
    ["OPFS disponible (API)", esc(R.opfs.available === undefined ? "non testé" : R.opfs.available)],
    ["OPFS création/écriture/lecture 1 Mo", PILL(R.opfs.createWriteRead || st(R.opfs)) + opfsErr],
    ["Marqueur OPFS · rechargement", PILL(R.opfsMarker.acrossReload || "NOT_TESTED") + (R.opfsMarker.error ? " " + esc(R.opfsMarker.error.name + " : " + R.opfsMarker.error.message) : "")],
    ["Marqueur OPFS · redémarrage", PILL(R.opfsMarker.acrossRestart || "NOT_TESTED") + (R.opfsMarker.note ? " " + esc(R.opfsMarker.note) : "")],
    ["PERSISTED_BEFORE", esc(R.persistedBefore)], ["PERSIST_REQUEST_RESULT", esc(R.persistRequestResult)],
    ["PERSISTED_AFTER", esc(R.persistedAfter)],
    ["Quota / utilisé", esc(R.quota === null ? "non testé" : `${R.quota} Mo / ${R.usage} Mo`)]
  ]);
  const sw = R.serviceWorker;
  $("sw").innerHTML = kv([
    ["Enregistré", esc(sw.registered)], ["Activé", esc(sw.activated)], ["Page contrôlée", esc(sw.controlled)],
    ["Cache", esc(sw.cacheName || "—") + (sw.cacheMissing ? esc(sw.cacheMissing.length ? " · manquants : " + sw.cacheMissing.join(", ") : " · complet") : "")],
    ["Erreur", esc(sw.error ? sw.error.name + " : " + sw.error.message : "aucune")],
    ["Test hors ligne", PILL(st(R.offline)) + " " + esc(R.offline.detail || "")]
  ]);
  const lat = R.outputLatency;
  $("audio").innerHTML = kv([
    ["Fréquence par défaut", esc(R.audioRate === null ? "non testé" : R.audioRate + " Hz")],
    ["Contexte forcé 48 kHz", R.ctx48 ? PILL(R.ctx48.status) + " " + esc(R.ctx48.sampleRate || R.ctx48.message || "") : PILL("NOT_TESTED")],
    ["baseLatency / outputLatency", esc(lat === null ? "non testé" : `${R.baseLatency} ms / ${lat} ms${lat > 60 ? " · > 60 ms : RT non fiables" : ""}`)],
    ["WAV 16 bits 48 kHz bit à bit", R.wav ? PILL(R.wav.status) + " " + esc(R.wav.maxDiffLsb !== undefined && R.wav.maxDiffLsb !== null ? `écart max ${R.wav.maxDiffLsb} LSB` : (R.wav.message || "")) : PILL("NOT_TESTED")],
    ["FLAC 48 kHz bit à bit", R.flac ? PILL(R.flac.status) + " " + esc(R.flac.maxDiffLsb !== undefined && R.flac.maxDiffLsb !== null ? `écart max ${R.flac.maxDiffLsb} LSB` : (R.flac.message || "")) : PILL("NOT_TESTED")],
    ["FLAC 44,1 kHz → contexte 48 kHz", R.flac441 ? esc(R.flac441.resampled ? `rééchantillonné (${R.flac441.samples} échantillons)` : (R.flac441.message || "identique")) : PILL("NOT_TESTED")],
    ["Décodage FLAC 0,25 s", R.speed ? PILL(R.speed.status) + " " + esc(R.speed.msPerDecode !== undefined ? `${R.speed.msPerDecode} ms · 280 stimuli ≈ ${R.speed.est280StimuliS} s` : (R.speed.message || "")) : PILL("NOT_TESTED")]
  ]);
  $("json").textContent = JSON.stringify(R, null, 1);
}

/* ---------- démarrage ---------- */
async function boot() {
  let prev = null; try { prev = sessionStorage.getItem("vs1-boot"); } catch (_) {}
  R.sameBrowsingSession = !!prev; R.bootId = prev || rid();
  try { sessionStorage.setItem("vs1-boot", R.bootId); } catch (_) {}
  const nav = performance.getEntriesByType("navigation")[0]; R.navigationType = nav ? nav.type : "unknown";
  R.displayMode = displayMode(); [R.executionContext, R.executionEvidence] = classify();
  R.serviceWorker.controlledAtLoad = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  render();
  R.networkReachable = await networkReachable();
  let db = null; try { db = await idbOpen(); } catch (e) { R.errors.push({ test: "idbOpen", ...errObj(e) }); }
  await checkMarkers(db);
  R.offline = await evaluateOffline(db);
  await writeMarkers(db);
  render();
  const sw = await setupServiceWorker(); sw.controlledAtLoad = R.serviceWorker.controlledAtLoad; R.serviceWorker = sw;
  render();
  $("status").textContent = "Contexte et marqueurs lus. Appuie sur « Lancer les tests » pour le stockage actif et l'audio.";
  $("run").disabled = false; $("prep").disabled = false; $("copy").disabled = false;
}
async function run() {
  $("run").disabled = true; $("status").textContent = "Tests en cours…";
  await storageTests(); await audioTests(); R.when = new Date().toISOString(); render();
  $("run").disabled = false; $("run").textContent = "Relancer les tests";
  $("status").textContent = "Terminé. Copie le rapport JSON et colle-le dans la conversation.";
}
async function copyReport() {
  const t = JSON.stringify(R);
  try { await navigator.clipboard.writeText(t); $("status").textContent = "Rapport copié dans le presse-papiers."; }
  catch (_) { const r = document.createRange(); r.selectNodeContents($("json")); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    $("status").textContent = "Copie refusée : le rapport est sélectionné, copie-le manuellement."; }
}
async function resetProbe() {
  const b = $("reset");
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirmer l'effacement"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Effacer les données de la sonde"; }, 4000); return; }
  try { indexedDB.deleteDatabase(DB_NAME); } catch (_) {}
  try { const root = await opfsRoot(); for (const n of [OPFS_MARKER, OPFS_OFFLINE, "vs1-test.bin"]) await root.removeEntry(n).catch(() => {}); } catch (_) {}
  try { sessionStorage.removeItem("vs1-boot"); } catch (_) {}
  $("status").textContent = "Données de la sonde effacées (le service worker reste installé). Recharge la page.";
  b.dataset.armed = ""; b.textContent = "Effacer les données de la sonde";
}

window.addEventListener("DOMContentLoaded", () => {
  $("run").addEventListener("click", run); $("prep").addEventListener("click", prepareOffline);
  $("copy").addEventListener("click", copyReport); $("reset").addEventListener("click", resetProbe);
  boot().catch((e) => { R.errors.push({ test: "boot", ...errObj(e) }); render(); $("status").textContent = "Erreur au démarrage : " + e.message; $("copy").disabled = false; });
  window.__R = R;
});
