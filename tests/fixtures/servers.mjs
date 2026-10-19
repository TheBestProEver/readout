// Local servers for the v2 browser test.
//   appServer({ isolate }): Readout itself; isolate adds the COOP/COEP headers sw.js gives on
//     GitHub Pages (so a test can skip the service worker), without it the server is like Pages.
//     files: { '/url/path': file } served instead (looked up per request, so a test can put the
//     next release in place); ctl.gate(req, path): a promise to wait for before answering (a
//     slow or silent network), or null.
//   modelServer(): a second origin standing in for Hugging Face and jsDelivr, with local copies
//     of the voice models, onnxruntime-web, espeak and pdf.js / Tesseract. Range requests work
//     (voice downloads resume). Paths follow readkit's tests/fixtures/voice/server.mjs, which is
//     the layout Readout's ?local=<this server> override expects.
// The local copies are found only through environment variables (no paths in the repo):
//   READKIT_SCRATCH  readkit's research scratch folder (layout in readkit's PROTOTYPES.md)
//   READKIT_ASSETS   local pdf.js / Tesseract copies (default READKIT_SCRATCH/dl)
// Missing copies: the matching test sections skip, and pdf.js / Tesseract come from jsDelivr.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../browser.mjs';

const dir = (v) => (v ? path.resolve(v) : null);
const SCRATCH = dir(process.env.READKIT_SCRATCH);
const ASSETS = dir(process.env.READKIT_ASSETS) || (SCRATCH && path.join(SCRATCH, 'dl'));
const sub = (base, ...parts) => (base ? path.join(base, ...parts) : null);
const exists = (p) => !!p && fs.existsSync(p);

const KOKORO_VOICES = sub(SCRATCH, 'tts', 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'resolve', 'main', 'voices');
const LOCAL = {
  ort: sub(SCRATCH, 'tts', 'lib', 'ort130'),
  phonemizer: sub(SCRATCH, 'tts', 'lib', 'phonemizer.js'),
  piperph: [sub(SCRATCH, 'tts', 'lib', 'piper'), sub(SCRATCH, 'voice-dl', 'pw')].filter(Boolean),
  kokoroModel: sub(SCRATCH, 'arch', 'models', 'ts_model.onnx'),
  piper: sub(SCRATCH, 'tts', 'models', 'diffusionstudio', 'piper-voices', 'resolve', 'main'),
  pdfjs: sub(ASSETS, 'pdfjs-dist-5.6.205', 'package'),
  tess: sub(ASSETS, 'tesseract.js-7.0.0', 'package', 'dist'),
  core: sub(ASSETS, 'tesseract.js-core-7.0.0', 'package'),
  lang: path.join(os.tmpdir(), 'readkit-test-cache'),
};

export const have = {
  ort: exists(sub(LOCAL.ort, 'ort.webgpu.min.mjs')) && exists(sub(LOCAL.ort, 'ort.wasm.min.mjs')),
  ryan: exists(sub(LOCAL.piper, 'en', 'en_US', 'ryan', 'medium', 'en_US-ryan-medium.onnx')),
  michael: exists(LOCAL.kokoroModel) && exists(sub(KOKORO_VOICES, 'am_michael.bin')),
  pdfjs: exists(LOCAL.pdfjs),
  tess: exists(LOCAL.tess) && exists(LOCAL.core) && exists(path.join(LOCAL.lang, 'eng.traineddata.gz')),
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf' };

function under(root, rest) {
  if (!root) return null;
  const f = path.join(root, rest);
  return f.startsWith(root) ? f : null;
}

// Sends a file, with HTTP Range.
function sendFile(req, res, file, headers) {
  const size = fs.statSync(file).size;
  const h = Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }, headers);
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    start = +m[1];
    if (m[2]) end = Math.min(+m[2], size - 1);
    if (start >= size) {
      res.writeHead(416, Object.assign(h, { 'Content-Range': `bytes */${size}` }));
      return res.end();
    }
    status = 206;
    h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  h['Content-Length'] = end - start + 1;
  res.writeHead(status, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

function listen(server) {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      r({
        server,
        base,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            if (server.closeAllConnections) server.closeAllConnections();
          }),
      });
    })
  );
}

// files: { '/url/path': absolute file path } served in place (the user's private documents, which
// are never copied).
export function appServer({ isolate = false, files = {} } = {}) {
  const log = [];
  const ctl = { gate: null };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    log.push({ method: req.method, path: p, at: Date.now() });
    const gate = ctl.gate && ctl.gate(req, p);
    if (gate) gate.then(() => answer(req, res, p));
    else answer(req, res, p);
  });
  function answer(req, res, p) {
    const headers = isolate ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'same-origin' } : {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // like GitHub Pages: only the service worker can take the share sheet's POST
      res.writeHead(405, headers);
      return res.end();
    }
    const file = files[p] || (p === '/' ? path.join(ROOT, 'index.html') : under(ROOT, p));
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, headers);
      return res.end();
    }
    sendFile(req, res, file, headers);
  }
  return listen(server).then((s) => Object.assign(s, { log, ctl }));
}

// ctl.gate as for appServer (a download held part way, say).
export function modelServer() {
  const log = [];
  const ctl = { gate: null };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    log.push({ path: p, range: req.headers.range || null });
    const gate = ctl.gate && ctl.gate(req, p);
    if (gate) gate.then(() => answer(req, res, p));
    else answer(req, res, p);
  });
  function answer(req, res, p) {
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign(h, { 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD' }));
      return res.end();
    }
    let file = null;
    if (p.startsWith('/ort/')) file = under(LOCAL.ort, p.slice(5));
    else if (p === '/phonemizer.js') file = LOCAL.phonemizer;
    else if (p.startsWith('/piperph/')) file = LOCAL.piperph.map((d) => under(d, p.slice(9))).find((f) => f && fs.existsSync(f)) || null;
    else if (p === '/kokoro/onnx/model.onnx') file = LOCAL.kokoroModel;
    else if (p.startsWith('/kokoro/voices/')) file = under(KOKORO_VOICES, p.slice(15));
    else if (p.startsWith('/piper/')) file = under(LOCAL.piper, p.slice(7));
    else if (p.startsWith('/_pdfjs/')) file = under(LOCAL.pdfjs, p.slice(8));
    else if (p.startsWith('/_tess/')) file = under(LOCAL.tess, p.slice(7));
    else if (p.startsWith('/_core/')) file = under(LOCAL.core, p.slice(7));
    else if (p.startsWith('/_lang/')) file = under(LOCAL.lang, p.slice(7));
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, h);
      return res.end();
    }
    sendFile(req, res, file, h);
  }
  return listen(server).then((s) => Object.assign(s, { log, ctl }));
}

// READOUT_CONFIG.readkit overrides for local pdf.js / Tesseract copies on the model server.
export function assetConfig(base) {
  const cfg = {};
  if (have.pdfjs) cfg.pdfjs = base + '/_pdfjs/';
  if (have.tess) cfg.tesseract = { script: base + '/_tess/tesseract.min.js', worker: base + '/_tess/worker.min.js', core: base + '/_core', lang: base + '/_lang' };
  return cfg;
}
