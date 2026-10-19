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
 * - One readkit version at a time (KIT_VERSION, the same as in app.js): the page asks for it
 *   ('kit-version' message) before it loads readkit, and waits for this worker's successor
 *   when it was made for another one (app.js kitSource()).
 */
const VERSION = 'v6';
const KIT_VERSION = '0.2.0-42d3dde-6f0f2260';
const SHELL_CACHE = `readout-shell-${VERSION}`;
const KIT_CACHE = `readout-kit-${KIT_VERSION}`;
const RUNTIME_CACHE = 'readout-runtime';
const SHARE_CACHE = 'readout-share';
const SHELL = [
  './',
  'index.html',
  'styles.css?v=5',
  'core.js?v=5',
  'app.js?v=5',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
// A page start waits this long for the network before the kept copy of the app opens (a
// connection that is up but carries nothing, like one bar of signal, can take minutes to fail).
const NAV_TIMEOUT = 3000;
// tools/readkit-files.mjs writes this list: [file, fingerprint] for readkit/*.js, src/**, data/**.
const KIT = [
  // readkit files: begin
  ["readkit/data/g2p/hetero.json","9086dced2b31e21f"],
  ["readkit/data/g2p/lex-gb.txt","e1e45aec1b3bdc36"],
  ["readkit/data/g2p/lex-us.txt","2d2fe33298e0a11f"],
  ["readkit/data/g2p/pos-gb.json","4ff5cd4c7a416f27"],
  ["readkit/data/g2p/pos-us.json","2a6081b3357ed8ad"],
  ["readkit/data/g2p/tags.txt","94938d7e6098ad87"],
  ["readkit/data/lang/bigrams-en.txt","57b82bacbdfcf742"],
  ["readkit/data/lang/words-en.txt","e86746baa02afc74"],
  ["readkit/data/speech/abbreviations.js","bf8a86250d5dd5ea"],
  ["readkit/data/speech/acronyms.js","5f6f210079626cff"],
  ["readkit/data/speech/roman.js","77e548e186a23d53"],
  ["readkit/data/speech/symbols.js","89b1e84d8cbb939e"],
  ["readkit/data/speech/units.js","789c4d99b77f22a5"],
  ["readkit/index.js","d803ab2f1b553f52"],
  ["readkit/player.js","5a86644dac9f9aea"],
  ["readkit/src/audio/clipstore.js","979c6dba15348717"],
  ["readkit/src/audio/keepalive.js","fde91f24c99a1224"],
  ["readkit/src/audio/ogg.js","0f0996e48d8e1caa"],
  ["readkit/src/audio/opus.js","155244bc49a8fd88"],
  ["readkit/src/audio/player.js","5ca9f14792bb9593"],
  ["readkit/src/audio/session.js","52b20c260a664f4c"],
  ["readkit/src/audio/timeline.js","88e4f3b8f7f9bd69"],
  ["readkit/src/audio/webm.js","e7f7cf66de86da99"],
  ["readkit/src/calendar/calendar.js","017132d85f2a4705"],
  ["readkit/src/calendar/civil.js","1acd31619fefb66d"],
  ["readkit/src/calendar/entities.js","f285745cba21b862"],
  ["readkit/src/calendar/events.js","aeb883639e2104cc"],
  ["readkit/src/calendar/ics.js","9ce324917eda9c83"],
  ["readkit/src/calendar/schema.js","0ffb97bfd8fe754a"],
  ["readkit/src/calendar/tz.js","d65c580f6013f653"],
  ["readkit/src/config.js","d9c8ffa769cfe540"],
  ["readkit/src/doc.js","94f407b1022c3052"],
  ["readkit/src/extract.js","c749b4ced319d913"],
  ["readkit/src/formats/docx.js","db7ebed3debe451a"],
  ["readkit/src/formats/dom.js","ed95aff3c0c6c1ac"],
  ["readkit/src/formats/epub.js","8668598c6364ca63"],
  ["readkit/src/formats/html.js","9ff6b1c1503058b7"],
  ["readkit/src/formats/markdown.js","23a38d229be31d09"],
  ["readkit/src/formats/mime.js","d20998b11f2fe5dd"],
  ["readkit/src/formats/odf.js","a44840eab291437b"],
  ["readkit/src/formats/opc.js","dfe7d7a05216c903"],
  ["readkit/src/formats/pptx.js","04e63f7ed50b73c8"],
  ["readkit/src/formats/rtf.js","ae0f8f68a3a69dac"],
  ["readkit/src/formats/sha256.js","85906b47ec0546a5"],
  ["readkit/src/formats/text.js","436b1bb850eac9b8"],
  ["readkit/src/formats/util.js","96182fe744c02a96"],
  ["readkit/src/formats/xml.js","e54f97fb694770ea"],
  ["readkit/src/formats/zip.js","8bc2fc65d1bb307d"],
  ["readkit/src/g2p/data.js","ab17a24968911b7c"],
  ["readkit/src/g2p/espeak.js","bf5307273e98e456"],
  ["readkit/src/g2p/g2p.js","7d778c6e5d9057d1"],
  ["readkit/src/g2p/hetero.js","8f01d139a0cae6ea"],
  ["readkit/src/g2p/lexicon.js","4a4845bdd158223e"],
  ["readkit/src/g2p/numbers.js","9457b6ceb4c8abe7"],
  ["readkit/src/g2p/packed.js","8871318c68ed0df6"],
  ["readkit/src/g2p/phonemes.js","2b11f80d5269e3cc"],
  ["readkit/src/g2p/tagger.js","8b42ff36b206063f"],
  ["readkit/src/g2p/tokenize.js","d2dac2255bea0d0a"],
  ["readkit/src/lang/bigrams.js","ebab6724b5285b77"],
  ["readkit/src/lang/correct.js","5ecaa83da64a84ff"],
  ["readkit/src/lang/correct.worker.js","65968a586ac824a2"],
  ["readkit/src/lang/corrector.js","626b2e633d586188"],
  ["readkit/src/lang/period.js","7de9d21b9318252a"],
  ["readkit/src/lang/symspell.js","dceb505080f7bc09"],
  ["readkit/src/lang/tokens.js","2f605251a0d4bce6"],
  ["readkit/src/lang/words.js","272cd1c3028504ce"],
  ["readkit/src/layout/layout.js","7cebfcc0b5a26790"],
  ["readkit/src/layout/surface.js","429bd60eef7f7f61"],
  ["readkit/src/ocr/layout.js","e00160516ed958e8"],
  ["readkit/src/ocr/ocr.js","064506bc73ed2e9a"],
  ["readkit/src/ocr/pre.js","f03af78708ae6077"],
  ["readkit/src/ocr/pre.worker.js","51cfc24a9f27d8ac"],
  ["readkit/src/ocr/prep.js","1029c2b9c112e0d8"],
  ["readkit/src/pdf/fuse.js","00bc9fe6becf1b84"],
  ["readkit/src/pdf/layout.js","cd22a53f347d87d3"],
  ["readkit/src/pdf/ocrpage.js","c198bc7d2a6fc00f"],
  ["readkit/src/pdf/ops.js","b3ddbddd563d27e5"],
  ["readkit/src/pdf/pdf.js","e2c501b8d128352e"],
  ["readkit/src/pdf/pdfjs.js","22d67a92f61c5f8c"],
  ["readkit/src/pdf/quality.js","c0a661aaa3e00743"],
  ["readkit/src/pdf/render.js","a3c817425cfadaf0"],
  ["readkit/src/pdf/scan.js","90bb309d069d5b54"],
  ["readkit/src/sniff.js","5207760db7a53736"],
  ["readkit/src/speech/clean.js","24801c54172787ab"],
  ["readkit/src/speech/junk.js","4327442eac00da0c"],
  ["readkit/src/speech/numbers.js","f4ed697e27357e00"],
  ["readkit/src/speech/plan.js","4a69e0afbae47dbe"],
  ["readkit/src/speech/rules/abbr.js","bdd3d96ec613bc82"],
  ["readkit/src/speech/rules/caps.js","047f84d21c39f503"],
  ["readkit/src/speech/rules/dates.js","89d397c05b67399a"],
  ["readkit/src/speech/rules/measure.js","e42ebf41074b8167"],
  ["readkit/src/speech/rules/money.js","8c53e277403ff6c1"],
  ["readkit/src/speech/rules/num.js","368ba71b2c3a20c6"],
  ["readkit/src/speech/rules/phone.js","afe782ec1ef00150"],
  ["readkit/src/speech/rules/roman.js","6fbee7a0223b32b2"],
  ["readkit/src/speech/rules/skip.js","dbbe3baa1ac91e3f"],
  ["readkit/src/speech/rules/symbols.js","6ae92230fe9ee9bd"],
  ["readkit/src/speech/rules/util.js","c376f0de56f8b6d0"],
  ["readkit/src/speech/rules/web.js","484d1fe0a6c31373"],
  ["readkit/src/speech/split.js","de553633c60f46eb"],
  ["readkit/src/speech/tracked.js","9c66d64bb8e26520"],
  ["readkit/src/speech/verbalize.js","337263feb9347230"],
  ["readkit/src/voice/calibrate.js","9bb3943a4ef1047d"],
  ["readkit/src/voice/catalog.js","ea9be1d28670bfd2"],
  ["readkit/src/voice/espeak.js","2e587679b49cf49d"],
  ["readkit/src/voice/kokoro-text.js","c32c85f6c9694ae9"],
  ["readkit/src/voice/kokoro.worker.js","5f0412edcd37dbda"],
  ["readkit/src/voice/opfs.js","a08084d10b85b112"],
  ["readkit/src/voice/pcm.js","f9c1d6bee3adc195"],
  ["readkit/src/voice/piper-text.js","0ca00681e9f8d468"],
  ["readkit/src/voice/piper.worker.js","b10d3cd1d96891a4"],
  ["readkit/src/voice/sha256.js","4f295166c77dbb31"],
  ["readkit/src/voice/store.js","c81177a925d9c383"],
  ["readkit/src/voice/store.worker.js","b56510b7c75a1670"],
  ["readkit/src/voice/system.js","9634de15623fe7e3"],
  ["readkit/src/voice/voice.js","ae34a376d6ec995a"],
  ["readkit/src/voice/words.js","e045fe6ae3eb5771"],
  ["readkit/src/voice/worker-util.js","5af3e077c64cfe87"],
  ["readkit/src/worker.js","f83eb0a02eeef48b"],
  ["readkit/voice.js","ef042db9a5b1ac03"],
  // readkit files: end
];
const CDN_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net']);

const scopeUrl = () => new URL(self.registration.scope);
const here = (rel) => new URL(rel, self.registration.scope).href;
let kitPrints = null;
// readkit file URL (no query) -> its fingerprint
const kitPrint = (url) => (kitPrints || (kitPrints = new Map(KIT.map(([p, h]) => [here(p), h])))).get(url.split(/[?#]/)[0]);

// The same as tools/readkit-files.mjs fingerprint(): SHA-256 with CRLF read as LF, 16 hex digits.
async function fingerprint(buf) {
  const b = new Uint8Array(buf);
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) if (!(b[i] === 13 && b[i + 1] === 10)) out[n++] = b[i];
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(0, n)));
  let s = '';
  for (let i = 0; i < 8; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}

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
      // readkit's files change only with readkit, so a release keeps the copies it has, and a
      // new readkit takes the files it shares with the one kept before (most of its 11 MB is
      // data that rarely changes) from that copy. Only a file with the expected content is kept.
      const kit = await caches.open(KIT_CACHE);
      const have = new Set((await kit.keys()).map((r) => r.url));
      const older = await Promise.all((await caches.keys()).filter((k) => k.startsWith('readout-kit-') && k !== KIT_CACHE).map((k) => caches.open(k)));
      const todo = KIT.filter(([p]) => !have.has(here(p)));
      for (let i = 0; i < todo.length; i += 8) await Promise.allSettled(todo.slice(i, i + 8).map(([p, h]) => keepKitFile(kit, older, p, h)));
      await self.skipWaiting();
    })()
  );
});

