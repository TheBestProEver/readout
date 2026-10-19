// OCR preprocessing on 8-bit gray pixels. No DOM: runs in a worker, on the main
// thread or in Node. 'auto' (measured on synthetic photos, scans and slides):
// invert dark backgrounds, 3x3 denoise, flatten the background (shadows, uneven
// light), then scale so glyphs are about 30 px tall. Tesseract binarizes the
// result itself (Sauvola), which beat every JS thresholding tried.

export const TARGET_GLYPH = 30; // px; Tesseract's LSTM reads best around here
export const MAX_UPSCALE = 4;
export const MAX_OCR_AREA = 14e6; // px handed to Tesseract per image (memory and time)

export function grayFromRGBA(data, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29 + 128) >> 8;
  return g;
}

export function histogram(g, step = 1) {
  const h = new Uint32Array(256);
  for (let i = 0; i < g.length; i += step) h[g[i]]++;
  return h;
}

export function percentile(hist, p) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  const want = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) if ((acc += hist[i]) >= want) return i;
  return 255;
}

export function invert(g) {
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = 255 - g[i];
  return out;
}

// 3x3 box blur (edges average their valid neighbours): cheap denoise for sensor
// noise and JPEG blocks before thresholding.
export function box3(g, w, h) {
  const tmp = new Uint16Array(w * h);
  const cnt = new Uint8Array(w);
  for (let x = 0; x < w; x++) cnt[x] = (x > 0) + 1 + (x < w - 1);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) tmp[r + x] = g[r + x] + (x > 0 ? g[r + x - 1] : 0) + (x < w - 1 ? g[r + x + 1] : 0);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    const up = y > 0 ? r - w : -1;
    const dn = y < h - 1 ? r + w : -1;
    const ny = 1 + (up >= 0) + (dn >= 0);
    for (let x = 0; x < w; x++) {
      const s = tmp[r + x] + (up >= 0 ? tmp[up + x] : 0) + (dn >= 0 ? tmp[dn + x] : 0);
      const n = ny * cnt[x];
      out[r + x] = (s + (n >> 1)) / n;
    }
  }
  return out;
}

// Background flattening: estimate the paper brightness with block maxima (of 2x2
// means, which ignores single bright specks), grow it over the text, smooth it,
// then divide. Removes shadows and uneven light. Finally stretch so the darkest
// 0.5% is black and the paper white.
export function flatten(g, w, h, block = 0) {
  const B = block || Math.max(8, Math.round(Math.min(w, h) / 60));
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      const y1 = Math.min(h - 1, (by + 1) * B);
      const x1 = Math.min(w - 1, (bx + 1) * B);
      for (let y = by * B; y < y1; y += 2) {
        const r = y * w;
        for (let x = bx * B; x < x1; x += 2) {
          const v = (g[r + x] + g[r + x + 1] + g[r + w + x] + g[r + w + x + 1]) >> 2;
          if (v > m) m = v;
        }
      }
      bg[by * bw + bx] = m || 255;
    }
  }
  const pass = (src, max) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= bh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= bw) continue;
            const v = src[yy * bw + xx];
            if (max) {
              if (v > acc) acc = v;
            } else {
              acc += v;
              n++;
            }
          }
        }
        out[y * bw + x] = max ? acc : acc / n;
      }
    }
    return out;
  };
  bg = pass(pass(pass(bg, true), false), false);
  const out = new Uint8ClampedArray(w * h);
  const fx0 = new Int32Array(w);
  const fx1 = new Int32Array(w);
  const ftx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
    fx0[x] = Math.floor(fx);
    fx1[x] = Math.min(bw - 1, fx0[x] + 1);
    ftx[x] = fx - fx0[x];
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    const r0 = y0 * bw;
    const r1 = y1 * bw;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const tx = ftx[x];
      const top = bg[r0 + fx0[x]] * (1 - tx) + bg[r0 + fx1[x]] * tx;
      const bot = bg[r1 + fx0[x]] * (1 - tx) + bg[r1 + fx1[x]] * tx;
      const b = top * (1 - ty) + bot * ty;
      out[r + x] = (g[r + x] * 255) / (b > 1 ? b : 1);
    }
  }
  const lo = percentile(histogram(out), 0.005);
  const hi = 250;
  if (hi - lo > 20) {
    const k = 255 / (hi - lo);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  }
  return out;
}

