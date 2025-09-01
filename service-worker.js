// service-worker.js — cache dasar untuk shell offline
const CACHE = "presensi-fupa-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./karyawan.html",
  "./admin.html",
  "./app.js",
  "./manifest.webmanifest",
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap",
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:FILL,GRAD@1,200"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Network first untuk HTML, cache first untuk lainnya
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(m => m || caches.match("./index.html")))
    );
  } else {
    e.respondWith(
      caches.match(req).then(m => m || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
  }
});