// What the pixels of a screenshot say about its text, beyond the words: flat panels (cards,
// dialogs, popups), which panel lies on top of another (an extension popup or a menu over the
// page: its text is not the page's), and bars under words (the selected tab's indicator, a
// link's underline).
//
//   panels(img)            -> [{ box: { x0, y0, x1, y1 }, color: [r, g, b], area, full, overlay }]
//   underlines(img, words) -> per word: { y, x0, x1 } (the bar under it) or null
//   img = { data: RGBA bytes, width, height } (an ImageData); boxes in its pixels
//
// Panels are found on a grid of small cells: a cell is flat when its pixels are all one colour;
// flat cells of one colour that touch form a panel. A panel is "full" when nearly every row and
// column of its box reaches the box's edges (a rectangle, text and all, nothing laid over it).
// An overlay is a full panel whose box crosses another panel's box (neither inside the other)
// where the other panel does not show: the other is cut by it, so it lies on top.
// Pure: runs in Node (tests feed it plain arrays).

const diff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

export function panels(img, { flat = 10, join = 6, minShare = 0.012 } = {}) {
  const { data, width: W, height: H } = img;
  if (!data || !W || !H) return [];
  const c = Math.max(2, Math.round(Math.max(W, H) / 640));
  const gw = Math.floor(W / c);
  const gh = Math.floor(H / c);
  const n = gw * gh;
  const col = new Uint8Array(n * 3);
  const isFlat = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let r0 = 255, g0 = 255, b0 = 255, r1 = 0, g1 = 0, b1 = 0, sr = 0, sg = 0, sb = 0;
      for (let y = gy * c; y < gy * c + c; y++) {
        let p = (y * W + gx * c) * 4;
        for (let x = 0; x < c; x++, p += 4) {
          const r = data[p], g = data[p + 1], b = data[p + 2];
          if (r < r0) r0 = r;
          if (r > r1) r1 = r;
          if (g < g0) g0 = g;
          if (g > g1) g1 = g;
          if (b < b0) b0 = b;
          if (b > b1) b1 = b;
          sr += r;
          sg += g;
          sb += b;
        }
      }
      const k = gy * gw + gx;
      const m = c * c;
      col[3 * k] = sr / m;
      col[3 * k + 1] = sg / m;
      col[3 * k + 2] = sb / m;
      isFlat[k] = r1 - r0 <= flat && g1 - g0 <= flat && b1 - b0 <= flat ? 1 : 0;
    }
  }
  // flat cells of one colour that touch (4-neighbours, within `join` of the first cell's colour)
  const label = new Int32Array(n).fill(-1);
  const comps = [];
  const stack = new Int32Array(n);
  for (let k0 = 0; k0 < n; k0++) {
    if (!isFlat[k0] || label[k0] >= 0) continue;
    const seed = [col[3 * k0], col[3 * k0 + 1], col[3 * k0 + 2]];
    const id = comps.length;
    let top = 0;
    stack[top++] = k0;
    label[k0] = id;
    let count = 0, x0 = gw, x1 = -1, y0 = gh, y1 = -1;
    while (top) {
      const k = stack[--top];
      count++;
      const gx = k % gw;
      const gy = (k - gx) / gw;
      if (gx < x0) x0 = gx;
      if (gx > x1) x1 = gx;
      if (gy < y0) y0 = gy;
      if (gy > y1) y1 = gy;
      const nb = [gx > 0 ? k - 1 : -1, gx < gw - 1 ? k + 1 : -1, gy > 0 ? k - gw : -1, gy < gh - 1 ? k + gw : -1];
      for (const j of nb) {
        if (j < 0 || !isFlat[j] || label[j] >= 0) continue;
        if (Math.abs(col[3 * j] - seed[0]) > join || Math.abs(col[3 * j + 1] - seed[1]) > join || Math.abs(col[3 * j + 2] - seed[2]) > join) continue;
        label[j] = id;
        stack[top++] = j;
      }
    }
    comps.push({ id, color: seed, count, gx0: x0, gx1: x1, gy0: y0, gy1: y1 });
  }
  // one panel cut by a divider line (a dialog's header and body) is one panel again: parts of
  // one colour lined up edge to edge with a thin gap between them
  const parent = comps.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const parts = comps.filter((p) => p.count >= 20);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      if (diff(a.color, b.color) > join) continue;
      const gapY = Math.max(b.gy0 - a.gy1, a.gy0 - b.gy1);
      const gapX = Math.max(b.gx0 - a.gx1, a.gx0 - b.gx1);
      const stacked = Math.abs(a.gx0 - b.gx0) <= 2 && Math.abs(a.gx1 - b.gx1) <= 2 && gapY >= 0 && gapY <= 4;
      const side = Math.abs(a.gy0 - b.gy0) <= 2 && Math.abs(a.gy1 - b.gy1) <= 2 && gapX >= 0 && gapX <= 4;
      if (stacked || side) parent[find(b.id)] = find(a.id);
    }
  }
  const merged = new Map();
  for (const p of parts) {
    const r = find(p.id);
    const m = merged.get(r);
    if (!m) merged.set(r, { ...p, id: r });
    else {
      m.count += p.count;
      m.gx0 = Math.min(m.gx0, p.gx0);
      m.gx1 = Math.max(m.gx1, p.gx1);
      m.gy0 = Math.min(m.gy0, p.gy0);
      m.gy1 = Math.max(m.gy1, p.gy1);
    }
  }
  const own = (k) => (label[k] >= 0 ? find(label[k]) : -1);
  const big = [...merged.values()].filter((p) => p.count >= minShare * n && p.gx1 - p.gx0 >= 8 && p.gy1 - p.gy0 >= 8);
  // how much of the box's border rows and columns the panel reaches
  for (const p of big) {
    let rows = 0;
    let cols = 0;
    const slack = 2;
    for (let gy = p.gy0; gy <= p.gy1; gy++) {
      let l = -1;
      let r = -1;
      for (let gx = p.gx0; gx <= p.gx0 + slack + 1 && gx <= p.gx1; gx++) if (own(gy * gw + gx) === p.id) l = gx;
      for (let gx = p.gx1; gx >= p.gx1 - slack - 1 && gx >= p.gx0; gx--) if (own(gy * gw + gx) === p.id) r = gx;
      if (l >= 0 && r >= 0) rows++;
    }
    for (let gx = p.gx0; gx <= p.gx1; gx++) {
      let t = -1;
      let b = -1;
      for (let gy = p.gy0; gy <= p.gy0 + slack + 1 && gy <= p.gy1; gy++) if (own(gy * gw + gx) === p.id) t = gy;
      for (let gy = p.gy1; gy >= p.gy1 - slack - 1 && gy >= p.gy0; gy--) if (own(gy * gw + gx) === p.id) b = gy;
      if (t >= 0 && b >= 0) cols++;
    }
    p.full = Math.min(rows / (p.gy1 - p.gy0 + 1), cols / (p.gx1 - p.gx0 + 1));
  }
  // overlays: a full panel crossing another panel's box, the other not showing inside it
  const inside = (a, b, t = 2) => a.gx0 >= b.gx0 - t && a.gx1 <= b.gx1 + t && a.gy0 >= b.gy0 - t && a.gy1 <= b.gy1 + t;
  for (const p of big) {
    if (p.full < 0.9) continue;
    for (const q of big) {
      if (q === p || inside(p, q) || inside(q, p)) continue;
      const ix0 = Math.max(p.gx0, q.gx0);
      const ix1 = Math.min(p.gx1, q.gx1);
      const iy0 = Math.max(p.gy0, q.gy0);
      const iy1 = Math.min(p.gy1, q.gy1);
      if (ix1 - ix0 < 4 || iy1 - iy0 < 4) continue;
      let mine = 0;
      let theirs = 0;
      for (let gy = iy0; gy <= iy1; gy++) {
        for (let gx = ix0; gx <= ix1; gx++) {
          const l = own(gy * gw + gx);
          if (l === p.id) mine++;
          else if (l === q.id) theirs++;
        }
      }
      const cells = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
      if (theirs <= 0.03 * cells && mine >= 0.3 * cells && q.full < p.full) p.overlay = true;
    }
  }
  return big.map((p) => ({
    box: { x0: p.gx0 * c, y0: p.gy0 * c, x1: (p.gx1 + 1) * c, y1: (p.gy1 + 1) * c },
    color: p.color,
    area: p.count / n,
    full: Math.round(p.full * 100) / 100,
    overlay: !!p.overlay,
  }));
}