// Sauvola adaptive threshold with integral images, O(N). 0 = ink, 255 = paper.
export function sauvola(g, w, h, win = 0, k = 0.3) {
  const r = Math.max(7, (win || Math.round(Math.min(w, h) / 50)) >> 1);
  const W = w + 1;
  const S = new Float64Array(W * (h + 1));
  const Q = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      rs += v;
      rq += v * v;
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + rs;
      Q[(y + 1) * W + x + 1] = Q[y * W + x + 1] + rq;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const n = (yb - ya) * (xb - xa);
      const s = S[yb * W + xb] - S[ya * W + xb] - S[yb * W + xa] + S[ya * W + xa];
      const q = Q[yb * W + xb] - Q[ya * W + xb] - Q[yb * W + xa] + Q[ya * W + xa];
      const m = s / n;
      const sd = Math.sqrt(Math.max(0, q / n - m * m));
      out[y * w + x] = g[y * w + x] > m * (1 + k * (sd / 128 - 1)) ? 255 : 0;
    }
  }
  return out;
}

// Median height of glyph-sized connected components in a binary image (0 = ink).
// Specks are ignored (under 5 px tall or 12 px in area): counting them once forced
// a 4x upscale, a minute of OCR and 96% word errors.
export function glyphHeight(bin, w, h) {
  return glyphStats(bin, w, h).height;
}

// { height, count }: the median letter height and how many letter-like
// components there are (roughly the number of characters).
export function glyphStats(bin, w, h) {
  const lab = new Int32Array(w * h);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bin[i]) continue;
      const up = y ? lab[i - w] : 0;
      const left = x ? lab[i - 1] : 0;
      if (!up && !left) {
        if (next >= parent.length) {
          const p = new Int32Array(parent.length * 2);
          p.set(parent);
          parent = p;
        }
        parent[next] = next;
        lab[i] = next++;
      } else if (up && left) {
        const a = find(up);
        const b = find(left);
        lab[i] = a < b ? a : b;
        if (a !== b) parent[a > b ? a : b] = a < b ? a : b;
      } else lab[i] = up || left;
    }
  }
  // bounding boxes per root: top, bottom, left, right, area
  const top = new Int32Array(next).fill(-1);
  const bot = new Int32Array(next);
  const lft = new Int32Array(next);
  const rgt = new Int32Array(next);
  const area = new Int32Array(next);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = lab[y * w + x];
      if (!l) continue;
      const r = find(l);
      if (top[r] < 0) {
        top[r] = y;
        lft[r] = x;
        rgt[r] = x;
      }
      bot[r] = y;
      if (x < lft[r]) lft[r] = x;
      if (x > rgt[r]) rgt[r] = x;
      area[r]++;
    }
  }
  const comps = [];
  for (let r = 1; r < next; r++) {
    if (top[r] < 0) continue;
    const hh = bot[r] - top[r] + 1;
    const ww = rgt[r] - lft[r] + 1;
    if (hh >= 5 && hh <= h / 10 && ww <= hh * 3 && ww >= 2 && area[r] >= 12) comps.push({ t: top[r], b: bot[r], l: lft[r], r: rgt[r], h: hh });
  }
  return textStats(comps);
}

// Median height of the components that sit in a row of text: each needs a
// neighbour of similar height just to its right, overlapping it vertically.
// Noise, texture and photos have few; letters almost all do. Returns 0 when the
// image doesn't look like text, so nothing gets enlarged for no reason.
export function textHeight(comps) {
  return textStats(comps).height;
}

