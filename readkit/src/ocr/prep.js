// Turns a decoded image into the gray PGM pieces Tesseract reads. Runs in
// pre.worker.js when the browser has OffscreenCanvas, else on the main thread.
//   open(source, { kind })  -> { width, height, pieces: [[y0, y1]] }   (source pixels)
//   prep(piece, mode)       -> { pgm, w, h, scale, y0, info }          mode 'auto' | 'raw'
// Big photos are shrunk to MAX_DECODE_AREA first. Tall images (long screenshots)
// keep their width and are cut into pieces at blank rows instead.

import { grayFromRGBA, preprocess, scaled, toPGM, cutRows } from './pre.js';

export const MAX_DECODE_AREA = 16e6;
export const MAX_PIECE_H = 4000;
const TALL = 2.2; // height / width above which an image is read in pieces

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Pixels of a region of `src`, drawn at `scale`, as gray.
function grayOf(src, sx, sy, sw, sh, scale) {
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = canvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent PNGs: text on nothing reads as text on white
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const g = grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
  c.width = c.height = 0;
  return { g, w, h };
}

export function createPrep() {
  let src = null;
  let owned = false; // close the bitmap when done only if it is ours
  let base = 1; // decode scale (source px -> working px)
  let pieces = [];
  let kind = 'photo';
  let cache = null; // { piece, gray, auto }

  function close() {
    if (owned && src && src.close) src.close();
    src = null;
    cache = null;
  }

  return {
    async open(source, opts = {}) {
      close();
      kind = opts.kind || 'photo';
      // EXIF orientation is applied, so phone photos come out the right way up.
      owned = source instanceof Blob || !!opts.owned;
      src = source instanceof Blob ? await createImageBitmap(source, { imageOrientation: 'from-image' }) : source;
      const W = src.width;
      const H = src.height;
      if (!W || !H) throw new Error('The image is empty');
      const tall = H > W * TALL;
      base = tall ? Math.min(1, 3000 / W) : Math.min(1, Math.sqrt(MAX_DECODE_AREA / (W * H)));
      const h = Math.round(H * base);
      if (tall || h > MAX_PIECE_H * 1.5) {
        // find blank rows on a narrow copy, then map the cuts back
        const thumbScale = Math.min(1, 400 / W);
        const t = grayOf(src, 0, 0, W, H, thumbScale);
        const maxRows = Math.round((MAX_PIECE_H / base) * thumbScale);
        pieces = cutRows(t.g, t.w, t.h, Math.max(64, maxRows)).map(([a, b]) => [Math.round(a / thumbScale), Math.min(H, Math.round(b / thumbScale))]);
        pieces[pieces.length - 1][1] = H;
      } else pieces = [[0, H]];
      return { width: W, height: H, pieces };
    },

    // Coordinates in the result are working px; divide by `scale` and add `y0`
    // to get back to source px. `text` holds the letter boxes preprocessing
    // found, in source px (flat x0, y0, x1, y1), for the OCR coverage check.
    prep(piece, mode) {
      if (!src) throw new Error('No image is open');
      const [y0, y1] = pieces[piece];
      if (!cache || cache.piece !== piece) cache = { piece, gray: grayOf(src, 0, y0, src.width, y1 - y0, base), auto: null, text: null };
      const { g, w, h } = cache.gray;
      if (!cache.auto) {
        cache.auto = preprocess(g, w, h, { kind });
        const t = cache.auto.text;
        cache.text = new Float32Array(t.length);
        for (let i = 0; i < t.length; i += 2) {
          cache.text[i] = t[i] / base;
          cache.text[i + 1] = t[i + 1] / base + y0;
        }
      }
      // 'small': the prepared image at a third of its size, for display text too big to read
      // ('small-raw': the plain image, when the plain reading did better)
      if (mode === 'small' || mode === 'small-raw') {
        const a = mode === 'small' ? cache.auto : { g, w, h, scale: 1 };
        const s = scaled(a.g, a.w, a.h, mode === 'small' ? 1 / 3 : cache.auto.scale / 3);
        return { pgm: toPGM(s.g, s.w, s.h), w: s.w, h: s.h, scale: base * a.scale * s.scale, y0, info: { ...cache.auto.info, base }, text: new Float32Array(0) };
      }
      const out = mode === 'raw' ? scaled(g, w, h, cache.auto.scale) : cache.auto;
      return { pgm: toPGM(out.g, out.w, out.h), w: out.w, h: out.h, scale: base * out.scale, y0, info: { ...cache.auto.info, base }, text: cache.text.slice() };
    },

    close,
  };
}
