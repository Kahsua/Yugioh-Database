// Minimaler Service Worker – notwendig, damit Chrome/Edge die Seite als
// installierbare App erkennt. Cached nur die statische Oberfläche (HTML/CSS/JS),
// NICHT die Kartendaten (die kommen live von Supabase/YGOPRODeck und sollen
// immer aktuell sein).

const CACHE_NAME = "kartenarchiv-shell-v3";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first für alles: Immer versuchen, aktuelle Version zu laden.
// Nur wenn gar keine Verbindung besteht, auf den Cache zurückfallen
// (z.B. damit die App-Hülle auch offline kurz startet).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
