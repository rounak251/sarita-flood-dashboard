/*
 * Bandh-Mitra service worker.
 * - Caches the app shell (everything under this scope) with stale-while-revalidate, so an update shows on the next open.
 * - Stretch list (../data/bandh/stretches.geojson) is outside this scope; the page keeps its own copy in localStorage.
 * - Never intercepts /api/ (uploads go through queue.js from the page or from the sync event below).
 * - Background retry: the page registers the "patrol-flush" sync tag after each save; the sync event flushes the outbox
 *   even when the app is closed (Chromium). Elsewhere the page flushes on the "online" event and on a timer.
 */
importScripts("queue.js");

var CACHE = "bandh-patrol-v1";
var SHELL = [
  "./",
  "index.html",
  "app.css",
  "strings.js",
  "app.js",
  "queue.js",
  "manifest.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function staleWhileRevalidate(req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") !== -1) return;          // API: always network, never cached
  if (url.href.indexOf(self.registration.scope) !== 0) return;
  event.respondWith(
    staleWhileRevalidate(req).then(function (res) {
      if (res) return res;
      if (req.mode === "navigate") return caches.match("index.html");
      return Response.error();
    })
  );
});

self.addEventListener("sync", function (event) {
  if (event.tag === "patrol-flush") {
    event.waitUntil(BandhQueue.flush());
  }
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "flush") {
    event.waitUntil(BandhQueue.flush());
  }
});
