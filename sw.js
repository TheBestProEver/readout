/* Readout service worker: works offline after the first visit. Bump VERSION on each release. */
const VERSION = 'v4';
const SHELL_CACHE = `readout-shell-${VERSION}`;
const RUNTIME_CACHE = 'readout-runtime';
const SHELL = [
  './',
  'index.html',
  'styles.css?v=3',
  'core.js?v=3',
  'app.js?v=3',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const CDN_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Cache each file on its own so one missing file can't block the install.
      await Promise.allSettled(
        SHELL.map(async (path) => {
          const res = await fetch(new Request(path, { cache: 'reload' }));
          if (res.ok) await cache.put(path, res);
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('readout-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // readkit's own pages (lab, demo) have their own service worker and are not the app shell.
    if (url.pathname.startsWith(new URL('readkit/', self.registration.scope).pathname)) return;
    if (req.mode === 'navigate') event.respondWith(networkFirst(req));
    else event.respondWith(staleWhileRevalidate(req, event));
    return;
  }
  if (CDN_HOSTS.has(url.hostname)) event.respondWith(cacheFirst(req));
});

// Pages: try the network so updates arrive, fall back to the cached app offline.
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (res && res.ok) cache.put('./', res.clone());
    return res;
  } catch (e) {
    return (await cache.match('./')) || (await cache.match('index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}