async function keepKitFile(kit, older, p, print) {
  for (const c of older) {
    const r = await c.match(p, { ignoreSearch: true });
    if (r && r.ok && (await fingerprint(await r.clone().arrayBuffer())) === print) return kit.put(p, r);
  }
  const res = await fetch(new Request(p, { cache: 'reload' }));
  // (a host still serving another release's copy, say: the file is fetched when it's used)
  if (res.ok && (await fingerprint(await res.clone().arrayBuffer())) === print) await kit.put(p, res);
}

// The page asks which readkit this worker serves before loading it (app.js kitSource()).
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'kit-version' && event.ports && event.ports[0]) event.ports[0].postMessage({ kit: KIT_VERSION, version: VERSION });
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
      event.respondWith(kitFile(req, event).then(isolated));
      return;
    }
    if (req.mode === 'navigate') event.respondWith(networkFirst(req, event).then(isolated));
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

// Pages: try the network so updates arrive, fall back to the cached app offline, or when the
// network has sent nothing after NAV_TIMEOUT (the fetch goes on, so the next start is up to
// date). Only the app's own page is kept as './' (not a file in scope opened as a page, like
// the manifest).
async function networkFirst(req, event) {
  const path = new URL(req.url).pathname;
  const app = path === scopeUrl().pathname || path === scopeUrl().pathname + 'index.html';
  let kept = null;
  const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res && res.ok && !res.redirected && app && /text\/html/i.test(res.headers.get('Content-Type') || '')) {
      const copy = res.clone();
      kept = caches.open(SHELL_CACHE).then((c) => c.put('./', copy));
    }
    return res;
  });
  // (kept alive past a timed-out start, until the page has come and is kept)
  event.waitUntil(network.then(() => kept, () => {}).catch(() => {}));
  const cache = await caches.open(SHELL_CACHE);
  const cached = async () => (await cache.match('./')) || (await cache.match('index.html'));
  if (app) {
    const copy = await cached();
    if (copy) {
      let timer;
      const late = new Promise((r) => (timer = setTimeout(r, NAV_TIMEOUT, null)));
      const res = await Promise.race([network.catch(() => null), late]);
      clearTimeout(timer);
      return res || copy;
    }
  }
  try {
    return await network;
  } catch (e) {
    return (await cached()) || Response.error();
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

// readkit's runtime files: the copy kept for this readkit version, else the network (kept
// when it is this version's file).
async function kitFile(req, event) {
  const cache = await caches.open(KIT_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    const print = kitPrint(req.url);
    if (res && res.ok && print && !new URL(req.url).search) {
      const look = res.clone();
      const keep = res.clone();
      event.waitUntil(
        look
          .arrayBuffer()
          .then(fingerprint)
          .then((h) => (h === print ? cache.put(req, keep) : keep.body && keep.body.cancel()))
          .catch(() => {})
      );
    }
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
