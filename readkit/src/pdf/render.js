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
