// OCR with Tesseract.js 7 (LSTM, eng best_int) in its own worker.
//   createOcr({ signal, onProgress }) -> Ocr
//   Ocr.recognize(image, { kind, signal }) -> { text, lines, words, conf, method }
//   Ocr.terminate()
//   ocrImage(blob, { dialect, allowOcr, signal, onProgress }) -> { title, blocks, warnings, stats }
// Each image goes through a retry ladder: the 'auto' preprocessed image with
// Sauvola thresholding, then the plain image with Otsu (light text on dark
// slides), then automatic rotation (skew over ~5 degrees). The first result that
// is clearly good is kept; otherwise the one with the most dictionary words and
// the least junk wins. Preprocessing also maps where the letters are, so text
// Tesseract's page layout skipped is found and read again (fillGaps). Margin notes
// read into body lines are cut out (layout.splitLines) and kept as their own
// paragraphs. Boxes are in the input image's pixels. Tesseract's own promises
// never settle when its files fail to download or its worker dies, so every step
// has a stall timer and rejects.

import { config } from '../config.js';
import { loadWords } from '../lang/words.js';
import { core, isKnown, isNumberish, isCode } from '../lang/tokens.js';
import { createCorrector } from '../lang/correct.js';
import { layoutParagraphs, splitLines, headingLevel, skewOf, BULLET, median } from './layout.js';
import { createPrep } from './prep.js';
import { toPGM } from './pre.js';
import { moduleWorker } from '../worker.js';

// What the first use downloads: Tesseract core + worker + English model, and the
// correction word pairs (the word list is shared with the PDF reader).
export const OCR_BYTES = 6.8e6;

const SETUP_STALL_MS = 60000; // no download progress for this long: give up
const RECOGNIZE_STALL_MS = 180000; // no recognition progress for this long: give up

let libPromise = null;
function loadTesseract() {
  if (!libPromise) {
    // The UMD build sets self.Tesseract when imported as a module; the ESM build
    // has a default export. Either way it works in pages and module workers.
    libPromise = import(config.tesseract.script)
      .then((m) => {
        const T = m && m.default && m.default.createWorker ? m.default : globalThis.Tesseract;
        if (!T || !T.createWorker) throw new Error('Tesseract did not load');
        return T;
      })
      .catch((e) => {
        libPromise = null;
        throw new Error("Couldn't load the OCR engine" + (e && e.message ? ': ' + e.message : ''));
      });
  }
  return libPromise;
}

const abortError = () => new DOMException('The operation was aborted', 'AbortError');
const isAbort = (e) => e && e.name === 'AbortError';

// Runs start(alive, fail) and settles with it, or rejects on fail(), on abort, or
// when alive() hasn't been called for stallMs.
function guarded(start, { signal, stallMs, what }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const onAbort = () => fail(abortError());
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const fail = (e) => {
      const err = e instanceof Error || (e && e.name === 'AbortError') ? e : new Error(String((e && e.message) || e));
      finish(reject, err);
    };
    const alive = () => {
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error(`${what} stalled`);
        err.name = 'StallError';
        fail(err);
      }, stallMs);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    alive();
    Promise.resolve()
      .then(() => start(alive, fail))
      .then((v) => finish(resolve, v), fail);
  });
}

// The model gets its own IndexedDB cache key: Tesseract keys its cache by
// cachePath only, so two models sharing one would silently reuse each other.
const cachePathFor = (langPath) => 'readkit-' + String(langPath).replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(-80);

/* ---------- preprocessing channel (worker when possible) ---------- */

function prepChannel() {
  let inline = null;
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const useInline = () => inline || (inline = createPrep());
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
      worker = moduleWorker(new URL('./pre.worker.js', import.meta.url));
      worker.onmessage = ({ data }) => {
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
      };
      worker.onerror = (ev) => {
        ev.preventDefault();
        const err = new Error('worker failed');
        err.name = 'WorkerError';
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        worker.terminate();
        worker = null;
      };
    } catch (e) {
      worker = null;
    }
  }
  const call = (msg, transfer) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg }, transfer || []);
    });
  let mode = null; // 'worker' | 'inline' for the open image
  return {
    async open(source, kind) {
      if (worker) {
        try {
          let payload = source;
          const transfer = [];
          if (!(source instanceof Blob)) {
            payload = await createImageBitmap(source); // a copy: the caller keeps theirs
            transfer.push(payload);
          }
          const r = await call({ op: 'open', source: payload, kind }, transfer);
          mode = 'worker';
          return r;
        } catch (e) {
          if (e.name !== 'WorkerError') throw e;
          // the module worker can't run here: do it on this thread
        }
      }
      mode = 'inline';
      return useInline().open(source, { kind });
    },
    prep(piece, pass) {
      return mode === 'worker' ? call({ op: 'prep', piece, mode: pass }) : Promise.resolve(useInline().prep(piece, pass));
    },
    async close() {
      if (mode === 'worker' && worker) await call({ op: 'close' }).catch(() => {});
      else if (inline) inline.close();
      mode = null;
    },
    terminate() {
      if (worker) worker.terminate();
      worker = null;
      if (inline) inline.close();
      for (const p of pending.values()) p.reject(abortError());
      pending.clear();
    },
  };
}