export function textStats(comps) {
  if (comps.length < 20) return { height: 0, count: 0, comps: [] };
  comps.sort((a, b) => a.l - b.l);
  const ls = Float64Array.from(comps, (c) => c.l);
  const hs = [];
  const text = [];
  for (const c of comps) {
    // first component starting at or after this one's right edge, minus a little overlap
    let lo = 0;
    let hi = comps.length;
    const from = c.r - 0.3 * c.h;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    const to = c.r + 1.2 * c.h;
    for (let k = lo, n = 0; k < comps.length && ls[k] <= to && n < 400; k++, n++) {
      const d = comps[k];
      if (d === c || d.h > c.h * 2.2 || c.h > d.h * 2.2) continue;
      const overlap = Math.min(c.b, d.b) - Math.max(c.t, d.t);
      if (overlap >= 0.5 * Math.min(c.h, d.h)) {
        hs.push(c.h);
        text.push(c);
        break;
      }
    }
  }
  if (hs.length < 20 || hs.length < 0.35 * comps.length) return { height: 0, count: 0, comps: [] };
  hs.sort((a, b) => a - b);
  return { height: hs[hs.length >> 1], count: hs.length, comps: text };
}

// Separable resampling: Catmull-Rom when enlarging, an area-like (widened
// triangle) filter when shrinking.
function weights(src, dst) {
  const scale = dst / src;
  const down = scale < 1;
  const support = down ? 1 / scale : 2;
  const kernel = down
    ? (t) => {
        const a = Math.abs(t) * scale;
        return a < 1 ? 1 - a : 0;
      }
    : (t) => {
        const a = Math.abs(t);
        if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
        if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
        return 0;
      };
  const n = Math.ceil(support) * 2 + 1;
  const idx = new Int32Array(dst * n);
  const wt = new Float32Array(dst * n);
  for (let i = 0; i < dst; i++) {
    const c = (i + 0.5) / scale - 0.5;
    const first = Math.floor(c - support) + 1;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const s = first + k;
      const v = kernel(s - c);
      idx[i * n + k] = s < 0 ? 0 : s >= src ? src - 1 : s;
      wt[i * n + k] = v;
      sum += v;
    }
    for (let k = 0; k < n; k++) wt[i * n + k] /= sum || 1;
  }
  return { n, idx, wt };
}

export function resize(g, w, h, nw, nh) {
  if (nw === w && nh === h) return g;
  const X = weights(w, nw);
  const Y = weights(h, nh);
  const tmp = new Float32Array(nw * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < nw; x++) {
      let s = 0;
      const o = x * X.n;
      for (let k = 0; k < X.n; k++) s += g[r + X.idx[o + k]] * X.wt[o + k];
      tmp[y * nw + x] = s;
    }
  }
  const out = new Uint8ClampedArray(nw * nh);
  for (let y = 0; y < nh; y++) {
    const o = y * Y.n;
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let k = 0; k < Y.n; k++) s += tmp[Y.idx[o + k] * nw + x] * Y.wt[o + k];
      out[y * nw + x] = s;
    }
  }
  return out;
}

// A centred window of at most `max` pixels, for estimates that don't need the
// whole page (the glyph height of a 12 MP photo).
export function crop(g, w, h, max) {
  if (w * h <= max) return { g, w, h, x0: 0, y0: 0 };
  const f = Math.sqrt(max / (w * h));
  const cw = Math.max(1, Math.min(w, Math.round(w * f)));
  const ch = Math.max(1, Math.min(h, Math.round(max / cw)));
  const x0 = (w - cw) >> 1;
  const y0 = (h - ch) >> 1;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(g.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw);
  return { g: out, w: cw, h: ch, x0, y0 };
}

// Boxes of the letter-like components, flat [x0, y0, x1, y1, ...], scaled by k
// and shifted: where the text is, independent of what Tesseract makes of it.
function boxesOf(comps, k, dx, dy) {
  const out = new Float32Array(comps.length * 4);
  comps.forEach((c, i) => {
    out[i * 4] = (c.l + dx) * k;
    out[i * 4 + 1] = (c.t + dy) * k;
    out[i * 4 + 2] = (c.r + 1 + dx) * k;
    out[i * 4 + 3] = (c.b + 1 + dy) * k;
  });
  return out;
}

