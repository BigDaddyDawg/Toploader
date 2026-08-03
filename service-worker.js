const CACHE_NAME = "toploader-static-v7";
const CORE_ASSETS = [
  "./",
  "index.html",
  "wishlist.html",
  "buy-list.html",
  "helper.html",
  "floors.json",
  "manifest.webmanifest",
  "icon.svg",
  "supabase-config.js",
  "show-sync.js",
];

/** Network-first with offline fallback — keeps HTML/JS fresh after publishes. */
function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      return response;
    })
    .catch(() =>
      caches.match(request).then(cached => cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined))
    );
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return;

  const path = url.pathname;

  if (path.endsWith("/") || path.endsWith("/index.html")) {
    event.respondWith(networkFirst(event.request, "index.html"));
    return;
  }

  if (path.endsWith("/floors.json")) {
    event.respondWith(networkFirst(event.request, "floors.json"));
    return;
  }

  if (
    path.endsWith("/show-sync.js") ||
    path.endsWith("/supabase-config.js") ||
    path.endsWith("/service-worker.js")
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
