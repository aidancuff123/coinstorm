// App-shell service worker. Bump VERSION whenever a shell file changes.
const VERSION = "coinstorm-v2";
const SHELL = [
  "/", "/app.css", "/app.js", "/vendor/chart.umd.min.js", "/manifest.webmanifest",
  "/icons/apple-touch-icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Stale-while-revalidate: serve the cached shell instantly, refresh it in the background.
  const key = e.request.mode === "navigate" ? "/" : e.request;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(key);
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