const GLYPH_AREA = 4e6; // px the glyph estimate looks at
const TEXT_MAP_AREA = 2.5e6;

// Where the letters are on the page (for the OCR coverage check): the components
// the glyph estimate found when its window was most of the image (a 300 dpi
// book page loses only its margins), else the same on a copy shrunk to
// TEXT_MAP_AREA (phone photos).
export function textMap(g, w, h, seen) {
  if (seen && seen.area >= 0.8 * w * h) return boxesOf(seen.comps, 1, seen.x0, seen.y0);
  const f = Math.sqrt(TEXT_MAP_AREA / (w * h));
  const sw = Math.max(1, Math.round(w * f));
  const sh = Math.max(1, Math.round(h * f));
  const small = resize(g, w, h, sw, sh);
  const gs = glyphStats(sauvola(small, sw, sh, Math.round(Math.min(sw, sh) / 50)), sw, sh);
  return boxesOf(gs.comps, w / sw, 0, 0);
}

// Scale factor that brings glyphs to TARGET_GLYPH px: enlarge small text (up to
// 4x), shrink very large text for speed, and keep the result under MAX_OCR_AREA.
export function scaleFor(glyph, w, h) {
  let f = 1;
  if (glyph && glyph < TARGET_GLYPH * 0.8) f = Math.min(MAX_UPSCALE, TARGET_GLYPH / glyph);
  else if (glyph > TARGET_GLYPH * 1.8) f = (TARGET_GLYPH * 1.1) / glyph;
  if (w * h * f * f > MAX_OCR_AREA) f = Math.sqrt(MAX_OCR_AREA / (w * h));
  return f;
}

// Light text on dark panels inside a light page (a dark title bar, a button, the dark side of
// a flyer): flattening takes the brightest pixels for the paper, which there are the letters,
// and wipes them out. Such panels are turned light first. A panel is a run of blocks whose
// median is dark (at least 3 of them, or one with light strokes in it), so the inside of a
// big black letter (dark, but with nothing light in it) is left alone.
// Returns { g, blocks } with the panels inverted, or null when there are none.
export function localInvert(g, w, h) {
  const paper = percentile(histogram(g, 7), 0.9);
  if (paper < 140) return null;
  const B = Math.max(16, Math.round(Math.min(w, h) / 24));
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const med = new Uint8Array(bw * bh);
  const hi = new Uint8Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      const y1 = Math.min(h, (by + 1) * B);
      const x1 = Math.min(w, (bx + 1) * B);
      for (let y = by * B; y < y1; y += 2) {
        const r = y * w;
        for (let x = bx * B; x < x1; x += 2) {
          hist[g[r + x]]++;
          n++;
        }
      }
      let acc = 0;
      let m = -1;
      let q = -1;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (m < 0 && acc >= n * 0.5) m = v;
        if (q < 0 && acc >= n * 0.97) q = v;
      }
      med[by * bw + bx] = m;
      hi[by * bw + bx] = q;
    }
  }
  const dark = (i) => med[i] < 0.45 * paper;
  const seen = new Uint8Array(bw * bh);
  const flip = new Uint8Array(bw * bh);
  let count = 0;
  for (let i = 0; i < bw * bh; i++) {
    if (seen[i] || !dark(i)) continue;
    const comp = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      const x = k % bw;
      const y = (k / bw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const j = yy * bw + xx;
        if (!seen[j] && dark(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const light = comp.filter((k) => hi[k] > 0.65 * paper).length;
    // empty stretches of the panel itself: blocks with nothing light in them at all
    const solid = comp.filter((k) => hi[k] < 0.45 * paper).length;
    // a whole-page dark area is the page itself (handled by inverting everything)
    if (comp.length >= 0.6 * bw * bh) continue;
    // a panel has light strokes and plain dark margins; big bold letters have no margins
    if (comp.length >= 4 && light >= 1 && solid >= Math.max(2, 0.2 * comp.length)) {
      for (const k of comp) flip[k] = 1;
      count += comp.length;
    }
  }
  if (!count) return null;
  const out = new Uint8ClampedArray(g);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!flip[by * bw + bx]) continue;
      const y1 = Math.min(h, (by + 1) * B);
      const x1 = Math.min(w, (bx + 1) * B);
      for (let y = by * B; y < y1; y++) {
        const r = y * w;
        for (let x = bx * B; x < x1; x++) out[r + x] = 255 - out[r + x];
      }
    }
  }
  return { g: out, blocks: count };
}

