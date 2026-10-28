// Ouvre la page instantanément même sans réseau. La page elle-même est toujours demandée au réseau
// d'abord ; le cache ne sert qu'en secours, et seulement des réponses directes (jamais de redirection,
// que Safari refuse d'afficher quand elles viennent d'un service worker).
const CACHE = "telecommande-v8";
const FILES = ["index.html", "app.js", "mqtt.min.js", "gcm.min.js", "local.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

const usable = (res) => res && res.ok && !res.redirected && res.type === "basic";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (cache) => {
    for (const f of FILES) {
      try {
        const res = await fetch(f, { cache: "no-store" });
        if (usable(res)) await cache.put(f, res);
      } catch (err) {}
    }
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = e.request.mode === "navigate" ? "index.html" : url.pathname.replace(/^\//, "");
  e.respondWith(fetch(e.request).then((res) => {
    if (usable(res)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  }).catch(async () => (await caches.match(key)) || Response.error()));
});
