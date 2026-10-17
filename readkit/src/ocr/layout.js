// Reading order and paragraphs from OCR line boxes. Pure: no DOM.
// Line = { bbox: {x0,y0,x1,y1}, baseline?: {x0,y0,x1,y1}, size, ... } in image px.

const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

// Page skew in radians from the baselines of wide lines (median slope).
export function skewOf(lines) {
  const slopes = [];
  for (const l of lines) {
    const b = l.baseline;
    if (!b || b.x1 - b.x0 < 3 * (l.size || 10)) continue;
    slopes.push(Math.atan2(b.y1 - b.y0, b.x1 - b.x0));
  }
  return slopes.length >= 3 ? median(slopes) : 0;
}

// Deskewed geometry of each line: x0, x1, top, bot, base, size.
function geometry(lines, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rot = (x, y) => [x * c + y * s, -x * s + y * c];
  return lines.map((l, i) => {
    const size = l.size || Math.max(1, l.bbox.y1 - l.bbox.y0);
    const b = l.baseline && l.baseline.x1 > l.baseline.x0 ? l.baseline : { x0: l.bbox.x0, y0: l.bbox.y1, x1: l.bbox.x1, y1: l.bbox.y1 };
    const [ax, ay] = rot(b.x0, b.y0);
    const [bx, by] = rot(b.x1, b.y1);
    const [lx] = rot(l.bbox.x0, (l.bbox.y0 + l.bbox.y1) / 2);
    const [rx] = rot(l.bbox.x1, (l.bbox.y0 + l.bbox.y1) / 2);
    const base = (ay + by) / 2;
    return { i, x0: Math.min(ax, lx), x1: Math.max(bx, rx), base, top: base - 0.75 * size, bot: base + 0.25 * size, size };
  });
}

// Widest empty interval between projected [a, b] ranges, at least minGap wide.
function widestGap(ranges, minGap) {
  ranges.sort((p, q) => p[0] - q[0]);
  let end = ranges[0][1];
  let best = 0;
  let at = null;
  for (let i = 1; i < ranges.length; i++) {
    const g = ranges[i][0] - end;
    if (g > best && g >= minGap) {
      best = g;
      at = end + g / 2;
    }
    if (ranges[i][1] > end) end = ranges[i][1];
  }
  return at;
}

// Columns sit side by side: most lines of the smaller side have a neighbour at
// the same height on the other side. Chat bubbles alternate instead, and must be
// read top to bottom.
function sideBySide(L, R) {
  const [few, many] = L.length <= R.length ? [L, R] : [R, L];
  let paired = 0;
  for (const a of few) if (many.some((b) => b.top < a.bot && a.top < b.bot)) paired++;
  return few.length >= 2 && paired / few.length >= 0.4;
}

function xycut(segs, depth) {
  if (segs.length <= 1 || depth > 40) return [segs];
  const med = median(segs.map((s) => s.size));
  const gx = widestGap(segs.map((s) => [s.x0, s.x1]), med * 1.2);
  if (gx !== null) {
    const L = segs.filter((s) => s.x1 <= gx);
    const R = segs.filter((s) => s.x1 > gx);
    if (L.length && R.length && sideBySide(L, R)) return [...xycut(L, depth + 1), ...xycut(R, depth + 1)];
  }
  const gy = widestGap(segs.map((s) => [s.top, s.bot]), med * 0.3);
  if (gy !== null) {
    const T = segs.filter((s) => s.bot <= gy);
    const B = segs.filter((s) => s.bot > gy);
    if (T.length && B.length) return [...xycut(T, depth + 1), ...xycut(B, depth + 1)];
  }
  return [byRows(segs)];
}

// Top to bottom, and left to right within a row: pieces of one row (a line
// split at a margin note, or by Tesseract) have baselines a pixel or two apart.
function byRows(segs) {
  const s = segs.slice().sort((a, b) => a.base - b.base);
  const out = [];
  for (let k = 0; k < s.length; ) {
    let j = k + 1;
    while (j < s.length && s[j].base - s[k].base < 0.5 * Math.min(s[j].size, s[k].size)) j++;
    out.push(...s.slice(k, j).sort((a, b) => a.x0 - b.x0));
    k = j;
  }
  return out;
}

// Lines in reading order: [{ i (index into lines), region, x0, x1, base, top, bot, size }].
// Each XY-cut leaf is a region (a column, or a block between gaps).
export function readingOrder(lines) {
  if (!lines.length) return [];
  const segs = geometry(lines, skewOf(lines));
  const out = [];
  xycut(segs, 0).forEach((leaf, region) => {
    for (const s of leaf) out.push({ ...s, region });
  });
  return out;
}