/* ---------- reading Tesseract's output ---------- */

// Maps a point Tesseract reports back into the image it was given. With
// rotateAuto it deskews the whole image about its centre (same size) before
// reading, so its boxes are in the turned frame.
export function unrotate(angle, w, h) {
  if (!angle) return null;
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const cx = w / 2;
  const cy = h / 2;
  return (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}

// Tesseract blocks -> lines and words in source-image pixels. The image was
// `piece` (working px = source px x scale, offset by x0, y0 in source px).
export function parse(data, piece) {
  const k = 1 / piece.scale;
  const dx = piece.x0 || 0;
  const dy = piece.y0 || 0;
  const turn = unrotate(data.rotateRadians || 0, piece.w, piece.h);
  const box = (b) => {
    if (!turn) return { x0: b.x0 * k + dx, y0: b.y0 * k + dy, x1: b.x1 * k + dx, y1: b.y1 * k + dy };
    const pts = [turn(b.x0, b.y0), turn(b.x1, b.y0), turn(b.x0, b.y1), turn(b.x1, b.y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.max(0, Math.min(...xs)) * k + dx, y0: Math.max(0, Math.min(...ys)) * k + dy, x1: Math.min(piece.w, Math.max(...xs)) * k + dx, y1: Math.min(piece.h, Math.max(...ys)) * k + dy };
  };
  // baselines keep their direction (the layout reads the skew from them)
  const line = (b) => {
    if (!turn) return box(b);
    const [x0, y0] = turn(b.x0, b.y0);
    const [x1, y1] = turn(b.x1, b.y1);
    return { x0: x0 * k + dx, y0: y0 * k + dy, x1: x1 * k + dx, y1: y1 * k + dy };
  };
  const lines = [];
  const words = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const ws = (l.words || []).filter((w) => w.text && w.text.trim());
        if (!ws.length) continue;
        const li = lines.length;
        const size = l.rowAttributes && l.rowAttributes.rowHeight > 0 ? l.rowAttributes.rowHeight : l.bbox.y1 - l.bbox.y0;
        lines.push({
          text: ws.map((w) => w.text.trim()).join(' '),
          conf: l.confidence / 100,
          bbox: box(l.bbox),
          baseline: l.baseline && l.baseline.x1 > l.baseline.x0 ? line(l.baseline) : null,
          size: size * k,
        });
        for (const w of ws) words.push({ text: w.text.trim(), conf: w.confidence / 100, bbox: box(w.bbox), line: li });
      }
    }
  }
  return { lines, words };
}

// Letter boxes (flat x0, y0, x1, y1 in source px, from preprocessing) that no
// word box covers: text Tesseract skipped. On noisy photos its page layout
// sometimes drops whole paragraphs as "pictures".
export function uncovered(text, words) {
  const n = text.length >> 2;
  if (n < 30) return { total: n, missed: [], cell: 0 };
  const hs = new Float32Array(n);
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < n; i++) {
    hs[i] = text[i * 4 + 3] - text[i * 4 + 1];
    if (text[i * 4 + 2] > maxX) maxX = text[i * 4 + 2];
    if (text[i * 4 + 3] > maxY) maxY = text[i * 4 + 3];
  }
  hs.sort();
  const cell = Math.max(4, hs[n >> 1]);
  const gw = Math.ceil(maxX / cell) + 2;
  const gh = Math.ceil(maxY / cell) + 2;
  const grid = new Uint8Array(gw * gh);
  const pad = 0.3 * cell;
  const at = (v, max) => Math.min(max - 1, Math.max(0, Math.floor(v / cell)));
  for (const w of words) {
    const x0 = at(w.bbox.x0 - pad, gw);
    const x1 = at(w.bbox.x1 + pad, gw);
    const y0 = at(w.bbox.y0 - pad, gh);
    const y1 = at(w.bbox.y1 + pad, gh);
    for (let y = y0; y <= y1; y++) grid.fill(1, y * gw + x0, y * gw + x1 + 1);
  }
  const missed = [];
  for (let i = 0; i < n; i++) {
    const cx = (text[i * 4] + text[i * 4 + 2]) / 2;
    const cy = (text[i * 4 + 1] + text[i * 4 + 3]) / 2;
    if (!grid[at(cy, gh) * gw + at(cx, gw)]) missed.push(i);
  }
  return { total: n, missed, cell };
}

