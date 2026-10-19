// extractPdf: PDF bytes -> { title, blocks, warnings, stats }.
//
// Each page's text layer is scored first. Good text is laid out (reading order,
// running heads, margin notes, footnotes, paragraphs). Pages whose text is garbage (a
// broken font map), suspect, or near-empty but showing ink are rendered at about 300 dpi
// and OCR'd; for suspect pages the better-scoring text wins. A scanned page with the
// scanner's own invisible OCR layer is read twice, by that layer and by our OCR, and the
// two readings are fused word by word (fuse.js); its margin notes get a second, closer
// OCR pass. Blocks stream out page by page through onBlock, so page 1 can be read while
// page 30 is still being OCR'd. Garbage is never passed on as text.

import { loadWords } from '../lang/words.js';
import { loadPdfjs, documentOptions } from './pdfjs.js';
import { judgePage, quality, isJunkToken, core } from './quality.js';
import { runsFromTextContent, segmentsOf, layoutPage, bandSegments, keysMatch, joinLines } from './layout.js';
import { analyzeOps, isScanLayer } from './ops.js';
import { renderPage, inkShare, printLines, toImage, freeCanvas, makeCanvas, paperShade } from './render.js';
import { ocrLines, correctLines, ocrSegments, patchRuns, shiftLines } from './ocrpage.js';
import { fuseScan } from './scan.js';
import { atomsFromSegments } from '../layout/layout.js';

const WINDOW = 4; // pages either side compared when looking for running heads
const OCR_BYTES = 5.5e6; // Tesseract core + English model + correction data, roughly
const INK = 0.008; // ink share (outside the text layer) that makes a near-empty page worth OCR: a few lines of print
const LOW_CONF = 0.6;
const MAX_DROP_WARNINGS = 40; // per page
const CROP_PAD = 8; // points of white around a margin-note strip sent to OCR

function abortError(signal) {
  return signal.reason || new DOMException('The operation was aborted.', 'AbortError');
}

function check(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

// pdf.js leaves some promises pending for ever once its document is destroyed (as it is
// on abort), so every wait on pdf.js also ends when the signal fires.
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError(signal));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', stop);
        reject(e);
      },
    );
  });
}

// opts: { ocr: 'auto'|'always'|'never', dialect, allowOcr, signal, onProgress, onBlock,
//   createOcr, createCorrector (injectable for tests), scanText: 'fuse'|'layer'|'ocr'
//   (how scanned pages with an invisible text layer are read; tests compare the three),
//   pages: [first, last] (read only these pages; the rest are still looked at for
//   running heads), debug: (info) => void (intermediate results of scanned pages) }
export async function extractPdf(bytes, opts = {}) {
  const run = new PdfRun(bytes, opts);
  try {
    return await run.run();
  } finally {
    await run.close();
  }
}

