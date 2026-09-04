/*
 * Minimal service worker: makes the app installable and keeps the shell usable
 * offline. Forecast requests always go to the network — a stale forecast is
 * worse than no forecast.
 */
const CACHE = 'whiff-v3';
// Note the absence of './index.html': many static hosts (including `serve`)
// answer it with a 301 to './', and the Cache API refuses to store a redirected
// response. Listing both meant addAll rejected and the worker never installed.
const SHELL = [
  './',
  './styles.css',
  './src/app.js',
  './src/model.js',
  './src/weather.js',
  './src/share.js',
  './src/units.js',
  './src/share-config.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  // Cache each file independently. addAll() is all-or-nothing, so one 404 or
  // one redirect anywhere in SHELL would leave the app with no offline support
  // at all — and fail silently, since nothing in the page observes it.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const results = await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? SHELL[i] : null))
      .filter(Boolean);
    if (failed.length) console.warn('Whiff SW: could not cache', failed);
    await self.skipWaiting();
  })());
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
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./'))),
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