// How believable a result is: dictionary words count for it, junk against it.
// Numbers and codes are neutral, and so are names (they appear in every rung).
// coverage: share of the letters preprocessing found that some word covers.
export function judge(words, dict, text = null) {
  let good = 0;
  let junk = 0;
  let n = 0;
  let conf = 0;
  for (const w of words) {
    const c = core(w.text).w;
    n++;
    conf += w.conf;
    if (!c) {
      junk++;
      continue;
    }
    if (isNumberish(c) || isCode(c) || /^[aAI]$/.test(c)) continue;
    if (/^\p{L}[\p{L}'’-]*$/u.test(c) && isKnown(dict, c)) good++;
    else if (!/^\p{Lu}\p{Ll}+$/u.test(c)) junk++;
  }
  const u = text ? uncovered(text, words) : { total: 0, missed: [] };
  const coverage = u.total >= 30 ? 1 - u.missed.length / u.total : 1;
  return { good, junk, score: good - 2 * junk, quality: good / Math.max(1, good + junk), conf: n ? conf / n : 0, words: n, coverage };
}
const clearlyGood = (j) => j.words >= 3 && j.quality >= 0.9 && j.conf >= 0.75 && j.coverage >= 0.9;

// The retry ladder. Each later rung only runs when the best result so far is weak.
const LADDER = [
  { mode: 'auto', opts: {}, name: 'auto+sauvola' },
  // light text on dark or busy backgrounds (slides), where Sauvola breaks glyphs
  { mode: 'raw', opts: { thresholding_method: '0' }, name: 'raw+otsu' },
  // skew over a few degrees
  { mode: 'auto', opts: { rotateAuto: true }, name: 'auto+rotate' },
];
const SKEWED = (1.5 * Math.PI) / 180;
function worthTrying(rung, best, skew) {
  // Tesseract ignores tiny angles, so rotating a straight page repeats the first pass.
  if (rung.opts.rotateAuto) return Math.abs(skew) >= SKEWED || (best.judge.words >= 8 && best.judge.quality < 0.5);
  return true;
}

/* ---------- reading what the page layout skipped ---------- */

// Regions of skipped text: the uncovered letters grouped (cells one letter high,
// joined across word gaps and line gaps), each grown over the lines it touches
// so those lines are read again whole. -> [{ x0, y0, x1, y1, lines: Set }] (source px)
export function gapRegions(res, text) {
  const u = uncovered(text, res.words);
  if (u.missed.length < Math.max(12, 0.04 * u.total)) return [];
  const cell = u.cell;
  let maxX = 0;
  let maxY = 0;
  for (const i of u.missed) {
    maxX = Math.max(maxX, text[i * 4 + 2]);
    maxY = Math.max(maxY, text[i * 4 + 3]);
  }
  const gw = Math.ceil(maxX / cell) + 1;
  const gh = Math.ceil(maxY / cell) + 1;
  const mark = new Uint8Array(gw * gh);
  const cellOf = (i) => {
    const cx = Math.floor((text[i * 4] + text[i * 4 + 2]) / 2 / cell);
    const cy = Math.floor((text[i * 4 + 1] + text[i * 4 + 3]) / 2 / cell);
    return Math.min(gh - 1, cy) * gw + Math.min(gw - 1, cx);
  };
  for (const i of u.missed) {
    const c = cellOf(i);
    const x = c % gw;
    const y = (c / gw) | 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(gw - 1, x + 2); xx++) mark[yy * gw + xx] = 1;
  }
  // connected groups of marked cells
  const label = new Int32Array(gw * gh).fill(-1);
  let groups = 0;
  const stack = [];
  for (let c0 = 0; c0 < mark.length; c0++) {
    if (!mark[c0] || label[c0] >= 0) continue;
    label[c0] = groups;
    stack.push(c0);
    while (stack.length) {
      const c = stack.pop();
      const x = c % gw;
      for (const d of [x > 0 ? c - 1 : -1, x < gw - 1 ? c + 1 : -1, c - gw, c + gw]) {
        if (d >= 0 && d < mark.length && mark[d] && label[d] < 0) {
          label[d] = groups;
          stack.push(d);
        }
      }
    }
    groups++;
  }
  const regs = Array.from({ length: groups }, () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }));
  for (const i of u.missed) {
    const r = regs[label[cellOf(i)]];
    r.x0 = Math.min(r.x0, text[i * 4]);
    r.y0 = Math.min(r.y0, text[i * 4 + 1]);
    r.x1 = Math.max(r.x1, text[i * 4 + 2]);
    r.y1 = Math.max(r.y1, text[i * 4 + 3]);
    r.n++;
  }
  // a word or more of skipped text; lone specks and stray letters are not worth a pass
  let out = regs.filter((r) => r.n >= 8);
  for (const r of out) {
    r.lines = new Set();
    for (let pass = 0; pass < 4; pass++) {
      let grew = false;
      res.lines.forEach((l, i) => {
        if (r.lines.has(i)) return;
        const b = l.bbox;
        const vo = Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0);
        if (vo < 0.5 * Math.min(b.y1 - b.y0, r.y1 - r.y0)) return;
        if (b.x1 < r.x0 - 2 * cell || b.x0 > r.x1 + 2 * cell) return;
        r.lines.add(i);
        r.x0 = Math.min(r.x0, b.x0);
        r.y0 = Math.min(r.y0, b.y0);
        r.x1 = Math.max(r.x1, b.x1);
        r.y1 = Math.max(r.y1, b.y1);
        grew = true;
      });
      if (!grew) break;
    }
  }
  // regions that now overlap become one
  for (let merged = true; merged; ) {
    merged = false;
    for (let a = 0; a < out.length && !merged; a++) {
      for (let b = a + 1; b < out.length && !merged; b++) {
        const A = out[a];
        const B = out[b];
        if (A.x0 > B.x1 || B.x0 > A.x1 || A.y0 > B.y1 || B.y0 > A.y1) continue;
        A.x0 = Math.min(A.x0, B.x0);
        A.y0 = Math.min(A.y0, B.y0);
        A.x1 = Math.max(A.x1, B.x1);
        A.y1 = Math.max(A.y1, B.y1);
        A.n += B.n;
        for (const i of B.lines) A.lines.add(i);
        out.splice(b, 1);
        merged = true;
      }
    }
  }
  return out.map((r) => ({ ...r, pad: 0.6 * cell }));
}

