/*
 * Minimal service worker: makes the app installable and keeps the shell usable
 * offline. Forecast requests always go to the network — a stale forecast is
 * worse than no forecast.
 */
const CACHE = 'whiff-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './src/app.js',
  './src/model.js',
  './src/weather.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // APIs and tiles: network only
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});

/* Web Push, if you ever wire up a push server with VAPID keys. */
self.addEventListener('push', (e) => {
  let data = { title: '👃 Whiff', body: 'Mill odor likely tonight.' };
  try { data = { ...data, ...e.data.json() }; } catch { /* plain-text payload */ }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: 'whiff' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('./index.html'));
});
