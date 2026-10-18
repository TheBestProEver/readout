/*
 * Readout service worker. Bump VERSION (and the ?v= numbers in index.html) on each release.
 * - Offline: the app shell and readkit's runtime files are kept in versioned caches; the
 *   libraries from jsDelivr and Google Fonts are kept after their first use.
 * - Cross-origin isolation on a static host (GitHub Pages sends no headers): every
 *   same-origin response (pages, scripts, workers, cache hits) gets COOP same-origin and
 *   COEP credentialless, so SharedArrayBuffer and multi-threaded WASM (the Standard voice)
 *   work. The page reloads once when it isn't controlled yet (app.js).
 * - Android share sheet: shared files and text arrive here as a POST (manifest
 *   share_target), are kept in Cache Storage, and the app opens them from ./?shared=1.
 */
const VERSION = 'v5';
const KIT_VERSION = '0.1.0-7a48887';
const SHELL_CACHE = `readout-shell-${VERSION}`;
const KIT_CACHE = `readout-kit-${KIT_VERSION}`;
const RUNTIME_CACHE = 'readout-runtime';
const SHARE_CACHE = 'readout-share';
const SHELL = [
  './',
  'index.html',
  'styles.css?v=4',
  'core.js?v=4',
  'app.js?v=4',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
// tools/readkit-files.mjs writes this list (readkit/index.js, src/**, data/**).
const KIT = [
  // readkit files: begin
  "readkit/data/g2p/hetero.json",
  "readkit/data/g2p/lex-gb.txt",
  "readkit/data/g2p/lex-us.txt",
  "readkit/data/g2p/pos-gb.json",
  "readkit/data/g2p/pos-us.json",
  "readkit/data/g2p/tags.txt",
  "readkit/data/lang/bigrams-en.txt",
  "readkit/data/lang/words-en.txt",
  "readkit/data/speech/abbreviations.js",
  "readkit/data/speech/acronyms.js",
  "readkit/data/speech/roman.js",
  "readkit/data/speech/symbols.js",
  "readkit/data/speech/units.js",
  "readkit/index.js",
  "readkit/src/audio/clipstore.js",
  "readkit/src/audio/keepalive.js",
  "readkit/src/audio/ogg.js",
  "readkit/src/audio/opus.js",
  "readkit/src/audio/player.js",
  "readkit/src/audio/session.js",
  "readkit/src/audio/timeline.js",
  "readkit/src/audio/webm.js",
  "readkit/src/config.js",
  "readkit/src/doc.js",
  "readkit/src/extract.js",
  "readkit/src/formats/docx.js",
  "readkit/src/formats/dom.js",
  "readkit/src/formats/epub.js",
  "readkit/src/formats/html.js",
  "readkit/src/formats/markdown.js",
  "readkit/src/formats/mime.js",
  "readkit/src/formats/odf.js",
  "readkit/src/formats/opc.js",
  "readkit/src/formats/pptx.js",
  "readkit/src/formats/rtf.js",
  "readkit/src/formats/sha256.js",
  "readkit/src/formats/text.js",
  "readkit/src/formats/util.js",
  "readkit/src/formats/xml.js",
  "readkit/src/formats/zip.js",
  "readkit/src/g2p/data.js",
  "readkit/src/g2p/espeak.js",
  "readkit/src/g2p/g2p.js",
  "readkit/src/g2p/hetero.js",
  "readkit/src/g2p/lexicon.js",
  "readkit/src/g2p/numbers.js",
  "readkit/src/g2p/packed.js",
  "readkit/src/g2p/phonemes.js",
  "readkit/src/g2p/tagger.js",
  "readkit/src/g2p/tokenize.js",
  "readkit/src/lang/bigrams.js",
  "readkit/src/lang/correct.js",
  "readkit/src/lang/correct.worker.js",
  "readkit/src/lang/corrector.js",
  "readkit/src/lang/period.js",
  "readkit/src/lang/symspell.js",
  "readkit/src/lang/tokens.js",
  "readkit/src/lang/words.js",
  "readkit/src/ocr/layout.js",
  "readkit/src/ocr/ocr.js",
  "readkit/src/ocr/pre.js",
  "readkit/src/ocr/pre.worker.js",
  "readkit/src/ocr/prep.js",
  "readkit/src/pdf/fuse.js",
  "readkit/src/pdf/layout.js",
  "readkit/src/pdf/ocrpage.js",
  "readkit/src/pdf/ops.js",
  "readkit/src/pdf/pdf.js",
  "readkit/src/pdf/pdfjs.js",
  "readkit/src/pdf/quality.js",
  "readkit/src/pdf/render.js",
  "readkit/src/pdf/scan.js",
  "readkit/src/sniff.js",
  "readkit/src/speech/clean.js",
  "readkit/src/speech/junk.js",
  "readkit/src/speech/numbers.js",
  "readkit/src/speech/plan.js",
  "readkit/src/speech/rules/abbr.js",
  "readkit/src/speech/rules/caps.js",
  "readkit/src/speech/rules/dates.js",
  "readkit/src/speech/rules/measure.js",
  "readkit/src/speech/rules/money.js",
  "readkit/src/speech/rules/num.js",
  "readkit/src/speech/rules/phone.js",
  "readkit/src/speech/rules/roman.js",
  "readkit/src/speech/rules/skip.js",
  "readkit/src/speech/rules/symbols.js",
  "readkit/src/speech/rules/util.js",
  "readkit/src/speech/rules/web.js",
  "readkit/src/speech/split.js",
  "readkit/src/speech/tracked.js",
  "readkit/src/speech/verbalize.js",
  "readkit/src/voice/calibrate.js",
  "readkit/src/voice/catalog.js",
  "readkit/src/voice/espeak.js",
  "readkit/src/voice/kokoro-text.js",
  "readkit/src/voice/kokoro.worker.js",
  "readkit/src/voice/opfs.js",
  "readkit/src/voice/pcm.js",
  "readkit/src/voice/piper-text.js",
  "readkit/src/voice/piper.worker.js",
  "readkit/src/voice/sha256.js",
  "readkit/src/voice/store.js",
  "readkit/src/voice/store.worker.js",
  "readkit/src/voice/system.js",
  "readkit/src/voice/voice.js",
  "readkit/src/voice/words.js",
  "readkit/src/voice/worker-util.js",
  "readkit/src/worker.js",
  // readkit files: end
];
const CDN_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net']);

const scopeUrl = () => new URL(self.registration.scope);
const here = (rel) => new URL(rel, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Each file on its own, so one missing file can't block the install.
      const shell = await caches.open(SHELL_CACHE);
      await Promise.allSettled(
        SHELL.map(async (p) => {
          const res = await fetch(new Request(p, { cache: 'reload' }));
          if (res.ok) await shell.put(p, res);
        })
      );
      // readkit's files change only with readkit, so a release keeps the copies it has.
      const kit = await caches.open(KIT_CACHE);
      const have = new Set((await kit.keys()).map((r) => r.url));
      const todo = KIT.filter((p) => !have.has(here(p)));
      for (let i = 0; i < todo.length; i += 8) {
        await Promise.allSettled(
          todo.slice(i, i + 8).map(async (p) => {
            const res = await fetch(new Request(p, { cache: 'reload' }));
            if (res.ok) await kit.put(p, res);
          })
        );
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const old = (k) => (k.startsWith('readout-shell-') && k !== SHELL_CACHE) || (k.startsWith('readout-kit-') && k !== KIT_CACHE);
      await Promise.all(keys.filter(old).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const scope = scopeUrl();
  if (url.origin === self.location.origin) {
    if (req.method === 'POST' && url.pathname === scope.pathname + 'share-target') {
      event.respondWith(receiveShare(req));
      return;
    }
    if (req.method !== 'GET') return;
    // only-if-cached may only be used with same-origin mode (a DevTools quirk)
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    const kitPath = scope.pathname + 'readkit/';
    if (url.pathname.startsWith(kitPath)) {
      // readkit's own pages (lab, demo) have their own service worker and are not the app.
      if (/^(?:lab|demo)(?:\/|$)/.test(url.pathname.slice(kitPath.length))) return;
      event.respondWith(kitFile(req).then(isolated));
      return;
    }
    if (req.mode === 'navigate') event.respondWith(networkFirst(req).then(isolated));
    else event.respondWith(staleWhileRevalidate(req, event).then(isolated));
    return;
  }
  if (req.method === 'GET' && CDN_HOSTS.has(url.hostname)) event.respondWith(cacheFirst(req));
});

// The same response with the cross-origin isolation headers added.
function isolated(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect' || res.type === 'error') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Pages: try the network so updates arrive, fall back to the cached app offline. Only the
// app's own page is kept as './' (not a file in scope opened as a page, like the manifest).
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    const path = new URL(req.url).pathname;
    const app = path === scopeUrl().pathname || path === scopeUrl().pathname + 'index.html';
    if (res && res.ok && !res.redirected && app && /text\/html/i.test(res.headers.get('Content-Type') || '')) cache.put('./', res.clone());
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

// readkit's runtime files: the copy kept for this readkit version, else the network.
async function kitFile(req) {
  const cache = await caches.open(KIT_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && !new URL(req.url).search) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}

// Libraries and fonts from jsDelivr and Google: pinned URLs, so the first copy is kept.
// A stylesheet or script asked for without CORS is fetched with CORS (both hosts allow
// it), so the page can use it under COEP and the cache never holds an opaque response.
async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  try {
    const res = req.mode === 'no-cors' ? await fetch(req.url, { mode: 'cors', credentials: 'omit' }) : await fetch(req);
    if (res && res.ok) cache.put(req.url, res.clone());
    return res;
  } catch (e) {
    try {
      return await fetch(req); // a host that refuses CORS after all
    } catch (e2) {
      return Response.error();
    }
  }
}

/* ---------- Android share sheet ---------- */

// Keeps what was shared (files, title, text, url) for the app, then opens it.
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);
    const meta = { title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || ''), files: [], at: Date.now() };
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = here(`shared/file-${i}`);
      await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      meta.files.push({ key, name: f.name || `Shared file ${i + 1}`, type: f.type || '' });
    }
    await cache.put(here('shared/meta.json'), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    /* nothing usable was shared; the app says so */
  }
  return Response.redirect(here('./?shared=1'), 303);
}