// A rectangle (source px) of a prepared piece, as its own PGM and piece.
function cropPiece(piece, r) {
  const sx = piece.scale;
  const x0 = Math.max(0, Math.floor((r.x0 - r.pad) * sx));
  const y0 = Math.max(0, Math.floor((r.y0 - r.pad - piece.y0) * sx));
  const x1 = Math.min(piece.w, Math.ceil((r.x1 + r.pad) * sx));
  const y1 = Math.min(piece.h, Math.ceil((r.y1 + r.pad - piece.y0) * sx));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const head = piece.pgm.length - piece.w * piece.h;
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) g.set(piece.pgm.subarray(head + (y0 + y) * piece.w + x0, head + (y0 + y) * piece.w + x1), y * w);
  return { pgm: toPGM(g, w, h), w, h, scale: sx, x0: x0 / sx, y0: piece.y0 + y0 / sx };
}

// res with `drop` (line indexes) replaced by the lines and words of `add`.
function replaceLines(res, drop, add) {
  const lines = [];
  const words = [];
  const map = new Map();
  res.lines.forEach((l, i) => {
    if (drop.has(i)) return;
    map.set(i, lines.length);
    lines.push(l);
  });
  for (const w of res.words) if (map.has(w.line)) words.push({ ...w, line: map.get(w.line) });
  const off = lines.length;
  lines.push(...add.lines);
  for (const w of add.words) words.push({ ...w, line: w.line + off });
  return { ...res, lines, words };
}

/* ---------- createOcr ---------- */

