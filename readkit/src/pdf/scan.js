// A scanned page that carries the scanner's own invisible OCR layer, read twice: by that
// layer and by our OCR, fused word by word (fuse.js). Margin notes get a second, closer
// OCR pass, then the words the two readings didn't settle go through post-OCR
// correction. Pure: the OCR of crops and the corrector come in as callbacks, so Node
// tests can replay captured readings of a real page.

import { fusePage, toRuns } from './fuse.js';
import { segmentsOf, marginRegions } from './layout.js';
import { correctLines, replaceRegions } from './ocrpage.js';
import { isJunkToken } from './quality.js';

// opts: {
//   layer: text-layer runs (layout frame), [] to read by OCR alone
//   ocr: { lines (ocrLines() of the page, pixels), scale (pixels per point) } | null
//   H: page height (points), docFs: the document's body font size (or null)
//   words, bigrams, corrector (createCorrector() result, or null)
//   crops: async (regions) => OCR lines in page pixels for those regions, or null
// }
// Returns { segs, words, bodyFs, dropped, regions, read }.
export async function fuseScan({ layer, ocr, H, docFs, words, bigrams, corrector, crops }) {
  const ctx = { words, bigrams };
  let lines = ocr ? ocr.lines : [];
  const scale = ocr ? ocr.scale : 1;
  let f = fusePage(layer, lines, scale, ctx);
  // (a scan's text size changes from page to page with the scanner's zoom)
  const bodyFs = pageBodyFs(f.words) || docFs || 10;
  let regions = [];
  let read = [];
  if (ocr && crops) {
    regions = marginRegions(segmentsOf(f.runs, bodyFs, null), bodyFs, H);
    if (regions.length) {
      const extra = await crops(regions);
      // (a strip the second look found nothing in keeps the first reading)
      read = extra ? regions.filter((r) => extra.some((l) => l.words.some((w) => w.box && within(r, w.box, scale)))) : [];
      if (read.length) {
        lines = replaceRegions(lines, read, extra, scale);
        f = fusePage(layer, lines, scale, ctx, { zones: read });
      }
    }
  }
  let kept = f.words;
  const dropped = [];
  if (ocr) {
    const byRow = new Map();
    for (const w of f.words) {
      if (!byRow.has(w.row)) byRow.set(w.row, { words: [], orig: [] });
      const r = byRow.get(w.row);
      r.words.push(w);
      r.orig.push(w);
    }
    // Words both readings agree on are kept as read: the corrector doesn't know names
    // like 'Aarau' or old forms like '&c.'.
    const sure = new Map();
    for (const w of f.words) if (w.from === 'both' && w.conf >= 0.95) sure.set(w, w.text);
    const rows = [...byRow.values()];
    const fixed = await correctLines(rows, corrector, words);
    const back = new Set();
    kept = [];
    for (const r of rows) {
      // (a corrector that re-split a line loses the word boxes: keep that line as read)
      if (r.words.some((w) => w.base === undefined)) {
        kept.push(...r.orig);
        continue;
      }
      for (const w of r.orig) {
        if (sure.has(w) && (w.dropped || w.text !== sure.get(w))) {
          w.text = sure.get(w);
          delete w.dropped;
          back.add(w.text);
        }
        if (!w.dropped && w.text) kept.push(w);
      }
    }
    for (const d of fixed.dropped) if (!back.has(d)) dropped.push(d);
  }
  // Junk is never passed on, except words both readings agree on ('Aarau', 'Zürich').
  kept = kept.filter((w) => {
    if (!isJunkToken(w.text, words) || (w.from === 'both' && w.conf >= 0.95)) return true;
    dropped.push(w.text);
    return false;
  });
  const segs = segmentsOf(toRuns(kept), bodyFs, null);
  return { segs, words: kept, bodyFs, dropped, regions, read };
}

// The page's usual text size: the size most of its letters are set in.
export function pageBodyFs(words) {
  const hist = new Map();
  let total = 0;
  for (const w of words) {
    const n = w.text.length;
    if (n < 2 || !(w.fs > 0)) continue;
    const k = Math.round(w.fs * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + n);
    total += n;
  }
  if (total < 300) return null;
  let best = 0;
  let bestN = 0;
  for (const [k, n] of hist) if (n > bestN) (best = k), (bestN = n);
  return best || null;
}

// Is a box (pixels at `scale`) centred inside a region (points)?
function within(r, b, scale) {
  const cx = (b.x0 + b.x1) / 2 / scale;
  const cy = (b.y0 + b.y1) / 2 / scale;
  return cx >= r.x0 && cx <= r.x1 && cy >= r.top && cy <= r.bot;
}