class PdfRun {
  constructor(bytes, opts) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.opts = opts;
    this.mode = opts.ocr || 'auto';
    this.signal = opts.signal || null;
    this.warnings = [];
    this.stats = { pages: 0, ocrPages: 0, words: 0, lowConfidenceWords: 0, droppedTokens: 0 };
    this.blocks = [];
    this.recs = new Map();
    this.keys = []; // keys[p]: running-head candidates [{ side, key }]
    this.fsHist = new Map(); // font size (0.5 pt steps) -> chars, over trusted text
    this.boldHist = new Map();
    this.nextToAnalyze = 1;
    this.cur = 0;
    this.ocrState = null; // { engine } once started, { off } if OCR can't or mustn't run
    this.correctorP = null;
    this.bigramsP = null;
    this.held = null; // a paragraph that may continue on the next page
    this.heldTail = [];
    this.warnedLayer = false;
    this.first = 1;
    this.last = 0;
    this.layoutPages = opts.layout ? [] : null; // opts.layout: each page's segments, for src/layout
  }

  progress(stage, done, total, message) {
    if (!this.opts.onProgress) return;
    try {
      this.opts.onProgress({ stage, done, total, message });
    } catch (e) {
      /* the app's callback must not break extraction */
    }
  }

  warn(type, page, text) {
    this.warnings.push({ type, page, text });
  }

  // With opts.layout, the segments a page was laid out from, as positioned atoms.
  capture(rec, segs, width, height, source) {
    if (!this.layoutPages) return;
    this.layoutPages.push({ page: rec.p, width, height, unit: 'pt', source, atoms: atomsFromSegments(segs) });
  }

  async run() {
    const { signal } = this;
    check(signal);
    this.progress('pdf', 0, 0, 'Opening the PDF');
    const [lib, words] = await Promise.all([loadPdfjs(), loadWords()]);
    this.lib = lib;
    this.words = words;
    check(signal);
    // pdf.js transfers the buffer it is given to its worker, so give it a copy.
    this.task = lib.getDocument({ data: this.bytes.slice(), ...documentOptions() });
    this.onAbort = () => {
      if (this.task) this.task.destroy().catch(() => {});
    };
    if (signal) signal.addEventListener('abort', this.onAbort, { once: true });
    try {
      this.pdf = await abortable(this.task.promise, signal);
    } catch (e) {
      check(signal);
      const name = e && e.name;
      if (name === 'PasswordException') return this.result('', [{ type: 'drm', page: null, text: 'This PDF is password-protected, so it can’t be read.' }]);
      if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'UnknownErrorException' || name === 'MissingPDFException') {
        return this.result('', [{ type: 'unsupported', page: null, text: 'This file isn’t a readable PDF (it may be damaged).' }]);
      }
      throw e;
    }
    const n = this.pdf.numPages;
    this.n = n;
    this.stats.pages = n;
    const metaTitle = await this.metaTitle();
    const [first, last] = Array.isArray(this.opts.pages) ? [Math.max(1, this.opts.pages[0] | 0), Math.min(n, this.opts.pages[1] | 0 || n)] : [1, n];
    this.first = first;
    this.last = last;
    for (let p = first; p <= last; p++) {
      check(signal);
      this.cur = p;
      this.progress('pdf', p - 1, n, `Reading page ${p} of ${n}`);
      await this.analyzeThrough(Math.min(n, p + WINDOW));
      const rec = await this.full(p);
      const res = await this.finish(rec);
      this.emitPage(res);
      this.recs.delete(p);
      this.cleanup(p);
    }
    this.flushHeld();
    this.progress('pdf', n, n, 'Done');
    let title = metaTitle;
    if (!title) {
      // the most prominent heading on the first two pages: 'CHAPTER VII' sits above the
      // chapter's real title
      const early = this.blocks.filter((b) => /^h[1-3]$/.test(b.type) && b.page <= 2 && b.text.length <= 150);
      const h = early.find((b) => b.type === 'h1') || early.find((b) => b.type === 'h2') || early[0];
      if (h) title = h.text;
    }
    return this.result(title);
  }

  result(title, warnings) {
    if (warnings) this.warnings.push(...warnings);
    let words = 0;
    for (const b of this.blocks) if (!b.skip) words += b.text.split(/\s+/).filter(Boolean).length;
    this.stats.words = words;
    const out = { title: title || '', blocks: this.blocks, warnings: this.warnings, stats: this.stats };
    if (this.layoutPages) out.layout = { pages: this.layoutPages };
    return out;
  }

  async close() {
    if (this.signal && this.onAbort) this.signal.removeEventListener('abort', this.onAbort);
    const st = this.ocrState;
    if (st && st.engine) {
      try {
        await st.engine.terminate();
      } catch (e) {
        /* ignore */
      }
    }
    if (this.correctorP) {
      try {
        const c = await this.correctorP;
        if (c && c.dispose) await c.dispose();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      if (this.pdf) await this.pdf.destroy();
      else if (this.task) await this.task.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  async metaTitle() {
    try {
      const meta = await abortable(this.pdf.getMetadata(), this.signal);
      let t = meta && meta.info && meta.info.Title;
      if ((!t || typeof t !== 'string') && meta && meta.metadata && meta.metadata.get) t = meta.metadata.get('dc:title');
      return cleanTitle(t, this.words);
    } catch (e) {
      return '';
    }
  }

  /* ---------- analysis: what each page is ---------- */

  async analyzeThrough(upTo) {
    if (this.nextToAnalyze < this.first - WINDOW) this.nextToAnalyze = Math.max(1, this.first - WINDOW);
    while (this.nextToAnalyze <= upTo) {
      check(this.signal);
      const p = this.nextToAnalyze++;
      const rec = await this.analyze(p);
      this.recs.set(p, rec);
      if (p > this.cur + WINDOW) this.lighten(rec);
    }
  }

  // Far-ahead pages (analyzed only to count OCR pages) keep their verdict, not their text.
  lighten(rec) {
    if (rec.light) return;
    rec.frame = null;
    rec.segs = null;
    rec.light = true;
    this.cleanup(rec.p);
  }

  async full(p) {
    let rec = this.recs.get(p);
    if (!rec) {
      rec = await this.analyze(p);
      this.recs.set(p, rec);
    } else if (rec.light) {
      const again = await this.analyze(p, rec);
      rec = again;
      this.recs.set(p, rec);
    }
    return rec;
  }

  async analyze(p, prev) {
    let page;
    try {
      page = await abortable(this.pdf.getPage(p), this.signal);
      const vp = page.getViewport({ scale: 1 });
      const tc = await abortable(page.getTextContent({ includeMarkedContent: true }), this.signal);
      let ops = null;
      try {
        const list = await abortable(page.getOperatorList({ annotationMode: this.lib.AnnotationMode.DISABLE }), this.signal);
        ops = analyzeOps(list, this.lib.OPS, page.view, (name) => {
          try {
            return page.commonObjs.has(name) ? page.commonObjs.get(name) : null;
          } catch (e) {
            return null;
          }
        });
      } catch (e) {
        check(this.signal);
        ops = null;
      }
      const frame = runsFromTextContent(tc, vp, ops ? ops.fonts : {});
      const judge = judgePage(frame.runs, this.words);
      const rec = { p, frame, judge, ops, scan: isScanLayer(ops), vpW: vp.width, vpH: vp.height, upright: Math.abs(frame.width - vp.width) < 1 && Math.abs(frame.height - vp.height) < 1 };
      rec.kind = this.kindOf(rec);
      // A scanner's layer has the right sizes even where its words are wrong.
      const trusted = rec.kind === 'text' || rec.kind === 'patch' || rec.kind === 'compare' || (rec.kind === 'fuse' && judge.verdict !== 'garbage');
      if (trusted && !(prev && prev.counted)) {
        for (const r of frame.runs) {
          if (rec.kind === 'patch' && judge.badFonts.has(r.font)) continue;
          const k = Math.round(r.fs * 2) / 2;
          const c = r.str.length;
          this.fsHist.set(k, (this.fsHist.get(k) || 0) + c);
          if (r.bold) this.boldHist.set(k, (this.boldHist.get(k) || 0) + c);
        }
      }
      rec.counted = trusted || !!(prev && prev.counted);
      rec.segs = segmentsOf(frame.runs, this.bodyFs(), null);
      if (trusted) this.keys[p] = bandSegments(rec.segs, frame.height, this.bodyFs()).map((c) => ({ side: c.side, key: c.key }));
      return rec;
    } catch (e) {
      if (this.signal && this.signal.aborted) throw abortError(this.signal);
      return { p, kind: 'error', error: e, judge: null, frame: null };
    }
  }

  kindOf(rec) {
    const { judge, ops } = rec;
    if (rec.scan) return 'fuse';
    if (this.mode === 'always') return 'prefer';
    if (judge.verdict === 'garbage') return 'ocr';
    if (judge.verdict === 'suspect') return 'compare';
    if (judge.verdict === 'sparse') {
      if (!ops || ops.paints || ops.glyphs > 2 * judge.metrics.chars + 20) return 'ink';
      return 'text';
    }
    if (judge.badFonts.size) return 'patch';
    return 'text';
  }

  bodyFs() {
    let best = 0;
    let bestN = 0;
    for (const [k, n] of this.fsHist) if (n > bestN) (best = k), (bestN = n);
    return best || null;
  }

  bodyBold() {
    const k = this.bodyFs();
    return k ? (this.boldHist.get(k) || 0) > 0.5 * this.fsHist.get(k) : false;
  }

  cleanup(p) {
    if (!this.pdf) return;
    this.pdf
      .getPage(p)
      .then((page) => page.cleanup())
      .catch(() => {});
  }

  // How many pages will need OCR (for the one-time question): known verdicts, plus
  // near-empty pages that draw images or many paths.
  ocrPageCount() {
    let n = 0;
    for (const rec of this.recs.values()) {
      if (rec.p < this.cur || rec.p > this.last) continue;
      if (rec.kind === 'ocr' || rec.kind === 'compare' || rec.kind === 'patch' || rec.kind === 'prefer' || rec.kind === 'fuse') n++;
      else if (rec.kind === 'ink' && (!rec.ops || rec.ops.maxImage >= 0.3 || rec.ops.paths >= 40)) n++;
    }
    return Math.max(1, n);
  }

  /* ---------- OCR engine, corrector and word pairs, started once ---------- */

  async engine() {
    if (this.ocrState) return this.ocrState.engine || null;
    if (this.mode === 'never') {
      this.ocrState = { off: 'never' };
      return null;
    }
    // Look at the rest of the document first, so the question can say how many pages.
    await this.analyzeThrough(this.last);
    let create = this.opts.createOcr;
    let bytes = OCR_BYTES;
    if (!create) {
      try {
        const mod = await import('../ocr/ocr.js');
        create = mod.createOcr;
        if (typeof mod.OCR_BYTES === 'number') bytes = mod.OCR_BYTES;
        if (typeof create !== 'function') throw new Error('createOcr missing');
      } catch (e) {
        check(this.signal);
        this.ocrState = { off: 'unavailable', reason: (e && e.message) || String(e) };
        return null;
      }
    }
    if (this.opts.allowOcr) {
      let ok = false;
      try {
        ok = await this.opts.allowOcr({ pages: this.ocrPageCount(), bytes });
      } catch (e) {
        ok = false;
      }
      check(this.signal);
      if (!ok) {
        this.ocrState = { off: 'declined' };
        return null;
      }
    }
    try {
      const engine = await create({
        signal: this.signal,
        onProgress: (p) => {
          if (this.opts.onProgress && p) this.progress(p.stage || 'ocr-load', p.done, p.total, p.message);
        },
      });
      this.ocrState = { engine };
      return engine;
    } catch (e) {
      check(this.signal);
      this.ocrState = { off: 'failed', reason: (e && e.message) || String(e), code: e && e.code };
      return null;
    }
  }

  corrector() {
    if (!this.correctorP) {
      this.correctorP = (async () => {
        try {
          const create = this.opts.createCorrector || (await import('../lang/correct.js')).createCorrector;
          if (typeof create !== 'function') return null;
          return await create({ dialect: this.opts.dialect || 'en-US' });
        } catch (e) {
          return null; // fall back to dropping clear junk only
        }
      })();
    }
    return this.correctorP;
  }

  // English word pairs, for choosing between two readings of a word in context.
  bigrams() {
    if (!this.bigramsP) {
      this.bigramsP = import('../lang/bigrams.js')
        .then((m) => m.loadBigrams())
        .catch(() => null);
    }
    return this.bigramsP;
  }

  ocrOffText(p, what) {
    const st = this.ocrState || {};
    // (a Content Security Policy that blocks WebAssembly is named: the fix is the page's, not the file's)
    const blocked = "OCR can’t start here (the Content Security Policy of this page or extension blocks WebAssembly; a Chrome extension needs 'wasm-unsafe-eval' in its content_security_policy)";
    const why = st.off === 'never' ? 'OCR is turned off' : st.off === 'declined' ? 'OCR wasn’t allowed' : st.code === 'ocr-blocked' ? blocked : 'OCR isn’t available';
    return `Page ${p} ${what}, and ${why}, so it was skipped.`;
  }

  // Renders and OCRs a page: raw OCR lines (uncorrected), or null when OCR can't run.
  // keep: also return the page image (for second looks); call release() when done.
  async ocrRaw(rec, rendered, keep = false) {
    const p = rec.p;
    const engine = await this.engine();
    if (!engine) {
      if (rendered) freeCanvas(rendered.canvas);
      return null;
    }
    check(this.signal);
    this.ocrDone = (this.ocrDone || 0) + 1;
    if (!this.ocrTotal) this.ocrTotal = this.ocrPageCount();
    this.progress('ocr', this.ocrDone - 1, Math.max(this.ocrDone, this.ocrTotal), `Reading scanned page ${p} with OCR`);
    let r = rendered;
    let img = null;
    let res;
    const release = () => {
      if (img && r && img !== r.canvas && typeof img.close === 'function') img.close();
      if (r) freeCanvas(r.canvas);
      img = null;
    };
    try {
      if (!r) r = await this.render(rec);
      img = toImage(r.canvas);
      res = await engine.recognize(img, { kind: 'scan', signal: this.signal });
    } catch (e) {
      release();
      check(this.signal);
      this.warn('ocr-unavailable', p, `Page ${p} couldn’t be read with OCR (${(e && e.message) || 'error'}).`);
      return null;
    }
    const width = img.width;
    const height = img.height;
    if (!keep) release();
    check(this.signal);
    const lines = ocrLines(res || {});
    let confSum = 0;
    let n = 0;
    let low = 0;
    for (const l of lines) {
      for (const w of l.words) {
        confSum += w.conf;
        n++;
        if (w.conf < LOW_CONF) low++;
      }
    }
    return { lines, scale: r.scale, img: keep ? img : null, width, height, conf: n ? confSum / n : 0, words: n, low, release };
  }

  // Renders and OCRs a page, corrected and as layout segments. Returns null when OCR can't run.
  async ocrPage(rec, rendered) {
    const o = await this.ocrRaw(rec, rendered);
    if (!o) return null;
    const fixed = await correctLines(o.lines, await this.corrector(), this.words);
    this.noteDropped(rec.p, fixed.dropped);
    const segs = ocrSegments(fixed.lines, o.scale);
    const text = segs.map((s) => s.text).join('\n');
    return { lines: fixed.lines, segs, text, quality: quality(text, this.words), conf: o.conf, words: o.words, low: o.low, scale: o.scale };
  }

  // A second, closer OCR pass over strips of the page image (margin notes): Tesseract
  // reads a narrow column of small italics far better on its own than beside the body.
  // Returns lines in page pixels, or null.
  async ocrCrops(o, regions) {
    const engine = this.ocrState && this.ocrState.engine;
    if (!engine || !o.img) return null;
    const out = [];
    const pad = Math.round(CROP_PAD * o.scale);
    for (const r of regions) {
      check(this.signal);
      const sx = Math.max(0, Math.floor(r.x0 * o.scale));
      const sy = Math.max(0, Math.floor(r.top * o.scale));
      const w = Math.min(o.width, Math.ceil(r.x1 * o.scale)) - sx;
      const h = Math.min(o.height, Math.ceil(r.bot * o.scale)) - sy;
      if (w < 16 || h < 16) continue;
      const c = makeCanvas(w + 2 * pad, h + 2 * pad);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(o.img, sx, sy, w, h, pad, pad, w, h);
      // The frame round the strip is the paper's own shade: a white frame round a grey
      // scan threw Tesseract's thresholding off (it read nothing in one such strip).
      ctx.fillStyle = paperShade(ctx, pad, pad, w, h);
      ctx.fillRect(0, 0, c.width, pad);
      ctx.fillRect(0, pad + h, c.width, pad);
      ctx.fillRect(0, pad, pad, h);
      ctx.fillRect(pad + w, pad, pad, h);
      const img = toImage(c);
      try {
        const res = await engine.recognize(img, { kind: 'scan', signal: this.signal });
        out.push(...shiftLines(ocrLines(res || {}), sx - pad, sy - pad));
      } catch (e) {
        check(this.signal); // a failed second look leaves the first reading in place
      } finally {
        if (img !== c && typeof img.close === 'function') img.close();
        freeCanvas(c);
      }
    }
    return out;
  }

  async render(rec) {
    const page = await abortable(this.pdf.getPage(rec.p), this.signal);
    return abortable(renderPage(page, { signal: this.signal }), this.signal);
  }

  noteDropped(p, dropped) {
    if (!dropped || !dropped.length) return;
    this.stats.droppedTokens += dropped.length;
    for (const t of dropped.slice(0, MAX_DROP_WARNINGS)) this.warn('dropped-token', p, String(t));
  }

  /* ---------- one page -> blocks ---------- */

  async finish(rec) {
    const p = rec.p;
    const empty = { body: [], headers: [], footers: [], notes: [], margins: [] };
    switch (rec.kind) {
      case 'error':
        this.warn('unsupported', p, `Page ${p} couldn’t be read (${(rec.error && rec.error.message) || 'error'}).`);
        return empty;
      case 'text':
        return this.layoutText(rec, rec.frame.runs);
      case 'fuse':
        return this.finishScan(rec);
      case 'patch': {
        if (rec.upright) {
          const o = await this.ocrPage(rec);
          if (o) {
            this.useOcrStats(o, false);
            const { runs } = patchRuns(rec.frame.runs, rec.judge.badFonts, o.lines, o.scale);
            return this.layoutText(rec, runs);
          }
        }
        if (!this.ocrState || !this.ocrState.engine) this.warn('ocr-unavailable', p, this.ocrOffText(p, 'has text in a font that can’t be read'));
        return this.layoutText(rec, rec.frame.runs.filter((r) => !rec.judge.badFonts.has(r.font)));
      }
      case 'ocr': {
        const o = await this.ocrPage(rec);
        if (!o) {
          this.warn('ocr-unavailable', p, this.ocrOffText(p, 'has unreadable text (a broken font map)'));
          return empty;
        }
        if (o.quality.verdict === 'garbage' || !o.segs.length) {
          this.warn('garbage-text-layer', p, `Page ${p}’s text layer was unreadable, and OCR found no readable text on it.`);
          return empty;
        }
        this.warn('garbage-text-layer', p, `Page ${p}’s text layer was unreadable, so the page was read with OCR.`);
        return this.layoutOcr(rec, o);
      }
      case 'compare': {
        const o = await this.ocrPage(rec);
        if (o && ocrWins(o.quality, rec.judge)) return this.layoutOcr(rec, o);
        if (!o && this.ocrState && this.ocrState.off !== 'never' && rec.judge.verdict !== 'ok') {
          this.warn('ocr-unavailable', p, `Page ${p}’s text may contain errors; OCR could have checked it.`);
        }
        return this.layoutText(rec, rec.frame.runs, { scrub: rec.judge.verdict !== 'ok' });
      }
      case 'ink': {
        if (this.mode === 'never' || (this.ocrState && !this.ocrState.engine)) {
          this.maybeWarnInk(rec);
          return this.layoutText(rec, rec.frame.runs);
        }
        let r;
        try {
          r = await this.render(rec);
        } catch (e) {
          check(this.signal);
          return this.layoutText(rec, rec.frame.runs);
        }
        const boxes = rec.upright ? rec.frame.runs : [];
        const share = inkShare(r.canvas, r.scale, boxes);
        // A scan with one or two short lines of print (a chapter's last page) has too little
        // ink to count, but its lines of strokes show; a blank scan has none.
        const few = share < INK && rec.ops && rec.ops.maxImage >= 0.3 && printLines(r.canvas, r.scale, boxes).length > 0;
        if (share < INK && !few) {
          freeCanvas(r.canvas);
          return this.layoutText(rec, rec.frame.runs);
        }
        const o = await this.ocrPage(rec, r);
        if (!o) {
          this.warn('ocr-unavailable', p, this.ocrOffText(p, 'is a scanned image'));
          return this.layoutText(rec, rec.frame.runs);
        }
        if (o.segs.length && o.quality.verdict !== 'garbage' && o.quality.content + o.quality.tokens > rec.judge.metrics.content + rec.judge.metrics.tokens) return this.layoutOcr(rec, o);
        if (few) this.warn('ocr-low-confidence', p, `Page ${p} has a few lines of print that OCR couldn’t read.`);
        return this.layoutText(rec, rec.frame.runs);
      }
      case 'prefer': {
        const o = await this.ocrPage(rec);
        if (o && o.segs.length && o.quality.verdict !== 'garbage' && (o.quality.verdict !== 'sparse' || rec.judge.verdict === 'sparse')) return this.layoutOcr(rec, o);
        if (rec.judge.verdict === 'garbage') {
          this.warn(o ? 'garbage-text-layer' : 'ocr-unavailable', p, o ? `Page ${p} couldn’t be read.` : this.ocrOffText(p, 'has unreadable text'));
          return empty;
        }
        return this.layoutText(rec, rec.frame.runs, { scrub: rec.judge.verdict !== 'ok' });
      }
      default:
        return empty;
    }
  }

  // A scanned page with the scanner's invisible OCR layer: our OCR and the layer, fused.
  async finishScan(rec) {
    const p = rec.p;
    let how = this.opts.scanText || 'fuse';
    // (OCR boxes and layer boxes only line up on pages read the right way up)
    if (!rec.upright && how === 'fuse') how = 'ocr';
    const o = how === 'layer' ? null : await this.ocrRaw(rec, null, true);
    try {
      if (!o && how === 'ocr' && !rec.upright) how = 'layer';
      if (!o && how === 'ocr') {
        this.warn('ocr-unavailable', p, this.ocrOffText(p, 'is a scanned image'));
        return { body: [], headers: [], footers: [], notes: [], margins: [] };
      }
      const layer = how === 'ocr' ? [] : rec.frame.runs;
      const dbg = this.opts.debug ? { page: p, how, H: rec.vpH, docFs: this.bodyFs(), layer, ocr: o ? { lines: o.lines, scale: o.scale } : null, crops: [] } : null;
      const crops =
        o && o.img
          ? async (regions) => {
              const extra = await this.ocrCrops(o, regions);
              if (dbg) dbg.crops.push({ regions, extra });
              return extra;
            }
          : null;
      const r = await fuseScan({
        layer,
        ocr: o ? { lines: o.lines, scale: o.scale } : null,
        H: rec.vpH,
        docFs: this.bodyFs(),
        words: this.words,
        bigrams: o ? await this.bigrams() : null,
        corrector: o ? await this.corrector() : null,
        crops,
      });
      if (o) o.release();
      check(this.signal);
      this.noteDropped(p, r.dropped);
      if (!o && !this.warnedLayer && this.mode !== 'never') {
        this.warnedLayer = true;
        this.warn('ocr-unavailable', p, 'Scanned pages were read from the scanner’s own text layer without checking it with OCR; some words may be missing or wrong.');
      }
      const kept = r.words;
      const bodyFs = r.bodyFs;
      this.keys[p] = bandSegments(r.segs, rec.vpH, bodyFs).map((c) => ({ side: c.side, key: c.key }));
      this.capture(rec, r.segs, rec.vpW, rec.vpH, o ? 'ocr' : 'text');
      const res = layoutPage(r.segs, this.ctxFor(rec, o ? 'ocr' : 'text', rec.vpH, { fs: bodyFs, bold: false }));
      if (dbg) {
        Object.assign(dbg, { bodyFs, kept, segs: r.segs, regions: r.regions, read: r.read, res: JSON.parse(JSON.stringify(res)) });
        try {
          this.opts.debug(dbg);
        } catch (e) {
          /* a test hook */
        }
      }
      // (junk was dropped word by word in fuseScan)
      if (o) {
        this.stats.ocrPages++;
        this.stats.lowConfidenceWords += kept.filter((w) => w.conf < LOW_CONF).length;
        if (o.conf < LOW_CONF) this.warn('ocr-low-confidence', p, `Page ${p} was hard to read; some words may be wrong.`);
      }
      return this.tag(res, p, o ? 'ocr' : 'text');
    } finally {
      if (o) o.release();
    }
  }

  maybeWarnInk(rec) {
    // Without OCR we can't tell a blank scan from a page of text in an image, so only
    // warn for pages that draw a large image.
    if (rec.ops && rec.ops.maxImage >= 0.3 && rec.judge.metrics.content < 8) this.warn('ocr-unavailable', rec.p, this.ocrOffText(rec.p, 'is a scanned image'));
  }

  useOcrStats(o, wholePage) {
    if (wholePage) this.stats.ocrPages++;
    this.stats.lowConfidenceWords += o.low;
  }

  ctxFor(rec, source, H, body) {
    return {
      words: this.words,
      page: rec.p,
      source,
      loose: source === 'ocr' || rec.scan,
      H,
      body,
      repeated: (side, key) => this.repeated(rec.p, side, key),
    };
  }

  repeated(p, side, key) {
    for (let q = Math.max(1, p - WINDOW); q <= Math.min(this.n, p + WINDOW); q++) {
      if (q === p || !this.keys[q]) continue;
      for (const k of this.keys[q]) if (k.side === side && keysMatch(k.key, key)) return true;
    }
    return false;
  }

  layoutText(rec, runs, { scrub = false } = {}) {
    const segs = runs === rec.frame.runs && rec.segs ? rec.segs : segmentsOf(runs, this.bodyFs(), null);
    const body = { fs: this.bodyFs() || undefined, bold: this.bodyBold() };
    this.capture(rec, segs, rec.frame.width, rec.frame.height, 'text');
    const res = layoutPage(segs, this.ctxFor(rec, 'text', rec.frame.height, body));
    if (scrub) {
      const dropped = [];
      for (const b of res.body) b.text = scrubText(b.text, this.words, dropped);
      res.body = res.body.filter((b) => b.text);
      this.noteDropped(rec.p, dropped);
    }
    return this.tag(res, rec.p, 'text');
  }

  layoutOcr(rec, o) {
    this.useOcrStats(o, true);
    if (o.conf < LOW_CONF) this.warn('ocr-low-confidence', rec.p, `Page ${rec.p} was hard to read; some words may be wrong.`);
    const sizes = [];
    for (const s of o.segs) for (let i = 0; i < Math.min(s.chars, 200); i += 10) sizes.push(s.fs);
    sizes.sort((a, b) => a - b);
    const body = { fs: sizes.length ? sizes[sizes.length >> 1] : undefined, bold: false };
    this.keys[rec.p] = bandSegments(o.segs, rec.vpH, body.fs).map((c) => ({ side: c.side, key: c.key }));
    this.capture(rec, o.segs, rec.vpW, rec.vpH, 'ocr');
    const res = layoutPage(o.segs, this.ctxFor(rec, 'ocr', rec.vpH, body));
    return this.tag(res, rec.p, 'ocr');
  }

  tag(res, page, source) {
    if (!res.margins) res.margins = [];
    for (const list of [res.body, res.headers, res.footers, res.notes, res.margins]) {
      for (const b of list) {
        b.page = page;
        b.source = source;
        if (source !== 'ocr') delete b.conf;
        else if (typeof b.conf === 'number') b.conf = Math.round(b.conf * 1000) / 1000;
      }
    }
    return res;
  }

  /* ---------- streaming, with paragraphs joined across page breaks ---------- */

  emit(b) {
    this.blocks.push(b);
    if (this.opts.onBlock) {
      try {
        this.opts.onBlock(b);
      } catch (e) {
        /* the app's callback must not break extraction */
      }
    }
  }

  flushHeld() {
    if (this.held) this.emit(this.held);
    for (const b of this.heldTail) this.emit(b);
    this.held = null;
    this.heldTail = [];
  }

  // Order on the page: running heads, then body blocks with each margin note just
  // before the block it sits beside, then running feet and footnotes. A paragraph that
  // runs on to the next page is held back (with what follows it) until it ends.
  emitPage(res) {
    const body = res.body;
    const margins = (res.margins || []).map((m) => {
      const at = m.at;
      delete m.at;
      return { b: m, at };
    });
    const tail = [...res.footers, ...res.notes];
    let start = 0;
    if (this.held) {
      if (body.length && canMerge(this.held, body[0])) {
        const a = this.held;
        const b = body[0];
        a.text = joinLines(a.text, b.text, this.words);
        if (a.source !== b.source) a.source = 'ocr';
        if (typeof b.conf === 'number') a.conf = typeof a.conf === 'number' ? Math.min(a.conf, b.conf) : b.conf;
        start = 1;
        if (body.length === 1) {
          // Still open: this page held only the continuation.
          this.heldTail.push(...res.headers, ...margins.map((m) => m.b), ...tail);
          if (!isOpen(a)) this.flushHeld();
          return;
        }
      }
      this.flushHeld();
    }
    for (const b of res.headers) this.emit(b);
    for (const m of margins) if (m.at < start) this.emit(m.b);
    for (let i = start; i < body.length; i++) {
      for (const m of margins) if (m.at === i) this.emit(m.b);
      if (i === body.length - 1 && isOpen(body[i])) {
        this.held = body[i];
        this.heldTail = [...margins.filter((m) => m.at >= body.length).map((m) => m.b), ...tail];
        return;
      }
      this.emit(body[i]);
    }
    for (const m of margins) if (m.at >= body.length) this.emit(m.b);
    for (const b of tail) this.emit(b);
  }
}

/* ---------- helpers ---------- */

// For a suspect page, OCR replaces the text layer only when it reads clearly better.
function ocrWins(oq, judge) {
  if (!oq || oq.verdict === 'garbage' || oq.verdict === 'sparse') return false;
  if (judge.badFonts && judge.badFonts.size) return true;
  return oq.score > judge.score + 0.03;
}

const OPEN_END = /[\p{Ll},;\-‐­]$/u;

function isOpen(b) {
  return (b.type === 'p' || b.type === 'li') && !b.skip && OPEN_END.test(b.text);
}

function canMerge(a, b) {
  return isOpen(a) && b.type === 'p' && !b.skip && /^[\p{L}\d"“'‘(]/u.test(b.text);
}

// Drops junk tokens from text we keep but don't fully trust.
function scrubText(text, words, dropped) {
  const out = [];
  for (const t of text.split(' ')) {
    if (t && isJunkToken(t, words)) dropped.push(t);
    else if (t) out.push(t);
  }
  return out.join(' ');
}

const BAD_TITLE = /^(?:untitled|document\d*|title|none|null|unknown|print|slide\s*\d+|powerpoint presentation|microsoft word.*|layout \d+|page \d+)$/i;

export function cleanTitle(t, words) {
  if (typeof t !== 'string') return '';
  let s = t.replace(/[\u0000-\u001f�]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^microsoft (?:word|powerpoint|excel) - /i, '');
  s = s.replace(/\.(?:docx?|pdf|pptx?|xlsx?|odt|rtf|txt|tex|indd|qxd|pages|key)$/i, '').trim();
  if (!s || s.length > 200 || BAD_TITLE.test(s)) return '';
  if (/^[\w.-]*[\\/]/.test(s) || /^[\w-]+_[\w-]+$/.test(s)) return '';
  const toks = s.split(' ');
  let junk = 0;
  for (const tok of toks) if (core(tok) && isJunkToken(tok, words)) junk++;
  if (junk > toks.length / 3) return '';
  return s;
}