export async function createOcr({ signal, onProgress, stallMs = SETUP_STALL_MS, recognizeStallMs = RECOGNIZE_STALL_MS } = {}) {
  const T = await guarded(() => loadTesseract(), { signal, stallMs, what: 'Loading OCR' });
  const dict = await loadWords();
  const hooks = { alive: null, fail: null, progress: onProgress };
  let worker = null;
  let starting = null;
  let closed = false;
  const prep = prepChannel();

  const report = (p) => {
    try {
      if (hooks.progress) hooks.progress(p);
    } catch (e) {
      /* a progress listener's bug is not an OCR failure */
    }
  };
  const logger = (m) => {
    if (hooks.alive) hooks.alive();
    if (!m || typeof m.progress !== 'number') return;
    const loading = !/recogniz/.test(m.status || '');
    report({ stage: loading ? 'ocr-load' : 'ocr', done: Math.round(m.progress * 100), total: 100, message: loading ? 'Getting the text reader ready' : 'Reading the text' });
  };
  const errorHandler = (e) => {
    if (hooks.fail) hooks.fail(e instanceof Error ? e : new Error(String(e)));
  };

  function kill() {
    const w = worker;
    worker = null;
    starting = null;
    if (w) w.terminate().catch(() => {});
  }

  function ensure(sig) {
    if (closed) return Promise.reject(new Error('OCR was terminated'));
    if (worker) return Promise.resolve(worker);
    if (!starting) {
      let created = null;
      starting = guarded(
        (alive, fail) => {
          hooks.alive = alive;
          hooks.fail = fail;
          created = T.createWorker('eng', 1, {
            workerPath: config.tesseract.worker,
            corePath: config.tesseract.core,
            langPath: config.tesseract.lang,
            cachePath: cachePathFor(config.tesseract.lang),
            gzip: true,
            logger,
            errorHandler,
          });
          return created.then(async (w) => {
            await w.setParameters({ tessedit_pageseg_mode: '3', thresholding_method: '2' });
            return w;
          });
        },
        { signal: sig, stallMs, what: 'OCR setup' }
      ).then(
        (w) => {
          hooks.alive = hooks.fail = null;
          if (closed) {
            w.terminate().catch(() => {});
            throw new Error('OCR was terminated');
          }
          worker = w;
          return w;
        },
        (e) => {
          hooks.alive = hooks.fail = null;
          starting = null;
          // a worker that turns up after we gave up must not linger
          if (created) created.then((w) => w.terminate().catch(() => {}), () => {});
          throw isAbort(e) ? e : new Error("Couldn't start the OCR engine: " + e.message);
        }
      );
    }
    return starting;
  }

  async function tess(img, opts, sig) {
    const w = await ensure(sig);
    try {
      return await guarded(
        (alive, fail) => {
          hooks.alive = alive;
          hooks.fail = fail;
          return w.recognize(img, opts, { text: false, blocks: true }).then((r) => r.data);
        },
        { signal: sig, stallMs: recognizeStallMs, what: 'OCR' }
      );
    } catch (e) {
      // An abandoned job keeps the worker busy (it can't be cancelled): start a
      // fresh one next time. Plain errors ("can't read image") leave it usable.
      if (isAbort(e) || e.name === 'StallError') kill();
      throw e;
    } finally {
      hooks.alive = hooks.fail = null;
    }
  }

  // Text the page layout skipped (whole paragraphs of a noisy photo can go as
  // "pictures") is read again, region by region, as plain blocks of text (PSM 6).
  // A region's reading replaces the lines it covers only when it finds more
  // dictionary words and isn't junk.
  async function fillGaps(res, piece, rung, sig) {
    const regions = gapRegions(res, piece.text).slice(0, 8);
    const drop = new Set();
    const add = { lines: [], words: [] };
    for (const r of regions) {
      const crop = cropPiece(piece, r);
      if (!crop) continue;
      const opts = { tessedit_pageseg_mode: '6' };
      if (rung.opts.thresholding_method) opts.thresholding_method = rung.opts.thresholding_method;
      const got = parse(await tess(crop.pgm, opts, sig), crop);
      // words of lines beside the region are already read
      const kept = res.words.filter((w) => !r.lines.has(w.line));
      const fresh = got.words.filter((w) => {
        const cx = (w.bbox.x0 + w.bbox.x1) / 2;
        const cy = (w.bbox.y0 + w.bbox.y1) / 2;
        return !kept.some((k) => cx >= k.bbox.x0 && cx <= k.bbox.x1 && cy >= k.bbox.y0 && cy <= k.bbox.y1);
      });
      const gj = judge(fresh, dict);
      const before = judge(res.words.filter((w) => r.lines.has(w.line)), dict);
      if (gj.quality < 0.6 || gj.conf < 0.5 || gj.good <= before.good) continue;
      const used = [...new Set(fresh.map((w) => w.line))].sort((a, b) => a - b);
      const at = new Map(used.map((li, k) => [li, add.lines.length + k]));
      for (const li of used) {
        const ws = fresh.filter((w) => w.line === li).sort((a, b) => a.bbox.x0 - b.bbox.x0);
        add.lines.push({ ...got.lines[li], text: ws.map((w) => w.text).join(' ') });
      }
      for (const w of fresh) add.words.push({ ...w, line: at.get(w.line) });
      for (const li of r.lines) drop.add(li);
    }
    if (!add.lines.length) return { res, filled: 0 };
    const out = replaceLines(res, drop, add);
    out.judge = judge(out.words, dict, piece.text);
    out.method = res.method;
    return { res: out, filled: add.lines.length };
  }

  // Calls are queued: one Tesseract worker, one image at a time.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function recognizeOne(image, { kind = 'scan', signal: sig } = {}) {
    if (sig && sig.aborted) throw abortError();
    const opened = await prep.open(image, kind);
    try {
      const all = { lines: [], words: [] };
      const methods = [];
      const passes = [];
      for (let p = 0; p < opened.pieces.length; p++) {
        let best = null;
        let skew = 0; // largest page skew any pass saw
        const rungs = [LADDER[0]];
        for (let k = 0; k < rungs.length; k++) {
          const rung = rungs[k];
          if (sig && sig.aborted) throw abortError();
          if (best && !worthTrying(rung, best, skew)) continue;
          const t0 = Date.now();
          const piece = await prep.prep(p, rung.mode);
          const t1 = Date.now();
          const data = await tess(piece.pgm, rung.opts, sig);
          let res = parse(data, piece);
          res.judge = judge(res.words, dict, piece.text);
          res.method = rung.name;
          const sk = skewOf(res.lines);
          if (Math.abs(sk) > Math.abs(skew)) skew = sk;
          const t2 = Date.now();
          const covered = res.judge.coverage;
          let filled = 0;
          // (a clearly skewed page is turned next, which reads it whole)
          const turnNext = k === 0 && Math.abs(skew) >= 2 * SKEWED;
          if (covered < 0.9 && res.judge.quality >= 0.6 && !turnNext) ({ res, filled } = await fillGaps(res, piece, rung, sig));
          const r2 = (x) => Math.round(x * 100) / 100;
          passes.push({ piece: p, method: rung.name, prepMs: t1 - t0, ocrMs: t2 - t1, fillMs: Date.now() - t2, size: [piece.w, piece.h], ...piece.info, letters: piece.text.length >> 2, skewDeg: Math.round((sk * 1800) / Math.PI) / 10, rotate: data.rotateRadians || 0, words: res.words.length, good: res.judge.good, junk: res.judge.junk, conf: r2(res.judge.conf), coverage: r2(covered), filled, coverageAfter: r2(res.judge.coverage) });
          if (!best || res.judge.score > best.judge.score) best = res;
          if (clearlyGood(best.judge)) break;
          // a clearly skewed page is turned before anything else is tried
          if (k === 0) rungs.push(...(Math.abs(skew) >= 2 * SKEWED ? [LADDER[2], LADDER[1]] : [LADDER[1], LADDER[2]]));
        }
        const off = all.lines.length;
        all.lines.push(...best.lines);
        for (const w of best.words) all.words.push({ ...w, line: w.line + off });
        methods.push(best.method);
      }
      // margin notes read into the body lines beside them come apart here
      const cut = splitLines(all.lines, all.words);
      // reading order over all pieces (columns, chat bubbles, long screenshots)
      const paras = layoutParagraphs(cut.lines, (i) => ({ text: cut.lines[i].text }));
      const newIndex = new Int32Array(cut.lines.length);
      const lines = [];
      paras.forEach((para, pi) =>
        para.lines.forEach((s) => {
          newIndex[s.i] = lines.length;
          lines.push({ ...cut.lines[s.i], para: pi, region: s.region });
        })
      );
      const words = cut.words
        .map((w) => ({ ...w, line: newIndex[w.line] }))
        .sort((a, b) => a.line - b.line || a.bbox.x0 - b.bbox.x0);
      const text = paras.map((para) => para.lines.map((s) => cut.lines[s.i].text).join('\n')).join('\n\n');
      const conf = words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : 0;
      const method = [...new Set(methods)].join(',');
      return { text, lines, words, conf, method, width: opened.width, height: opened.height, passes };
    } finally {
      await prep.close();
    }
  }

  // Download and start the engine now, so progress and failures show up here.
  try {
    await ensure(signal);
  } catch (e) {
    prep.terminate();
    throw e;
  }

  return {
    recognize(image, opts = {}) {
      return serial(async () => {
        const saved = hooks.progress;
        if (opts.onProgress) hooks.progress = opts.onProgress;
        try {
          return await recognizeOne(image, opts);
        } finally {
          hooks.progress = saved;
        }
      });
    },
    async terminate() {
      closed = true;
      kill();
      prep.terminate();
    },
  };
}

