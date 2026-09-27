/* Sonde PWA VS1 — service worker minimal : précache + cache d'abord, rien d'autre. */
const CACHE = "aal-vs1-probe-v2.0.0";
const ASSETS = ["./", "index.html", "probe.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "fixture-48k.flac", "fixture-44k1.flac"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Sonde réseau : jamais servie depuis le cache.
  if (new URL(req.url).pathname.endsWith("/__netcheck")) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Navigation (start_url avec ?source=pwa) → index.html en cache.
    const hit = req.mode === "navigate"
      ? (await cache.match("index.html")) || (await cache.match("./"))
      : await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});

self.addEventListener("message", async (e) => {
  if (e.data === "cache-status") {
    const cache = await caches.open(CACHE);
    const missing = [];
    for (const a of ASSETS) if (!(await cache.match(a))) missing.push(a);
    e.source.postMessage({ type: "cache-status", cache: CACHE, missing });
  }
});