const TERMINAL = /[.!?:;"”’)\]]$/;
export const BULLET = /^[•·‣◦▪▫●○■□➢►▶✓✔❖*]$/u;

// Groups ordered lines (from readingOrder, with .text added) into paragraphs.
// A new paragraph starts at a column change (unless a sentence runs on), a gap
// clearly wider than the usual line pitch, a first-line indent, a size change,
// or after a short line ending a sentence.
export function paragraphs(ordered) {
  if (!ordered.length) return [];
  const byRegion = new Map();
  for (const s of ordered) {
    if (!byRegion.has(s.region)) byRegion.set(s.region, []);
    byRegion.get(s.region).push(s);
  }
  const stats = new Map();
  for (const [r, segs] of byRegion) {
    const pitches = [];
    for (let k = 1; k < segs.length; k++) {
      const p = segs[k].base - segs[k - 1].base;
      if (p > segs[k].size * 0.8 && p < segs[k].size * 3) pitches.push(p);
    }
    stats.set(r, {
      pitch: median(pitches),
      left: median(segs.map((s) => s.x0)),
      right: Math.max(...segs.map((s) => s.x1)),
    });
  }
  const paras = [];
  let cur = null;
  for (const s of ordered) {
    const prev = cur && cur.lines[cur.lines.length - 1];
    let fresh = !prev || s.bullet;
    if (prev && !fresh) {
      const st = stats.get(s.region);
      const runOn = !TERMINAL.test(prev.text) && /^\p{Ll}/u.test(s.text);
      // a new column (it starts higher up): only a sentence running on joins it
      if (s.region !== prev.region && s.base < prev.base + 0.5 * s.size) {
        fresh = !runOn || Math.abs(s.size - prev.size) > 0.25 * prev.size;
      } else {
        // the same column, or a block below the last one
        const pitch = s.base - prev.base;
        const usual = st.pitch || prev.size * 1.5;
        const indent = s.x0 - st.left > Math.max(1.2 * s.size, 0.04 * (st.right - st.left)) && s.x0 - prev.x0 > s.size;
        const short = prev.x1 < st.right - Math.max(3 * prev.size, 0.15 * (st.right - st.left)) && TERMINAL.test(prev.text);
        const sizeJump = Math.abs(s.size - prev.size) > 0.3 * Math.min(s.size, prev.size);
        fresh = pitch > usual * 1.45 || pitch < s.size * 0.5 || (indent && !runOn) || (short && !runOn) || sizeJump;
        // continuation lines of a list item stay with it
        if (fresh && cur.bullet && !sizeJump && pitch <= usual * 1.45 && s.x0 > cur.lines[0].x0 + s.size * 0.5) fresh = false;
      }
    }
    if (fresh) {
      cur = { lines: [], bullet: !!s.bullet };
      paras.push(cur);
    }
    cur.lines.push(s);
  }
  return paras;
}

// Heading level for a paragraph: clearly larger than the body text and short.
export function headingLevel(para, bodySize, maxSize, words) {
  const size = median(para.lines.map((l) => l.size));
  if (para.bullet || para.lines.length > 3 || words > 16 || !bodySize) return 0;
  if (size >= bodySize * 1.6 && size >= maxSize * 0.95) return 1;
  if (size >= bodySize * 1.25) return 2;
  return 0;
}

/* ---------- side notes and wide gaps ---------- */

const ALNUM = /[\p{L}\p{N}]/u;
const LETTERS = /\p{L}/gu;
const baseY = (l) => (l.baseline && l.baseline.x1 > l.baseline.x0 ? (l.baseline.y0 + l.baseline.y1) / 2 : l.bbox.y1);

// Tesseract often reads a margin note and the body line beside it as one line
// ('Two kinds of  THERE were mills of two sorts...'). Old books print such notes
// beside indented body lines, so the body words after the note start at the same
// x on line after line. A run of at least two lines split at one column, with at
// least two clearly wide gaps, is a side note; each of its lines is cut there.
// Gaps far wider than any word space (2.5 line heights) are always cut.
// lines: [{ bbox, baseline?, size, text, conf }], words: [{ text, conf, bbox, line }]
// -> { lines, words }: lines cut into pieces where needed (note pieces get
// { note: run id, side: 'left' | 'right' }), words with new line indexes.
export function splitLines(lines, words) {
  const byLine = lines.map(() => []);
  words.forEach((w, k) => {
    if (byLine[w.line]) byLine[w.line].push(k);
  });
  const info = lines.map((l, i) => {
    const ks = byLine[i].sort((a, b) => words[a].bbox.x0 - words[b].bbox.x0);
    const real = ks.filter((k) => ALNUM.test(words[k].text));
    const size = l.size || Math.max(1, l.bbox.y1 - l.bbox.y0);
    const gaps = [];
    for (let j = 1; j < real.length; j++) gaps.push(words[real[j]].bbox.x0 - words[real[j - 1]].bbox.x1);
    const med = median(gaps.filter((g) => g > 0)) || 0.3 * size;
    const x0 = real.length ? words[real[0]].bbox.x0 : l.bbox.x0;
    const x1 = real.length ? words[real[real.length - 1]].bbox.x1 : l.bbox.x1;
    const cands = [];
    for (let j = 1; j < real.length; j++) {
      const gap = gaps[j - 1];
      if (gap < 0.15 * size) continue;
      const xl = words[real[j - 1]].bbox.x1;
      const xr = words[real[j]].bbox.x0;
      cands.push({ gap, xl, xr, leftW: xl - x0, rightW: x1 - xr, strong: gap >= Math.max(0.9 * size, 2.2 * med), huge: gap >= Math.max(2.5 * size, 3 * med) });
    }
    return { i, ks, size, x0, x1, w: Math.max(1, x1 - x0), base: baseY(l), cands, split: null };
  });
  const order = info.filter((L) => L.ks.length).sort((a, b) => a.base - b.base);
  let notes = 0;
  for (const side of ['left', 'right']) {
    const narrow = (L, c) => (side === 'left' ? c.leftW : c.rightW) < 0.4 * L.w;
    const noteWords = (L, xr) => L.ks.map((k) => words[k]).filter((w) => (side === 'left' ? w.bbox.x0 < xr - 1 : w.bbox.x0 >= xr - 1));
    const finish = (run) => {
      // a weakly cut line at either end of the run is a body line that happens
      // to have a word boundary at the column ('river. Thus | the river')
      const anchor = (it) => !it.c || it.c.strong;
      let a = 0;
      let b = run.items.length - 1;
      while (a <= b && !anchor(run.items[a])) a++;
      while (b >= a && !anchor(run.items[b])) b--;
      run.items = run.items.slice(a, b + 1);
      const cut = run.items.filter((it) => it.c);
      if (cut.length < 2 || cut.filter((it) => it.c.strong).length < 2) return;
      // the note is words, not list numbers; the text beside it is prose
      const letters = cut.reduce((n, it) => n + noteWords(it.L, it.c.xr).reduce((m, w) => m + (w.text.match(LETTERS) || []).length, 0), 0);
      if (letters < 6 * cut.length) return;
      if (cut.some((it) => (side === 'left' ? it.c.rightW : it.c.leftW) < 0.5 * it.L.w)) return;
      // and other body lines run right across the note's column (a table has none)
      const inRun = new Set(run.items.map((it) => it.L));
      const lo = Math.min(...cut.map((it) => it.L.x0));
      const hi = Math.max(...cut.map((it) => it.L.x1));
      const across = order.filter((L) => !inRun.has(L) && (side === 'left' ? L.x0 <= lo + L.size && L.x1 >= run.X + 3 * L.size : L.x0 <= run.X - 3 * L.size && L.x1 >= hi - L.size));
      if (across.length < 2) return;
      const id = notes++;
      for (const it of cut) if (!it.L.split) it.L.split = { xr: it.c.xr, side, note: id };
    };
    let open = [];
    for (const L of order) {
      const tol = 0.4 * L.size;
      const next = [];
      for (const run of open) {
        const last = run.items[run.items.length - 1].L;
        if (L.base - last.base > 2.2 * L.size) continue;
        const c = L.cands.find((x) => narrow(L, x) && Math.abs(x.xr - run.X) <= tol);
        if (c) run.items.push({ L, c });
        else if (side === 'left' && Math.abs(L.x0 - run.X) <= tol) run.items.push({ L, c: null }); // an indented line beside nothing
        else if (side === 'left' ? L.x1 < run.X - tol && L.x0 > run.edge - 2 * L.size : L.x0 > run.X - tol && L.x1 < run.edge + 2 * L.size) {
          // a line of the note alone; kept only between two cut lines
          run.items.push({ L, c: { xr: side === 'left' ? run.X : L.x0, strong: false, whole: true } });
        } else if (side === 'left' ? L.x1 <= run.X || L.x0 > run.X + tol : L.x0 >= run.X || L.x1 < run.X - tol) {
          // a line of another column: the run goes on past it
          next.push(run);
          continue;
        } else continue;
        next.push(run);
      }
      for (const run of open) if (!next.includes(run)) finish(run);
      for (const c of L.cands) {
        if (c.strong && narrow(L, c) && !next.some((r) => Math.abs(c.xr - r.X) <= tol && r.items[r.items.length - 1].L === L)) next.push({ X: c.xr, edge: side === 'left' ? L.x0 : L.x1, items: [{ L, c }] });
      }
      open = next;
    }
    open.forEach(finish);
  }
  for (const L of info) {
    if (L.split) continue;
    const c = L.cands.find((x) => x.huge);
    if (c) L.split = { xr: c.xr, side: null, note: null };
  }
  const outLines = [];
  const outWords = [];
  const piece = (l, ws, extra) => {
    const li = outLines.length;
    const x0 = Math.min(...ws.map((w) => w.bbox.x0));
    const x1 = Math.max(...ws.map((w) => w.bbox.x1));
    let baseline = null;
    if (l.baseline && l.baseline.x1 > l.baseline.x0) {
      const b = l.baseline;
      const at = (x) => b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0);
      baseline = { x0, y0: at(x0), x1, y1: at(x1) };
    }
    const real = ws.filter((w) => ALNUM.test(w.text));
    outLines.push({
      ...l,
      text: ws.map((w) => w.text).join(' '),
      conf: (real.length ? real : ws).reduce((a, w) => a + w.conf, 0) / (real.length || ws.length),
      bbox: { x0, y0: l.bbox.y0, x1, y1: l.bbox.y1 },
      baseline,
      ...extra,
    });
    for (const w of ws) outWords.push({ ...w, line: li });
  };
  for (const L of info) {
    const l = lines[L.i];
    if (!L.ks.length) continue;
    const ws = L.ks.map((k) => words[k]);
    if (!L.split) {
      // lines that stay whole keep what Tesseract said about them
      for (const w of ws) outWords.push({ ...w, line: outLines.length });
      outLines.push(l);
      continue;
    }
    const left = ws.filter((w) => w.bbox.x0 < L.split.xr - 1);
    const right = ws.filter((w) => w.bbox.x0 >= L.split.xr - 1);
    const note = (part) => (L.split.side === part ? { note: L.split.note, side: part } : {});
    if (left.length) piece(l, left, note('left'));
    if (right.length) piece(l, right, note('right'));
  }
  return { lines: outLines, words: outWords };
}