/* ---------- words -> blocks ---------- */

// Tesseract reads bullets as these when they're followed by a gap.
const BULLET_MISREAD = /^[eo«°¢©@»]$/;

// Bullets and line-end hyphens are handled before correction, so the corrector
// sees whole words.
function prepareWords(result, dict) {
  const lines = result.lines.map((l) => ({ ...l, bullet: false }));
  const words = result.words.map((w) => ({ ...w }));
  const byLine = new Map();
  words.forEach((w, k) => {
    if (!byLine.has(w.line)) byLine.set(w.line, []);
    byLine.get(w.line).push(k);
  });
  for (const [li, ks] of byLine) {
    const first = words[ks[0]];
    const second = words[ks[1]];
    if (!first || !second) continue;
    const gap = second.bbox.x0 - first.bbox.x1;
    const size = lines[li].size || 20;
    if (BULLET.test(first.text) || (BULLET_MISREAD.test(first.text) && gap > size * 0.35 && /^\p{Lu}/u.test(second.text))) {
      lines[li].bullet = true;
      first.skip = true;
    }
  }
  // A short token far out at either end of a line, read with little confidence,
  // is a speck or an edge (photos of pages): the corrector gets it as unsure.
  for (const [li, all] of byLine) {
    const ks = all.filter((k) => !words[k].skip);
    if (ks.length < 4) continue;
    const gaps = [];
    for (let j = 1; j < ks.length; j++) gaps.push(words[ks[j]].bbox.x0 - words[ks[j - 1]].bbox.x1);
    const far = Math.max(2.5 * median(gaps.filter((g) => g > 0)), lines[li].size || 20);
    const lone = (w) => {
      const c = core(w.text).w;
      return w.conf < 0.6 && c.length <= 4 && !(w.conf >= 0.4 && c.length >= 3 && isKnown(dict, c));
    };
    for (let j = ks.length - 1; j >= 2 && gaps[j - 1] > far && lone(words[ks[j]]); j--) words[ks[j]].conf = Math.min(words[ks[j]].conf, 0.15);
    for (let j = 0; j < ks.length - 2 && gaps[j] > far && lone(words[ks[j]]); j++) words[ks[j]].conf = Math.min(words[ks[j]].conf, 0.15);
  }
  // line-end hyphens: 'transcri-' + 'be' -> 'transcribe'; 'forty-' + 'two' stays 'forty-two'
  for (let k = 0; k + 1 < words.length; k++) {
    const a = words[k];
    const b = words[k + 1];
    if (a.skip || b.skip || a.line === b.line || lines[a.line].para !== lines[b.line].para) continue;
    const m = /^(.*\p{L})[-‐‑]$/u.exec(a.text);
    if (!m || !/^\p{Ll}/u.test(b.text)) continue;
    const left = core(m[1]).w;
    const bw = core(b.text);
    const joined = left + bw.w;
    const bothWords = isKnown(dict, left) && isKnown(dict, bw.w);
    a.text = bothWords && !isKnown(dict, joined) ? m[1] + '-' + b.text : m[1] + b.text;
    a.conf = Math.min(a.conf, b.conf);
    b.skip = true;
  }
  return { lines, words };
}

