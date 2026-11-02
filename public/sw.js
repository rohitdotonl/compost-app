// Minimal service worker: makes the app installable and lets the shell open
// without a connection. The API is never cached, so data is always fresh.
// Bump CACHE whenever a file is added to SHELL or the shell changes shape.
const CACHE = 'compost-v11';
const SHELL = [
  '/', '/save', '/style.css', '/strings.js', '/api.js', '/app.js', '/save.js',
  '/store.js', '/format.js', '/rack.js', '/vault.js', '/heap.js',
  '/keys.js', '/palette.js', '/palette.css', '/search.js', '/export.js', '/zip.js',
  '/shelf.js', '/shelf.css', '/library.css', '/pages.css', '/guide.js', '/guide.css',
  '/daily.js', '/daily.css',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/fonts/literata-latin-wght-normal.woff2', '/fonts/literata-latin-wght-italic.woff2',
  '/fonts/ibm-plex-sans-latin-400-normal.woff2', '/fonts/ibm-plex-sans-latin-400-italic.woff2',
  '/fonts/ibm-plex-sans-latin-500-normal.woff2',
  // Phase 4: reader
  '/reader.js', '/reader.css', '/extract.js', '/vendor/Readability.js', '/vendor/purify.es.mjs',
  // Phase 5: reading tools
  '/highlights.js', '/highlights.css', '/finish.js', '/finish.css',
  // Phase 8: nudges
  '/notify.js', '/notify.css',
];

// Phase 4: article images come through the same-origin /img proxy and are
// kept for offline reading, cache first, at most IMG_LIMIT of them (oldest
// out first). Article text lives in 'compost-content', written by reader.js.
// Both survive a CACHE bump.
const IMG_CACHE = 'compost-img';
const IMG_LIMIT = 400;
// Phase 8: 'compost-push' holds what the push handler needs (notify.js).
const KEEP = [IMG_CACHE, 'compost-content', 'compost-push'];

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname !== '/img') return;
  event.respondWith(
    caches.open(IMG_CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) {
        await cache.put(event.request, res.clone());
        trimImages(cache);
      }
      return res;
    }).catch(() => Response.error())
  );
});

async function trimImages(cache) {
  const keys = await cache.keys();
  for (const request of keys.slice(0, Math.max(0, keys.length - IMG_LIMIT))) await cache.delete(request);
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, cache as the fallback.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/img') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname).then((hit) => hit || Response.error()))
  );
});

// Phase 8: the daily reminder. The push carries no data; the words come from
// GET /api/digest, with the passcode and fallback words notify.js left in
// the 'compost-push' cache. Chrome wants a notification for every push, so a
// failed fetch still shows the gentle fallback.
self.addEventListener('push', (event) => {
  event.waitUntil(showReminder());
});

async function showReminder() {
  let stored = {};
  try {
    const hit = await caches.open('compost-push').then((c) => c.match('/__compost/push'));
    if (hit) stored = await hit.json();
  } catch {}
  let body = stored.fallback || '';
  try {
    const res = await fetch('/api/digest', { headers: { 'X-Passcode': stored.passcode || '' } });
    if (res.ok) body = (await res.json()).text || body;
  } catch {}
  return self.registration.showNotification(stored.title || 'Compost', {
    body,
    icon: '/icons/icon-192.png',
    tag: 'compost-daily',
    data: { url: '/' },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === location.origin);
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
