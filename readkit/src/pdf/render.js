// Page rendering for OCR, and the "does this page show anything?" ink check. Rendering
// is the only reliable test: an image operator may draw a blank scan, and vector or
// Type3 text draws no image at all.

const OCR_DPI = 300;
const MAX_SIDE = 4200; // phones: a 4200 px side keeps one RGBA page canvas near 70 MB at worst
const MAX_PIXELS = 12e6;

export function ocrScale(width, height) {
  const s = Math.min(OCR_DPI / 72, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.max(0.5, s);
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function freeCanvas(c) {
  if (!c) return;
  try {
    c.width = 0;
    c.height = 0;
  } catch (e) {
    /* already detached */
  }
}

// Renders a pdf.js page at OCR resolution on a white background. Returns { canvas, scale }.
export async function renderPage(page, { scale, signal } = {}) {
  const vp1 = page.getViewport({ scale: 1 });
  const s = scale || ocrScale(vp1.width, vp1.height);
  const vp = page.getViewport({ scale: s });
  const canvas = makeCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvas, canvasContext: ctx, viewport: vp, background: 'white' });
  const stop = () => task.cancel();
  if (signal) signal.addEventListener('abort', stop, { once: true });
  try {
    await task.promise;
  } catch (e) {
    freeCanvas(canvas);
    if (signal && signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
  }
  return { canvas, scale: s };
}

// Share of the page that is ink (dark pixels), ignoring boxes already covered by the
// text layer. boxes: [{ x0, x1, top, bot }] in page points (scale-1 viewport space).
// Measured on a small copy, so it costs a few milliseconds even for a 300 dpi render.
export function inkShare(canvas, scale, boxes = []) {
  const k = Math.min(1, 700 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const small = makeCanvas(w, h);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const f = scale * k;
  const mask = new Uint8Array(w * h);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0 * f) - 1);
    const x1 = Math.min(w, Math.ceil(b.x1 * f) + 1);
    const y0 = Math.max(0, Math.floor(b.top * f) - 1);
    const y1 = Math.min(h, Math.ceil(b.bot * f) + 1);
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + Math.max(x0, x1));
  }
  let ink = 0;
  let area = 0;
  for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
    if (mask[j]) continue;
    area++;
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (lum < 200) ink++;
  }
  freeCanvas(small);
  return area ? ink / area : 0;
}

// Lines of print on a page whose ink share is too small to count (a chapter's last page:
// one or two short lines on a scan). Print is rows of short dark strokes (letter stems),
// a few pixels to a few dozen tall, running some way across the page; a rule or a logo is
// one long run per row, specks and dust make no band of rows, and a scan's dark borders
// and gutter shadow sit in the margin that is left out.
// gray: luminance bytes (w x h); skip: optional bytes, 1 = ignore (text-layer boxes).
// Returns [{ y0, y1, x0, x1, strokes }] in pixels.
export function findPrintLines(gray, w, h, skip = null) {
  const mx = Math.round(0.03 * w);
  const my = Math.round(0.03 * h);
  const maxRun = Math.max(4, Math.round(0.035 * w));
  const n = new Int32Array(h);
  const lo = new Int32Array(h).fill(w);
  const hi = new Int32Array(h).fill(-1);
  for (let y = my; y < h - my; y++) {
    let run = 0;
    for (let x = mx; x <= w - mx; x++) {
      const i = y * w + x;
      if (x < w - mx && gray[i] < 150 && !(skip && skip[i])) {
        run++;
        continue;
      }
      if (run && run <= maxRun) {
        n[y]++;
        if (x - run < lo[y]) lo[y] = x - run;
        if (x > hi[y]) hi[y] = x;
      }
      run = 0;
    }
  }
  const minH = Math.max(3, Math.round(0.003 * h));
  const maxH = Math.round(0.08 * h);
  const out = [];
  for (let y = my; y < h - my; ) {
    if (n[y] < 3) {
      y++;
      continue;
    }
    // a band: rows with strokes, a one-row break bridged
    let end = y;
    while (end + 1 < h - my && (n[end + 1] >= 2 || (end + 2 < h - my && n[end + 2] >= 3))) end++;
    let strokes = 0;
    let x0 = w;
    let x1 = -1;
    for (let k = y; k <= end; k++) {
      strokes += n[k];
      if (n[k] >= 2) {
        if (lo[k] < x0) x0 = lo[k];
        if (hi[k] > x1) x1 = hi[k];
      }
    }
    const rows = end - y + 1;
    if (rows >= minH && rows <= maxH && strokes >= 3 * rows && x1 - x0 >= 0.03 * w) out.push({ y0: y, y1: end + 1, x0, x1, strokes });
    y = end + 1;
  }
  return out;
}

// findPrintLines on a rendered page, leaving out text-layer boxes (page points).
export function printLines(canvas, scale, boxes = []) {
  const k = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const small = makeCanvas(w, h);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  freeCanvas(small);
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  let skip = null;
  if (boxes.length) {
    skip = new Uint8Array(w * h);
    const f = scale * k;
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor(b.x0 * f) - 1);
      const x1 = Math.min(w, Math.ceil(b.x1 * f) + 1);
      const y0 = Math.max(0, Math.floor(b.top * f) - 1);
      const y1 = Math.min(h, Math.ceil(b.bot * f) + 1);
      for (let y = y0; y < y1; y++) skip.fill(1, y * w + x0, y * w + Math.max(x0, x1));
    }
  }
  return findPrintLines(gray, w, h, skip);
}

// The paper's shade along the edges of a w x h area at (x, y) of a 2D context: the light
// end of the edge pixels (ink touching the edge is dark). Returns a CSS colour.
export function paperShade(ctx, x, y, w, h) {
  const lums = [];
  const take = (d) => {
    for (let i = 0; i < d.length; i += 12) lums.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  };
  try {
    take(ctx.getImageData(x, y, w, 1).data);
    take(ctx.getImageData(x, y + h - 1, w, 1).data);
    take(ctx.getImageData(x, y, 1, h).data);
    take(ctx.getImageData(x + w - 1, y, 1, h).data);
  } catch (e) {
    return '#fff';
  }
  if (!lums.length) return '#fff';
  lums.sort((a, b) => a - b);
  const v = Math.round(lums[Math.floor(0.75 * (lums.length - 1))]);
  return `rgb(${v},${v},${v})`;
}

// What the OCR engine gets: an ImageBitmap when we can hand it over without a copy.
export function toImage(canvas) {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas && canvas.transferToImageBitmap) {
    try {
      return canvas.transferToImageBitmap();
    } catch (e) {
      /* fall through */
    }
  }
  return canvas;
}