// OCR result -> Blocks, corrected. Exported for the PDF reader's scanned pages.
//   corrector: from createCorrector() (optional; without it nothing is corrected or dropped)
export async function ocrBlocks(result, { corrector, page = 1 } = {}) {
  const dict = await loadWords();
  const { lines, words } = prepareWords(result, dict);
  const live = words.filter((w) => !w.skip);
  let fixed = live.map((w) => ({ ...w, changed: false, dropped: false }));
  let dropped = [];
  if (corrector && live.length) {
    const r = await corrector.correctWords(live);
    fixed = r.words;
    dropped = r.dropped;
  }
  const lineWords = new Map();
  for (const w of fixed) {
    if (w.dropped || !w.text) continue;
    if (!lineWords.has(w.line)) lineWords.set(w.line, []);
    lineWords.get(w.line).push(w);
  }
  // geometry again, with the corrected text
  const paras = layoutParagraphs(lines, (i) => (lineWords.has(i) ? { text: lineWords.get(i).map((w) => w.text).join(' '), bullet: lines[i].bullet } : null));
  const order = paras.flatMap((p) => p.lines);
  const sizes = [];
  for (const s of order) for (let k = 0; k < lineWords.get(s.i).length; k++) sizes.push(s.size);
  const body = median(sizes);
  const maxSize = Math.max(0, ...order.map((s) => s.size));
  const blocks = [];
  let low = 0;
  let count = 0;
  for (const para of paras) {
    const ws = para.lines.flatMap((s) => lineWords.get(s.i));
    const text = para.lines
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const conf = ws.reduce((a, w) => a + w.conf, 0) / ws.length;
    for (const w of ws) if (w.conf < 0.6 && !w.changed) low++;
    count += ws.length;
    if (para.note) {
      // a side note, marked as the PDF reader marks them: kept, not read by default
      blocks.push({ type: 'note', text, page, source: 'ocr', conf: Math.round(conf * 1000) / 1000, skip: 'margin' });
      continue;
    }
    const level = headingLevel(para, body, maxSize, ws.length);
    const type = para.bullet ? 'li' : level ? 'h' + level : 'p';
    blocks.push({ type, text, page, source: 'ocr', conf: Math.round(conf * 1000) / 1000 });
  }
  return { blocks, dropped, stats: { words: count, lowConfidenceWords: low, droppedTokens: dropped.length } };
}

