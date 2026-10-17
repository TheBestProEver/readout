// Makes the lab cross-origin isolated on static hosts that cannot send headers (GitHub
// Pages): every same-origin response the lab gets (pages, scripts, workers, the library
// under ../src) is given
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: credentialless
// so SharedArrayBuffer, and with it multi-threaded WASM (Piper), is available. A
// controlled page's requests all pass through here, including those of the workers it
// starts, whatever their URL. Cross-origin requests (models, CDN libraries) are left alone:
// they load under credentialless rules. The page registers this worker and reloads once
// when it is not yet controlled (lab/index.html).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  // only-if-cached may only be used with same-origin mode (a DevTools quirk)
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(
    fetch(req).then((res) => {
      // opaque or error responses cannot be rewritten; pass them on
      if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