// Reading order and paragraphs, with side notes kept out of the body: the body
// goes through the XY-cut and paragraphs(); each note becomes a paragraph of
// its own ({ note: true }), placed before the body paragraph it starts beside
// when it starts at that paragraph's first lines, else after it.
//   decorate(i) -> extra fields for line i ({ text, bullet }), or null to leave it out
export function layoutParagraphs(lines, decorate) {
  const body = [];
  const groups = new Map();
  lines.forEach((l, i) => {
    if (l.note == null) body.push(i);
    else {
      if (!groups.has(l.note)) groups.set(l.note, []);
      groups.get(l.note).push(i);
    }
  });
  const ordered = (idx) => {
    const sub = readingOrder(idx.map((i) => lines[i]));
    const out = [];
    for (const s of sub) {
      const extra = decorate(idx[s.i]);
      if (extra) out.push({ ...s, ...extra, i: idx[s.i] });
    }
    return out;
  };
  const paras = paragraphs(ordered(body));
  for (const idx of groups.values()) {
    const segs = ordered(idx);
    if (!segs.length) continue;
    const note = { lines: segs.sort((a, b) => a.base - b.base), bullet: false, note: true };
    const top = note.lines[0];
    // the body paragraph beside the note's first line
    let at = -1;
    let pos = 0;
    let best = Infinity;
    paras.forEach((p, pi) => {
      if (p.note) return;
      p.lines.forEach((s, k) => {
        const d = Math.abs(s.base - top.base);
        if (d < best && d < 1.5 * Math.max(s.size, top.size)) {
          best = d;
          at = pi;
          pos = k;
        }
      });
    });
    if (at < 0) {
      at = paras.findIndex((p) => p.lines[0].base > top.base);
      paras.splice(at < 0 ? paras.length : at, 0, note);
    } else paras.splice(pos <= 1 ? at : at + 1, 0, note);
  }
  return paras;
}

export { median };