// The 'auto' pipeline. Returns the prepared gray image and what was done.
// kind 'screenshot' skips the denoise: UI text is sharp and small.
export function preprocess(g, w, h, { kind = 'photo' } = {}) {
  const info = {};
  info.median = percentile(histogram(g, 7), 0.5);
  let out = g;
  if (info.median < 110) {
    out = invert(out);
    info.inverted = true;
  }
  const panels = localInvert(out, w, h);
  if (panels) {
    out = panels.g;
    info.panels = panels.blocks;
  }
  if (kind !== 'screenshot') out = box3(out, w, h);
  out = flatten(out, w, h);
  const c = crop(out, w, h, GLYPH_AREA);
  const gs = glyphStats(sauvola(c.g, c.w, c.h, Math.round(Math.min(w, h) / 50)), c.w, c.h);
  info.glyph = gs.height;
  // letters in the whole image (the estimate saw a centred window of it)
  info.glyphs = Math.round((gs.count * w * h) / (c.w * c.h));
  // text boxes in this image's pixels (before scaling), when there is text
  const text = !gs.height ? new Float32Array(0) : textMap(out, w, h, { area: c.w * c.h, x0: c.x0, y0: c.y0, comps: gs.comps });
  const f = scaleFor(info.glyph, w, h);
  info.scale = Math.round(f * 1000) / 1000;
  if (f !== 1) {
    const nw = Math.max(1, Math.round(w * f));
    const nh = Math.max(1, Math.round(h * f));
    out = resize(out, w, h, nw, nh);
    return { g: out, w: nw, h: nh, scale: nw / w, info, text };
  }
  return { g: out, w, h, scale: 1, info, text };
}

// The plain image at a given scale (the 'raw' rung of the retry ladder).
export function scaled(g, w, h, f) {
  if (!f || Math.abs(f - 1) < 1e-3) return { g, w, h, scale: 1 };
  const nw = Math.max(1, Math.round(w * f));
  const nh = Math.max(1, Math.round(h * f));
  return { g: resize(g, w, h, nw, nh), w: nw, h: nh, scale: nw / w };
}

// Binary PGM: Leptonica reads it directly, so there is no PNG encode/decode.
export function toPGM(g, w, h) {
  const head = `P5\n${w} ${h}\n255\n`;
  const out = new Uint8Array(head.length + g.length);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  out.set(g, head.length);
  return out;
}

// Rows to cut a tall image at (long screenshots): each piece at most maxH rows,
// cut where a row has the least ink, so no line of text is split.
export function cutRows(g, w, h, maxH) {
  if (h <= maxH) return [[0, h]];
  const ink = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    let s = 0;
    let q = 0;
    for (let x = 0; x < w; x++) {
      const v = g[r + x];
      s += v;
      q += v * v;
    }
    const m = s / w;
    ink[y] = q / w - m * m; // row variance: zero on blank rows
  }
  const cuts = [[0, 0]];
  let y0 = 0;
  while (h - y0 > maxH) {
    const lo = y0 + Math.round(maxH * 0.6);
    const hi = y0 + maxH;
    let best = hi;
    let bv = Infinity;
    for (let y = hi; y >= lo; y--) {
      // prefer the middle of a blank band: score a row by its neighbours too
      const v = ink[y] + 0.5 * ((ink[y - 1] || 0) + (ink[y + 1] || 0));
      if (v < bv - 1e-9) {
        bv = v;
        best = y;
      }
    }
    cuts[cuts.length - 1][1] = best;
    cuts.push([best, 0]);
    y0 = best;
  }
  cuts[cuts.length - 1][1] = h;
  return cuts;
}
