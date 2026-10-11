// Service worker: keeps the writer available offline and publishes queued posts
// when the phone gets signal again (Background Sync), even if the app is closed.
/* global importScripts, Publisher */
importScripts("db.js", "publish.js");

const CACHE = "writer-v1"; // bump when any file below changes
const FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "db.js",
  "publish.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Offline first for the app's own files; everything else (GitHub API) goes straight to the network
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(new URL("./", location).pathname)) {
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "publish") return;
  event.waitUntil(
    Publisher.publishQueued(broadcast).then(async (published) => {
      for (const d of published) {
        if (self.Notification && Notification.permission === "granted") {
          await self.registration.showNotification("Post published", {
            body: `${d.title} is live (give it a minute to appear).`,
            icon: "icon-192.png",
            data: { url: d.url },
          });
        }
      }
    })
    // A rejection here (still offline) tells Android to try again later
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.notification.data && event.notification.data.url) {
    event.waitUntil(self.clients.openWindow(event.notification.data.url));
  }
});

async function broadcast(draft) {
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.postMessage({ type: "draft-updated", id: draft.id }));
}