/* ---------- ocrImage ---------- */

async function sniffKind(blob) {
  let type = blob.type || '';
  if (!type && blob.slice) {
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (b[0] === 0x89 && b[1] === 0x50) type = 'image/png';
    else if (b[0] === 0xff && b[1] === 0xd8) type = 'image/jpeg';
  }
  // Lossless formats are almost always screenshots; camera photos are JPEG/HEIC.
  return /png|gif|bmp|webp/.test(type) ? 'screenshot' : 'photo';
}

const titleFrom = (name) => (name ? String(name).replace(/\.[a-z0-9]{2,5}$/i, '').trim() : '');

// A photo or screenshot -> corrected blocks.
export async function ocrImage(blob, opts = {}) {
  const { dialect = 'en-US', allowOcr, signal, onProgress } = opts;
  const make = opts.createOcr || createOcr;
  const makeCorrector = opts.createCorrector || createCorrector;
  const warnings = [];
  const stats = { pages: 1, ocrPages: 0, words: 0, lowConfidenceWords: 0, droppedTokens: 0 };
  let title = titleFrom(opts.name || blob.name);
  if (allowOcr && !(await allowOcr({ pages: 1, bytes: OCR_BYTES }))) {
    warnings.push({ type: 'ocr-unavailable', page: 1, text: 'Reading text in pictures is turned off.' });
    return { title, blocks: [], warnings, stats };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    warnings.push({ type: 'unsupported', page: 1, text: "This picture's format can't be opened here. Try a JPEG or PNG." });
    return { title, blocks: [], warnings, stats };
  }
  const kind = await sniffKind(blob);
  // The corrector builds (and downloads its word pairs) while the OCR runs.
  const correctorP = makeCorrector({ dialect }).catch((e) => {
    warnings.push({ type: 'ocr-unavailable', page: 1, text: "Couldn't load the spelling check, so OCR mistakes are not corrected." });
    console.warn('readkit: corrector failed', e);
    return null;
  });
  let ocr = null;
  let result;
  let corrector = null;
  try {
    ocr = await make({ signal, onProgress });
    result = await ocr.recognize(bitmap, { kind, signal });
    corrector = await correctorP;
    if (signal && signal.aborted) throw abortError();
    const out = await ocrBlocks(result, { corrector, page: 1 });
    stats.ocrPages = 1;
    stats.words = out.stats.words;
    stats.lowConfidenceWords = out.stats.lowConfidenceWords;
    stats.droppedTokens = out.stats.droppedTokens;
    if (!out.blocks.length) warnings.push({ type: 'ocr-low-confidence', page: 1, text: 'No text was found in the picture.' });
    else if (result.conf < 0.6) warnings.push({ type: 'ocr-low-confidence', page: 1, text: 'The text was hard to read, so some words may be wrong.' });
    for (const t of out.dropped.slice(0, 100)) warnings.push({ type: 'dropped-token', page: 1, text: t });
    if (!title) {
      const h = out.blocks.find((b) => b.type[0] === 'h') || out.blocks[0];
      title = h ? h.text.split(' ').slice(0, 8).join(' ').replace(/[.,;:]$/, '') : 'Picture';
    }
    return { title, blocks: out.blocks, warnings, stats, method: result.method, conf: result.conf };
  } finally {
    if (bitmap.close) bitmap.close();
    if (ocr) ocr.terminate();
    correctorP.then((c) => c && c.dispose());
  }
}