// The bar under each word, if there is one: a thin straight stroke of one colour, set off from
// what is above and below it, starting under the word within 2.5 word heights and running at
// least the word's width.
export function underlines(img, boxes) {
  const { data, width: W, height: H } = img;
  const px = (x, y) => {
    const p = (y * W + x) * 4;
    return [data[p], data[p + 1], data[p + 2]];
  };
  const out = [];
  for (const b of boxes) {
    const x0 = Math.max(0, Math.round(b.x0));
    const x1 = Math.min(W - 1, Math.round(b.x1));
    const yb = Math.round(b.y1);
    const h = Math.max(4, b.y1 - b.y0);
    const xc = Math.round((x0 + x1) / 2);
    let found = null;
    if (x1 - x0 >= 3 && yb + 2 < H) {
      const yEnd = Math.min(H - 2, Math.round(yb + 2.5 * h));
      for (let y = yb + 1; y <= yEnd && !found; y++) {
        const cc = px(xc, y);
        if (diff(cc, px(xc, y - 1)) < 50) continue;
        // its thickness
        let t = 1;
        while (y + t < H && t <= 8 && diff(px(xc, y + t), cc) < 30) t++;
        if (t > Math.max(6, 0.35 * h) || y + t >= H || diff(px(xc, y + t), cc) < 40) continue;
        const ym = y + (t >> 1);
        // its length: the same colour left and right of the word's middle
        let l = xc;
        while (l > 0 && diff(px(l - 1, ym), cc) < 30) l--;
        let r = xc;
        while (r < W - 1 && diff(px(r + 1, ym), cc) < 30) r++;
        if (l > x0 + 0.1 * (x1 - x0) || r < x1 - 0.1 * (x1 - x0)) continue;
        // a stroke, not a filled box: the row above the bar differs along its length
        let off = 0;
        let probes = 0;
        for (let x = l; x <= r; x += Math.max(1, Math.floor((r - l) / 16))) {
          probes++;
          if (diff(px(x, y - 1), cc) >= 30) off++;
        }
        if (off < 0.8 * probes) continue;
        found = { y, x0: l, x1: r, thick: t };
      }
    }
    out.push(found);
  }
  return out;
}
