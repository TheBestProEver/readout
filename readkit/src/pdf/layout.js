// Reading order and paragraphs for a PDF page. pdf.js gives positioned text runs in
// content-stream order, which can interleave columns or put running heads anywhere.
// Here: runs -> rows on a shared baseline (superscripts attached) -> segments split at
// wide gaps -> running heads, page numbers and footnotes set aside -> recursive XY-cut
// for columns -> lines -> paragraphs, headings, list items and captions, with
// dictionary-checked de-hyphenation. Pure functions, so they run in Node tests too.

import { known, core } from './quality.js';

/* ---------- small helpers ---------- */

export function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Private-use bullets from Symbol/Wingdings fonts, and real bullet characters.
const PUA_BULLETS = new Set([0xf0b7, 0xf0a7, 0xf0a8, 0xf0d8, 0xf076, 0xf0fc, 0xf06e, 0xf0e0, 0xf0d0, 0xf06c, 0xf0a1, 0xf09f, 0xf0be, 0xf0f0, 0xf0e8]);
const BULLET_CHARS = '•◦▪▫■□●○‣⁃∙➢➤►▶✓✔❖◆◇⦿⦾';
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

// Cleans one text run. Returns { str, dropped } where dropped counts unreadable chars.
export function cleanRun(s) {
  let out = '';
  let dropped = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xad) out += '­'; // soft hyphen: kept for line-end joins, removed later
    else if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) out += ' ';
    else if ((c >= 0x200b && c <= 0x200d) || c === 0xfeff || c === 0x2060) continue;
    else if (c < 32 || (c >= 0x7f && c < 0xa0) || c === 0xfffd) dropped++;
    else if (c >= 0xe000 && c <= 0xf8ff) {
      if (PUA_BULLETS.has(c)) out += '•';
      else dropped++;
    } else if (c >= 0xf0000) dropped++;
    else if (LIGATURES[ch]) out += LIGATURES[ch];
    else out += ch;
  }
  return { str: out, dropped };
}

/* ---------- pdf.js text content -> runs in a y-down reading frame ---------- */

// textContent: from page.getTextContent({ includeMarkedContent: true })
// viewport: page.getViewport({ scale: 1 }); fonts: { [fontName]: { bold } }
// Returns { runs, width, height, dropped, rotatedChars }.
export function runsFromTextContent(textContent, viewport, fonts = {}) {
  const vt = viewport.transform;
  const styles = textContent.styles || {};
  const raw = [];
  const marks = [];
  let dropped = 0;
  let space = false; // a whitespace-only item: the next run starts a new word
  for (const it of textContent.items || []) {
    if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
      marks.push(it.tag === 'Artifact');
      continue;
    }
    if (it.type === 'endMarkedContent') {
      marks.pop();
      continue;
    }
    if (typeof it.str !== 'string' || !it.transform) continue;
    const c = cleanRun(it.str);
    dropped += c.dropped;
    if (!c.str.trim()) {
      if (c.str) space = true;
      continue;
    }
    const m = mul(vt, it.transform);
    const fs = Math.hypot(m[2], m[3]);
    if (!(fs > 0.5) || !isFinite(m[4]) || !isFinite(m[5])) continue;
    const st = styles[it.fontName] || {};
    if (st.vertical) continue;
    const f = fonts[it.fontName] || {};
    raw.push({
      str: c.str,
      ox: m[4],
      oy: m[5],
      angle: Math.atan2(m[1], m[0]),
      fs,
      w: Math.abs(it.width) || fs * 0.5 * c.str.length,
      font: it.fontName || '',
      bold: !!f.bold,
      artifact: marks.includes(true),
      asc: clamp(typeof st.ascent === 'number' && st.ascent > 0 ? st.ascent : 0.8, 0.55, 1.05),
      desc: clamp(typeof st.descent === 'number' && st.descent < 0 ? -st.descent : 0.2, 0.1, 0.4),
      sp: space,
    });
    space = false;
  }
  return toFrame(raw, viewport.width, viewport.height, dropped);
}

// Rotates runs so the dominant text direction reads left to right, and drops runs at
// other angles (margin stamps, rotated axis labels).
export function toFrame(raw, W, H, dropped = 0) {
  const byAngle = [0, 0, 0, 0];
  for (const r of raw) byAngle[snap(r.angle)] += r.str.length;
  let q = 0;
  for (let k = 1; k < 4; k++) if (byAngle[k] > byAngle[q]) q = k;
  const theta = (q * Math.PI) / 2;
  const cos = Math.round(Math.cos(theta));
  const sin = Math.round(Math.sin(theta));
  // Rotate by -theta: x' = x cos + y sin, y' = -x sin + y cos
  const rot = (x, y) => [x * cos + y * sin, -x * sin + y * cos];
  const corners = [rot(0, 0), rot(W, 0), rot(0, H), rot(W, H)];
  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const width = Math.max(...corners.map((c) => c[0])) - minX;
  const height = Math.max(...corners.map((c) => c[1])) - minY;
  const runs = [];
  let rotatedChars = 0;
  for (const r of raw) {
    let d = r.angle - theta;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.09) {
      rotatedChars += r.str.length;
      continue;
    }
    const [x, y] = rot(r.ox, r.oy);
    const x0 = x - minX;
    const base = y - minY;
    if (x0 > width + 2 || x0 + r.w < -2 || base < -2 || base - r.fs > height + 2) {
      dropped += r.str.length; // off the page: hidden text
      continue;
    }
    const run = { str: r.str, x0, x1: x0 + r.w, base, fs: r.fs, top: base - r.fs * r.asc, bot: base + r.fs * r.desc, font: r.font, bold: r.bold, artifact: r.artifact };
    if (r.sp) run.sp = true;
    runs.push(run);
  }
  return { runs, width, height, dropped, rotatedChars };
}

function snap(a) {
  const k = Math.round(a / (Math.PI / 2));
  return ((k % 4) + 4) % 4;
}

/* ---------- runs -> rows -> segments ---------- */

// Text drawn twice with a small offset (a fake-bold trick) would read every word twice.
function dedupe(runs) {
  const seen = new Map();
  const out = [];
  for (const r of runs) {
    const key = r.str;
    const list = seen.get(key);
    if (list && list.some((o) => Math.abs(o.x0 - r.x0) < 0.35 * r.fs && Math.abs(o.base - r.base) < 0.35 * r.fs)) continue;
    if (list) list.push(r);
    else seen.set(key, [r]);
    out.push(r);
  }
  return out;
}

// A big initial letter beside the first lines of a paragraph joins the word it starts.
function mergeDropCaps(runs, bodyFs) {
  const caps = runs.filter((r) => r.fs >= 1.9 * bodyFs && /^\p{Lu}$/u.test(r.str.trim()));
  if (!caps.length) return runs;
  const drop = new Set();
  for (const dc of caps) {
    let best = null;
    for (const r of runs) {
      if (r === dc || r.fs > 1.3 * bodyFs) continue;
      if (r.x0 < dc.x1 - 0.3 * bodyFs || r.x0 > dc.x1 + 2.5 * bodyFs) continue;
      if (r.base < dc.top - 0.2 * bodyFs || r.base > dc.base + 0.5 * bodyFs) continue;
      if (!best || r.base < best.base - 0.1 || (Math.abs(r.base - best.base) < 0.1 && r.x0 < best.x0)) best = r;
    }
    if (best && /^\p{Ll}/u.test(best.str.trim())) {
      best.str = dc.str.trim() + best.str.replace(/^\s+/, '');
      drop.add(dc);
    }
  }
  return runs.filter((r) => !drop.has(r));
}

const SUP_TEXT = /^(?:[\p{N}+\-−=()*†‡§¶,.’'°]{1,6}|st|nd|rd|th|er|re|e|o|a|[b-z]|TM|SM|\p{N}{1,3}[a-z]?)$/u;

// Groups runs into rows on a shared baseline, then attaches small raised or lowered
// runs (superscripts, subscripts) to the row they belong to.
export function buildRows(runs) {
  const sorted = runs.slice().sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows = [];
  for (const r of sorted) {
    let row = null;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 8; k--) {
      const c = rows[k];
      if (r.base - c.base > 1.2 * Math.max(c.fs, r.fs)) break;
      // (a margin note read up close keeps its own rows beside the body's)
      if ((r.zone || '') !== (c.zone || '')) continue;
      // (a small mark far from every run of a row is not part of it: a footnote's number
      // in the left column level with a line of the right column)
      if (r.fs < 0.8 * c.fs && SUP_TEXT.test(r.str.trim()) && !c.runs.some((o) => o.x0 < r.x1 + 2 * c.fs && o.x1 > r.x0 - 2 * c.fs)) continue;
      if (Math.abs(r.base - c.base) <= 0.22 * Math.min(c.fs, r.fs) + 0.3) {
        row = c;
        break;
      }
    }
    if (row) {
      row.runs.push(r);
      if (r.fs > row.fs) row.fs = r.fs;
    } else rows.push({ base: r.base, fs: r.fs, runs: [r], zone: r.zone || '' });
  }
  // Attach rows of small runs to a neighbour row as superscripts/subscripts.
  const keep = [];
  for (let i = 0; i < rows.length; i++) {
    const R = rows[i];
    // (marks, numbers and short endings: a margin note's line of short words beside a
    // body line is not a superscript)
    const small = R.runs.every((r) => SUP_TEXT.test(r.str.trim()));
    let merged = false;
    if (small) {
      const below = rows[i + 1];
      const above = keep[keep.length - 1];
      const tryRow = (A, sup) => {
        if (!A || R.fs > 0.86 * A.fs || A.zone !== R.zone) return false;
        const d = A.base - R.base; // > 0 when R is above A's baseline
        if (sup ? d < 0.1 * A.fs || d > 0.85 * A.fs : -d < 0.08 * A.fs || -d > 0.55 * A.fs) return false;
        const minX = Math.min(...A.runs.map((a) => a.x0)) - A.fs;
        const maxX = Math.max(...A.runs.map((a) => a.x1)) + A.fs;
        if (!R.runs.every((r) => r.x0 >= minX && r.x1 <= maxX)) return false;
        for (const r of R.runs) {
          r.sup = sup;
          r.sub = !sup;
          A.runs.push(r);
        }
        return true;
      };
      // A superscript sits just above its own line's baseline; prefer the row it touches.
      merged = tryRow(below, true) || tryRow(above, false);
    }
    if (!merged) keep.push(R);
  }
  for (const R of keep) {
    R.runs.sort((a, b) => a.x0 - b.x0);
    // Within a row, a smaller raised run is a superscript too.
    let mainFs = 0;
    for (const r of R.runs) if (!r.sup && !r.sub && r.str.trim().length > 2) mainFs = Math.max(mainFs, r.fs);
    if (!mainFs) mainFs = R.fs;
    const mainBase = median(R.runs.filter((r) => r.fs >= 0.9 * mainFs).map((r) => r.base));
    R.base = mainBase || R.base;
    R.fs = mainFs;
    for (const r of R.runs) {
      if (r.sup || r.sub || !SUP_TEXT.test(r.str.trim())) continue;
      if (r.fs <= 0.82 * mainFs && R.base - r.base > 0.12 * mainFs) r.sup = true;
      else if (r.fs <= 0.82 * mainFs && r.base - R.base > 0.08 * mainFs) r.sub = true;
    }
  }
  return keep;
}

const SUPER_DIGITS = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
const MARKER = /^(?:\d{1,3}|[*†‡§¶#]{1,3}|[a-z])$/;

// Splits a row into segments at wide gaps and builds each segment's text.
export function rowSegments(row, stats) {
  const segs = [];
  let cur = null;
  for (const r of row.runs) {
    const fs = Math.max(row.fs, 1);
    if (cur && !(r.sup || r.sub)) {
      const last = cur.runs[cur.runs.length - 1];
      const gap = r.x0 - cur.x1;
      // a wide gap; a margin-note zone ending; or a small note font meeting body text
      if (gap > 1.0 * fs || (r.zone || '') !== (cur.zone || '')) cur = null;
      else if (!(last.sup || last.sub) && Math.max(r.fs, last.fs) > 1.3 * Math.min(r.fs, last.fs) && gap > 0.25 * Math.min(r.fs, last.fs)) cur = null;
    }
    if (!cur) {
      cur = { runs: [], x0: r.x0, x1: r.x1, base: row.base, fs: row.fs, top: Infinity, bot: -Infinity };
      if (r.zone) cur.zone = r.zone;
      segs.push(cur);
    }
    cur.runs.push(r);
    cur.x1 = Math.max(cur.x1, r.x1);
    cur.x0 = Math.min(cur.x0, r.x0);
    if (!r.sup && !r.sub) {
      cur.top = Math.min(cur.top, r.top);
      cur.bot = Math.max(cur.bot, r.bot);
    }
  }
  for (const s of segs) {
    if (!isFinite(s.top)) {
      s.top = Math.min(...s.runs.map((r) => r.top));
      s.bot = Math.max(...s.runs.map((r) => r.bot));
    }
    // a segment's own size: a margin note's small font shares a row with body text
    const main = s.runs.filter((r) => !r.sup && !r.sub);
    if (main.length) {
      const own = Math.max(...main.map((r) => r.fs));
      if (own < 0.9 * s.fs) s.fs = own;
    }
    finishSegment(s, stats);
  }
  return segs;
}

function finishSegment(s, stats) {
  let text = '';
  let prev = null;
  let boldChars = 0;
  let chars = 0;
  let artifact = true;
  const fonts = new Map();
  for (const r of s.runs) {
    const str = r.str;
    const n = str.replace(/\s+/g, '').length;
    chars += n;
    if (r.bold) boldChars += n;
    if (!r.artifact) artifact = false;
    fonts.set(r.font, (fonts.get(r.font) || 0) + n);
    if (r.sup && MARKER.test(str.trim())) {
      const t = str.trim();
      const before = text.trimEnd();
      if (!before) {
        s.marker = t; // a footnote's own number at the start of its first line
        text = t + ' ';
      } else if (/^[23]$/.test(t) && (/\d\s?(?:[kcmµμnd]?m|ft|in|yd|mi)$/u.test(before) || /=\s*[\p{L}\p{N}]+$/u.test(before))) {
        text = before + SUPER_DIGITS[t]; // a unit's or a formula's power: 12 km², 3 cm³, E = mc²
      } else if (/(?:\p{L}{2}|[.,;:!?)\]"”’%])$/u.test(before) || /(?:^|\D)(?:1[5-9]\d\d|20\d\d)$/.test(before)) {
        // (also after a percentage or a year: 'rose by 12%⁴', 'by 2030³')
        if (stats) stats.markers = (stats.markers || 0) + 1; // footnote reference: dropped
      } else if (/^\d+$/.test(t)) {
        text = before + [...t].map((c) => SUPER_DIGITS[c] || c).join(''); // an exponent: 10³, x²
      } else text = before + t;
      prev = r;
      continue;
    }
    if (r.sup && /^(?:st|nd|rd|th|er|re|e|o|a)$/i.test(str.trim()) && /\d$/.test(text)) {
      text += str.trim();
      prev = r;
      continue;
    }
    if (prev) {
      const gap = r.x0 - prev.x1;
      const tight = r.sub || prev.sub || r.sup;
      const need = (r.sp && !r.sub) || gap > (tight ? 0.25 : 0.12) * Math.max(Math.min(r.fs, prev.fs), 1);
      if (need && !/\s$/.test(text) && !/^\s/.test(str)) text += ' ';
    }
    text += str;
    prev = r;
  }
  s.text = text.replace(/[ \t]+/g, ' ').trim();
  s.chars = chars;
  s.bold = chars ? boldChars / chars : 0;
  s.artifact = artifact;
  let best = '';
  let bestN = -1;
  for (const [f, n] of fonts) if (n > bestN) (best = f), (bestN = n);
  s.font = best;
  const confs = s.runs.filter((r) => typeof r.conf === 'number');
  if (confs.length) s.conf = confs.reduce((n, r) => n + r.conf, 0) / confs.length;
}

// The whole first stage: runs -> segments (each a stretch of one row).
export function segmentsOf(runs, bodyFs, stats) {
  let rs = dedupe(runs);
  if (bodyFs) rs = mergeDropCaps(rs, bodyFs);
  const rows = buildRows(rs);
  const segs = [];
  for (const row of rows) for (const s of rowSegments(row, stats)) if (s.text) segs.push(s);
  return segs;
}

/* ---------- running heads, page numbers ---------- */

const ROMAN = /^(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

// Text of a band line with numbers normalized, so "Page 3" matches "Page 4".
export function bandKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/\d+/g, '#')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (ROMAN.test(w) ? '#' : w))
    .join(' ')
    .replace(/ ?([|·•–—:-]) ?/g, '$1');
}

const PAGE_NO = /^(?:(?:page|pg\.?|p\.)\s?)?[-–—([]?\s?#\s?[-–—)\]]?(?:\s?(?:of|\/)\s?#)?$/;
export function isPageNumber(text) {
  return PAGE_NO.test(bandKey(text));
}

// Candidate running heads/feet: short lines in the top or bottom ~8% of the page (12%
// for the outermost line), set apart from the body by a gap or a smaller size. The gap
// test keeps a body line that happens to start several pages the same way.
export function bandSegments(segs, H, bodyFs) {
  const out = [];
  if (!segs.length) return out;
  let firstTop = Infinity;
  let lastBot = -Infinity;
  for (const s of segs) {
    firstTop = Math.min(firstTop, s.top);
    lastBot = Math.max(lastBot, s.bot);
  }
  for (const s of segs) {
    if (s.text.length > 140) continue;
    if (bodyFs && s.fs > 1.2 * bodyFs && !s.artifact) continue; // a chapter heading, not a running head
    let side = null;
    if (s.top < 0.08 * H || (s.top - firstTop < 1 && s.top < 0.12 * H)) side = 'top';
    else if (s.bot > 0.92 * H || (lastBot - s.bot < 1 && s.bot > 0.88 * H)) side = 'bottom';
    if (!side) continue;
    const small = bodyFs && s.fs <= 0.92 * bodyFs;
    // a bare page number on the outermost line needs no gap (footnotes often crowd it)
    const outer = side === 'top' ? s.top - firstTop < 1 : lastBot - s.bot < 1;
    if (small || s.artifact || (outer && isPageNumber(s.text)) || apart(s, segs, side)) out.push({ seg: s, side, key: bandKey(s.text) });
  }
  return out;
}

function apart(s, segs, side) {
  let nearest = Infinity;
  for (const o of segs) {
    if (o === s || Math.abs(o.base - s.base) < 0.5 * s.fs) continue;
    const d = side === 'top' ? o.top - s.bot : s.top - o.bot;
    if (d >= -0.1 && d < nearest) nearest = d;
  }
  return nearest > 1.2 * s.fs;
}

// Fuzzy key match for OCR text, which may differ by a character or two between pages.
export function keysMatch(a, b) {
  if (a === b) return true;
  const allowed = Math.max(1, Math.floor(0.12 * Math.max(a.length, b.length)));
  if (a.length < 8 || b.length < 8 || Math.abs(a.length - b.length) > allowed) return false;
  return editDistance(a, b, allowed) <= allowed;
}

function editDistance(a, b, cap) {
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/* ---------- footnotes ---------- */

const NOTE_START = /^(?:\d{1,3}|[*†‡§¶]{1,3})(?:[.)]?\s+|(?=\p{Lu}))/u;
// 'Figure 3.', 'Table 2: ...', 'Fig. 4 Training error' -- but not 'Fig. 7 shows that'
// (the capital is checked apart: under the i flag \p{Lu} matches any letter).
const CAPTION = /^(?:fig(?:ure)?\.?|table|tab\.|chart|plate|exhibit|listing|algorithm|scheme|illustration|photo|map|graph|diagram|box)\s*(?:\d+|[IVXL]+)(?:[.-]\d+)*[a-z]?/i;
export const isCaption = (t) => {
  const m = CAPTION.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  return !rest || /^\s*[.:–—-]/.test(rest) || /^\s+\p{Lu}/u.test(rest);
};

// Small-font text at the foot of the page that starts with a note number. Returns the
// set of segments that are footnotes.
export function footnoteSegments(segs, H, bodyFs, used, tol = 0.9, loose = false) {
  const notes = new Set();
  if (!bodyFs) return notes;
  const smallSet = new Set(segs.filter((s) => s.fs <= tol * bodyFs && s.base > 0.5 * H && !used.has(s)));
  if (loose && smallSet.size) {
    // (OCR sizes wobble: a note's line of quotes and capitals can measure body size;
    // it still belongs to the note when it runs on from a small line just above it)
    for (const s of segs.slice().sort((a, b) => a.top - b.top)) {
      if (smallSet.has(s) || used.has(s) || s.base <= 0.5 * H || s.fs > 1.15 * bodyFs) continue;
      if ([...smallSet].some((c) => c.bot <= s.top + 0.4 * s.fs && s.top - c.bot < 0.8 * s.fs && c.x0 < s.x1 && c.x1 > s.x0)) smallSet.add(s);
    }
  }
  const small = (s) => smallSet.has(s);
  const cands = segs.filter(small);
  if (!cands.length) return notes;
  // Nothing body-sized may sit below a footnote in the same column.
  const blocked = (c) => segs.some((o) => !used.has(o) && !small(o) && o.top > c.top + 0.2 * c.fs && o.x0 < c.x1 && o.x1 > c.x0);
  const area = cands.filter((c) => !blocked(c)).sort((a, b) => a.top - b.top || a.x0 - b.x0);
  if (!area.length) return notes;
  // Group into areas by column overlap; each area must begin with a note marker.
  const groups = [];
  for (const s of area) {
    let g = groups.find((g) => s.x0 < g.x1 + 2 * s.fs && s.x1 > g.x0 - 2 * s.fs && s.top - g.bot < 2.5 * s.fs);
    if (!g) groups.push((g = { segs: [], x0: s.x0, x1: s.x1, bot: s.bot }));
    g.segs.push(s);
    g.x0 = Math.min(g.x0, s.x0);
    g.x1 = Math.max(g.x1, s.x1);
    g.bot = Math.max(g.bot, s.bot);
  }
  for (const g of groups) {
    const first = g.segs[0];
    if (isCaption(first.text)) continue;
    const starts = (s) => s.marker || NOTE_START.test(s.text) || /^\d{1,3}$/.test(s.text);
    if (!starts(first)) {
      // OCR often loses the first note's number, and a note may run on from the page
      // before: still notes when a later line starts one and a gap sets them apart, or
      // (every number lost: tiny superscripts) when a wide gap does.
      let above = -Infinity;
      for (const o of segs) if (!used.has(o) && !small(o) && o.bot <= first.top + 0.2 * first.fs && o.x0 < g.x1 && o.x1 > g.x0) above = Math.max(above, o.bot);
      const gap = first.top - above;
      if (g.segs.some(starts) ? gap < 0.9 * bodyFs : gap < 1.6 * bodyFs || first.fs > 0.92 * bodyFs || !isFinite(above)) continue;
    }
    for (const s of g.segs) notes.add(s);
  }
  return notes;
}

/* ---------- margin notes ---------- */

// The left and right edges of the page's text block: where its wide lines start and end.
export function textBlock(segs) {
  if (!segs.length) return null;
  const minX = Math.min(...segs.map((s) => s.x0));
  const maxX = Math.max(...segs.map((s) => s.x1));
  const wide = segs.filter((s) => s.x1 - s.x0 >= 0.5 * (maxX - minX));
  const use = wide.length >= 3 ? wide : segs;
  const left = median(use.map((s) => s.x0));
  const right = median(use.map((s) => s.x1));
  return { left, right, width: Math.max(1, right - left), minX, maxX };
}

const LABEL = /^(?:[\d.()ivxlc]+|[•\-–—*·]|\(?[a-zA-Z][.)])$/;

// x positions inside the text block where several wide lines start: the edge of a
// notch cut for a margin note (or a block quote's indent).
function notchesOf(segs, blk, bodyFs) {
  const starts = segs
    .filter((s) => s.x1 - s.x0 >= 0.4 * blk.width && s.x0 > blk.left + 2 * bodyFs && s.x0 < blk.left + 0.35 * blk.width)
    .map((s) => s.x0)
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < starts.length; ) {
    let j = i;
    while (j + 1 < starts.length && starts[j + 1] - starts[i] < 3) j++;
    if (j > i) out.push(median(starts.slice(i, j + 1)));
    i = j + 1;
  }
  return out;
}

// Body text set in two or more columns. Margin notes belong to single-column pages;
// on a two-column page a figure's labels beside a column look just like them.
export function multiColumn(segs, bodyFs) {
  // (the page's own text size: a page of references is set smaller than the body)
  const long = segs.filter((s) => s.text.length >= 15);
  const fs = median(long.map((s) => s.fs)) || bodyFs;
  const lines = long.filter((s) => Math.abs(s.fs - fs) <= 0.15 * fs);
  if (lines.length < 10) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of lines) {
    if (s.x0 < minX) minX = s.x0;
    if (s.x1 > maxX) maxX = s.x1;
  }
  const span = maxX - minX;
  let L = 0;
  let R = 0;
  for (const s of lines) {
    if (s.x1 < minX + 0.55 * span) L++;
    else if (s.x0 > minX + 0.45 * span) R++;
  }
  return L >= 5 && R >= 5 && L + R >= 0.6 * lines.length;
}

// A margin note can come so close to the body beside it that the row reads as one
// segment ('and water mills. water, and the wheel turned'). Where other rows show a notch,
// split such a row at the word that starts on the notch's edge.
export function splitAtNotches(segs, bodyFs) {
  const blk = textBlock(segs);
  if (!blk || !bodyFs || segs.length < 4 || multiColumn(segs, bodyFs)) return segs;
  const notches = notchesOf(segs, blk, bodyFs);
  if (!notches.length) return segs;
  const out = [];
  for (const s of segs) {
    let parts = null;
    if (s.x0 < blk.left + 2 * bodyFs && s.runs && s.runs.length > 1) {
      for (const nx of notches) {
        // (a word space in a body line can happen to fall on the notch's edge: a cut
        // there needs a note's small font, or a gap wider than a word space)
        const gapNeed = (i) => {
          const left = Math.max(...s.runs.slice(0, i).map((r) => r.fs));
          const right = median(s.runs.slice(i).map((r) => r.fs));
          return (left <= 0.85 * bodyFs || left < 0.95 * right ? 0.2 : 0.8) * Math.min(s.runs[i].fs, bodyFs);
        };
        // (an OCR'd word may have lost its first letter: its box starts a little late)
        const k = s.runs.findIndex((r, i) => i > 0 && !r.sup && !r.sub && r.x0 - nx > -2.5 && r.x0 - nx < Math.max(2.5, 0.45 * bodyFs) && r.x0 - s.runs[i - 1].x1 > gapNeed(i));
        if (k > 0 && s.runs[k - 1].x1 - s.x0 <= 0.3 * blk.width) {
          parts = [s.runs.slice(0, k), s.runs.slice(k)];
          break;
        }
      }
    }
    if (!parts) {
      out.push(s);
      continue;
    }
    for (const runs of parts) {
      const t = { runs, x0: Math.min(...runs.map((r) => r.x0)), x1: Math.max(...runs.map((r) => r.x1)), base: s.base, fs: s.fs, top: Math.min(...runs.map((r) => r.top)), bot: Math.max(...runs.map((r) => r.bot)) };
      if (s.zone) t.zone = s.zone;
      t.cut = true;
      const main = runs.filter((r) => !r.sup && !r.sub);
      if (main.length) t.fs = Math.min(s.fs, Math.max(...main.map((r) => r.fs)));
      finishSegment(t, null);
      if (t.text) out.push(t);
    }
  }
  return out;
}

// Side notes in the outer margin (older books, textbooks, legal texts): short lines in
// a narrow strip at the left or right edge, set apart from the body by a gutter and
// usually smaller. Either the body beside them is indented (the note sits in a notch
// of the text block) or the strip lies outside the body column. Table cells and list
// labels are not notes: the body beside a note is made of full, wide lines.
// Returns { segs: Set, groups: [{ segs, side, top, bot, x0, x1 }], shift: Map(seg -> x) }.
// exact: positions come from a text layer (not OCR boxes), so a notch must be a clean
// edge.
export function marginNotes(segs, bodyFs, H, exact = false) {
  const res = { segs: new Set(), groups: [], shift: new Map() };
  const blk = textBlock(segs);
  if (!blk || segs.length < 6 || !bodyFs || multiColumn(segs, bodyFs)) return res;
  const W = blk.width;
  const near = (a, b, d) => b.top < a.bot + d && b.bot > a.top - d;
  const notches = notchesOf(segs, blk, bodyFs);
  const atNotch = (x) => notches.some((n) => Math.abs(n - x) < 2.5);
  // body text beside c, past a gutter; a note in a small font, or body starting on a
  // notch, may come as close as a wide word space
  const gapOk = (c, o, side) => {
    const gap = side === 'left' ? o.x0 - c.x1 : c.x0 - o.x1;
    const k = c.fs <= 0.85 * bodyFs || (side === 'left' && atNotch(o.x0)) ? 0.3 : 0.6;
    return gap >= k * Math.min(bodyFs, o.fs);
  };
  // the body beside a note is body text (not a footnote's second half)
  const bodyLike = (o) => o.x1 - o.x0 >= 0.45 * W && o.fs > 0.92 * bodyFs && o.zone !== 'margin';
  // (a line in the body's size must share a row with the body beside it: the short
  // last line of a paragraph sits just above the next paragraph's notched lines)
  const beside = (c, side) => segs.some((o) => o !== c && bodyLike(o) && near(c, o, c.fs <= 0.85 * bodyFs ? 0.6 * c.fs : -0.3 * c.fs) && gapOk(c, o, side));
  for (const side of ['left', 'right']) {
    const cands = segs.filter((c) => {
      if (c.zone === 'margin') return side === 'left' ? c.x1 < blk.left + 0.5 * W : c.x0 > blk.right - 0.5 * W;
      // a row cut at a notch is a note line only in a note's small font
      if (c.cut && c.fs > 0.9 * bodyFs) return false;
      const w = c.x1 - c.x0;
      if (w > 0.3 * W || c.top < 0.04 * H || c.bot > 0.97 * H) return false;
      if (LABEL.test(c.text.trim()) || !/\p{L}{2}/u.test(c.text)) return false;
      // (the running head shares its row with the page number)
      if (c.top < 0.15 * H && segs.some((o) => o !== c && near(c, o, 0) && isPageNumber(o.text))) return false;
      if (side === 'left' ? c.x0 > blk.left + 2 * bodyFs || c.x1 > blk.left + 0.32 * W : c.x1 < blk.right - 2 * bodyFs || c.x0 < blk.right - 0.32 * W) return false;
      return beside(c, side) || (side === 'left' ? c.x1 < blk.left - 0.6 * bodyFs : c.x0 > blk.right + 0.6 * bodyFs);
    });
    cands.sort((a, b) => a.top - b.top);
    const groups = [];
    for (const c of cands) {
      const g = groups[groups.length - 1];
      if (g && c.top - g.bot < 1.6 * Math.max(c.fs, g.fs) && Math.abs((side === 'left' ? c.x0 - g.x0 : c.x1 - g.x1)) < 3 * bodyFs) {
        g.segs.push(c);
        g.bot = Math.max(g.bot, c.bot);
        g.x0 = Math.min(g.x0, c.x0);
        g.x1 = Math.max(g.x1, c.x1);
        g.fs = Math.max(g.fs, c.fs);
      } else groups.push({ segs: [c], side, top: c.top, bot: c.bot, x0: c.x0, x1: c.x1, fs: c.fs });
    }
    for (const g of groups) {
      const letters = g.segs.reduce((n, c) => n + (c.text.match(/\p{L}/gu) || []).length, 0);
      const fs = median(g.segs.map((c) => c.fs));
      const small = fs <= 0.9 * bodyFs;
      const words = g.segs.reduce((n, c) => n + c.text.split(' ').length, 0);
      const outside = side === 'left' ? g.x1 < blk.left - 0.6 * bodyFs : g.x0 > blk.right + 0.6 * bodyFs;
      // the body beside the note, and the notch it leaves (past the note's inner edge,
      // where all its lines but one end: a row that mixed note lines with the body's
      // first word must not move the edge)
      const ends = g.segs.map((c) => (side === 'left' ? c.x1 : -c.x0)).sort((a, b) => b - a);
      const edge = ends.length >= 3 ? ends[1] : ends[0];
      // (body starting on a notch other rows show may come closer than a word space)
      const next = segs.filter((o) => !g.segs.includes(o) && bodyLike(o) && near(g, o, 0.3 * bodyFs) && (side === 'left' ? o.x0 >= edge + 0.3 * bodyFs || (atNotch(o.x0) && o.x0 > edge) : o.x1 <= -edge - 0.3 * bodyFs));
      const notch = next.length && !outside && (side === 'left' ? Math.min(...next.map((o) => o.x0)) > blk.left + 2 * bodyFs : Math.max(...next.map((o) => o.x1)) < blk.right - 2 * bodyFs);
      const zoned = g.segs.every((c) => c.zone === 'margin');
      if (!zoned && (letters < 6 || words < 2)) continue;
      // a notch alone is weak evidence when the rows had to be cut at it, or, in a text
      // layer, when the lines beside don't start on one edge (a formula's wide spaces
      // split rows anywhere; OCR boxes are too rough to tell)
      const cuts = g.segs.filter((c) => c.cut).length;
      const edge0 = side === 'left' && next.length ? median(next.map((o) => o.x0)) : 0;
      const edged = !exact || side !== 'left' || next.filter((o) => Math.abs(o.x0 - edge0) < 0.6 * bodyFs).length >= 2;
      if (!zoned && !(small && (next.length || outside)) && !((outside || (notch && edged)) && g.segs.length >= 2 && cuts <= g.segs.length / 2)) continue;
      g.notch = notch ? (side === 'left' ? Math.min(...next.map((o) => o.x0)) : Math.max(...next.map((o) => o.x1))) : null;
      g.next = next;
      res.groups.push(g);
      for (const c of g.segs) res.segs.add(c);
      if (notch) {
        // body lines beside the note start where the text block starts
        const edge = side === 'left' ? Math.min(...next.map((o) => o.x0)) : 0;
        if (side === 'left') for (const o of next) res.shift.set(o, blk.left + (o.x0 - edge));
      }
    }
  }
  return res;
}

// Where a page's margin notes are, for a second, closer OCR pass: the strip beside each
// notch of the text block (or the strip outside the body column). Each region covers
// only rows whose body text starts at the notch, so no body word falls inside it.
// Returns [{ side, x0, x1, top, bot }] in page points.
export function marginRegions(all, bodyFs, H) {
  const segs = splitAtNotches(all, bodyFs);
  const m = marginNotes(segs, bodyFs, H);
  const blk = textBlock(segs);
  const out = [];
  if (!blk) return out;
  const fs = bodyFs;
  for (const g of m.groups) {
    const left = g.side === 'left';
    let r;
    if (g.notch != null) {
      // the body rows that start at the notch, near the note and on from there (a note's
      // later lines may be too garbled to have been found as note lines)
      const notched = segs.filter((o) => !m.segs.has(o) && o.x1 - o.x0 >= 0.3 * blk.width && Math.abs((left ? o.x0 : o.x1) - g.notch) < 1.5 * fs).sort((a, b) => a.top - b.top);
      const rows = notched.filter((o) => o.top < g.bot + 3 * fs && o.bot > g.top - 3 * fs);
      if (rows.length) {
        let k = notched.indexOf(rows[rows.length - 1]);
        while (k + 1 < notched.length && notched[k + 1].top - notched[k].bot < 1.5 * fs) rows.push(notched[++k]);
      }
      const rowsTop = rows.length ? Math.min(...rows.map((o) => o.top)) : g.top;
      const rowsBot = rows.length ? Math.max(...rows.map((o) => o.bot)) : g.bot;
      // (an italic note line's ascenders reach above the box the layer gives it)
      let top = Math.min(g.top, rowsTop) - 0.5 * fs;
      let bot = Math.max(g.bot, rowsBot) + 0.25 * fs;
      // body lines that run into the strip bound the region
      const mid = (g.top + g.bot) / 2;
      for (const o of segs) {
        if (m.segs.has(o) || rows.includes(o) || o.bot <= top || o.top >= bot) continue;
        if (left ? o.x0 >= g.notch - 1.5 * fs : o.x1 <= g.notch + 1.5 * fs) continue;
        // (a short line in the strip: a paragraph's last line above or below the notch,
        // or, between notched rows, a note line read badly the first time)
        const between = o.top > rowsTop && o.bot < rowsBot;
        if (o.x1 - o.x0 < 0.3 * blk.width && !(left ? o.x1 > g.notch : o.x0 < g.notch) && (o.fs <= 0.9 * fs || between)) continue;
        if ((o.top + o.bot) / 2 < mid) top = Math.max(top, o.bot + 0.1 * fs);
        else bot = Math.min(bot, o.top - 0.1 * fs);
      }
      r = left ? { side: g.side, x0: Math.max(0, Math.min(g.x0, blk.minX) - fs), x1: g.notch - 0.2 * fs, top, bot } : { side: g.side, x0: g.notch + 0.2 * fs, x1: Math.max(g.x1, blk.maxX) + fs, top, bot };
    } else {
      r = left ? { side: g.side, x0: Math.max(0, g.x0 - fs), x1: blk.left - 0.3 * fs, top: g.top - fs, bot: g.bot + fs } : { side: g.side, x0: blk.right + 0.3 * fs, x1: g.x1 + fs, top: g.top - fs, bot: g.bot + fs };
    }
    if (r.x1 - r.x0 < 2 * fs || r.bot - r.top < 0.8 * fs) continue;
    const lines = g.segs.slice().sort((a, b) => a.top - b.top);
    r.first = lines[0].text;
    r.last = lines[lines.length - 1].text;
    // Strips close together are read as one, unless a body line runs across the gap
    // between them and one note ends there and another starts (two notes beside two
    // paragraphs). (A row that mixed a note line with the body looks like such a line.)
    const apart = (q) => {
      const [a, b] = q.top <= r.top ? [q, r] : [r, q];
      if (!(SENTENCE_END.test(a.last) && /^[\p{Lu}"“‘(]/u.test(b.first))) return false;
      const y0 = a.bot - 0.3 * fs;
      const y1 = b.top + 0.3 * fs;
      const x = left ? Math.min(q.x1, r.x1) : Math.max(q.x0, r.x0);
      return segs.some((o) => !m.segs.has(o) && o.top > y0 && o.bot < y1 && o.x0 < x - fs && o.x1 > x + fs);
    };
    const o = out.find((q) => q.side === r.side && q.top < r.bot + 1.5 * fs && q.bot > r.top - 1.5 * fs && !apart(q));
    if (o) {
      o.x0 = Math.min(o.x0, r.x0);
      o.x1 = Math.max(o.x1, r.x1);
      if (r.top < o.top) o.first = r.first;
      if (r.bot > o.bot) o.last = r.last;
      o.top = Math.min(o.top, r.top);
      o.bot = Math.max(o.bot, r.bot);
    } else out.push(r);
  }
  for (const r of out) {
    delete r.first;
    delete r.last;
  }
  return out;
}

// A margin note group's lines, as note texts. Notes set one under another run
// together in the strip; each is a sentence, so a line that ends one and a capital
// that starts the next separate them.
function marginText(g, words) {
  const lines = g.segs.slice().sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const out = [];
  let text = '';
  for (const l of lines) {
    if (text && SENTENCE_END.test(text) && /^[\p{Lu}"“‘(]/u.test(l.text)) {
      out.push(text);
      text = '';
    }
    text = joinLines(text, l.text, words);
  }
  out.push(text);
  return out.map((t) => t.replace(/­/g, '').replace(/\s+/g, ' ').trim()).filter((t) => /\p{L}/u.test(t));
}

/* ---------- recursive XY-cut ---------- */

// Empty intervals between projected [a, b] ranges at least minGap wide, widest first.
function gapsOf(ranges, minGap) {
  if (!ranges.length) return [];
  const rs = ranges.slice().sort((p, q) => p[0] - q[0]);
  const out = [];
  let end = rs[0][1];
  for (let i = 1; i < rs.length; i++) {
    const g = rs[i][0] - end;
    if (g >= minGap) out.push({ a: end, b: rs[i][0], w: g, at: end + g / 2 });
    end = Math.max(end, rs[i][1]);
  }
  return out.sort((p, q) => q.w - p.w);
}

// Like gapsOf, but a gap may be crossed by up to `allow` ranges.
function gapsAllowing(ranges, minGap, allow) {
  if (!allow) return gapsOf(ranges, minGap);
  if (!ranges.length) return [];
  const ev = [];
  for (const [a, b] of ranges) ev.push([a, 1], [b, -1]);
  ev.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const lo = ev[0][0];
  const out = [];
  let n = 0;
  let start = null;
  for (const [x, d] of ev) {
    const was = n;
    n += d;
    if (was > allow && n <= allow) start = x;
    else if (was <= allow && n > allow && start != null) {
      if (x - start >= minGap && start > lo) out.push({ a: start, b: x, w: x - start, at: start + (x - start) / 2 });
      start = null;
    }
  }
  return out.sort((p, q) => q.w - p.w);
}

// A side of a vertical cut is a text column (not a table column or a list of labels)
// when its lines are reasonably wide, or when it holds a few wide lines among a
// figure's short labels (a tall figure above its caption in one column).
function columnish(side, med) {
  const widths = side.map((s) => s.x1 - s.x0);
  const m = median(widths);
  if (side.length === 1) return m >= 8 * med;
  return m >= 6 * med || widths.filter((w) => w >= 12 * med).length >= 3;
}

// Orders segments for reading. Returns leaves: [{ segs, col }] where col names the
// column path (segments in the same column share left and right edges).
export function xycut(segs, col = '', depth = 0, out = []) {
  if (!segs.length) return out;
  if (segs.length === 1 || depth > 40) {
    out.push({ segs, col });
    return out;
  }
  const med = median(segs.map((s) => s.fs)) || 10;
  // 1. A clean vertical gutter between two text columns.
  for (const g of gapsOf(segs.map((s) => [s.x0, s.x1]), 1.2 * med)) {
    const L = segs.filter((s) => s.x1 <= g.at);
    const R = segs.filter((s) => s.x0 >= g.at);
    if (L.length && R.length && L.length + R.length === segs.length && columnish(L, med) && columnish(R, med)) {
      xycut(L, col + 'L', depth + 1, out);
      xycut(R, col + 'R', depth + 1, out);
      return out;
    }
  }
  // 2. A gutter hidden by lines that span it (a title above two columns, a wide
  // figure caption below): cut those spanning lines off first.
  const minX = Math.min(...segs.map((s) => s.x0));
  const maxX = Math.max(...segs.map((s) => s.x1));
  // (a short line may cross the gutter too: an author's name or an affiliation centred
  // above the columns)
  const narrow = segs.filter((s) => s.x1 - s.x0 < 0.55 * (maxX - minX));
  if (narrow.length >= 4 && narrow.length < segs.length) {
    for (const g of gapsAllowing(narrow.map((s) => [s.x0, s.x1]), 1.2 * med, Math.min(8, Math.max(2, Math.ceil(0.05 * narrow.length))))) {
      const L = narrow.filter((s) => s.x1 <= g.at);
      const R = narrow.filter((s) => s.x0 >= g.at);
      if (!L.length || !R.length || !columnish(L, med) || !columnish(R, med)) continue;
      const bands = spanBands(segs, (s) => s.x0 < g.at && s.x1 > g.at);
      if (bands.length > 1) {
        for (const b of bands) xycut(b, col, depth + 1, out);
        return out;
      }
      break;
    }
  }
  // 3. Horizontal gaps: cut at all of them at once (keeps the recursion shallow).
  const hs = gapsOf(segs.map((s) => [s.top, s.bot]), 0.25 * med);
  if (hs.length) {
    const cuts = hs.map((g) => g.at).sort((a, b) => a - b);
    const bands = [[]];
    for (let k = 0; k < cuts.length; k++) bands.push([]);
    for (const s of segs) {
      let k = 0;
      while (k < cuts.length && s.top >= cuts[k]) k++;
      bands[k].push(s);
    }
    const nonEmpty = bands.filter((b) => b.length);
    if (nonEmpty.length > 1) {
      for (const b of nonEmpty) xycut(b, col, depth + 1, out);
      return out;
    }
  }
  out.push({ segs, col });
  return out;
}

// Splits segments top to bottom into bands that either span the gutter or don't,
// cutting only where no segment crosses the cut.
function spanBands(segs, spans) {
  const s = segs.slice().sort((a, b) => a.top - b.top);
  const bands = [];
  let cur = [];
  let curType = null;
  let maxBot = -Infinity;
  for (const x of s) {
    const t = spans(x);
    if (cur.length && t !== curType && x.top >= maxBot - 0.15 * x.fs) {
      bands.push(cur);
      cur = [];
    }
    if (!cur.length) curType = t;
    cur.push(x);
    maxBot = Math.max(maxBot, x.bot);
  }
  if (cur.length) bands.push(cur);
  return bands;
}

// Leaves -> lines: segments of one row inside one leaf join into one line.
export function leavesToLines(leaves) {
  const lines = [];
  for (const leaf of leaves) {
    const segs = leaf.segs.slice().sort((a, b) => a.base - b.base || a.x0 - b.x0);
    let line = null;
    for (const s of segs) {
      if (line && Math.abs(s.base - line.base) <= 0.3 * Math.min(s.fs, line.fs) + 0.3 && s.x0 >= line.x1 - 0.5) {
        line.segs.push(s);
        line.text += ' ' + s.text;
        line.x1 = Math.max(line.x1, s.x1);
        line.top = Math.min(line.top, s.top);
        line.bot = Math.max(line.bot, s.bot);
        line.chars += s.chars;
        line.boldChars += s.bold * s.chars;
        continue;
      }
      line = { segs: [s], text: s.text, x0: s.x0n != null ? s.x0n : s.x0, x1: s.x1, base: s.base, top: s.top, bot: s.bot, fs: s.fs, col: leaf.col, chars: s.chars, boldChars: s.bold * s.chars, marker: s.marker, conf: s.conf };
      lines.push(line);
    }
  }
  for (const l of lines) l.bold = l.chars ? l.boldChars / l.chars : 0;
  return lines;
}

/* ---------- lines -> blocks ---------- */

const TERMINAL = /[.!?…:;"”’')\]]$/;
const SENTENCE_END = /[.!?…]["”’')\]]*$/;
const BULLET_START = new RegExp(`^(?:[${BULLET_CHARS}]|[-–—*](?=\\s))\\s*`, 'u');
// 1. 2) a. b) iv. (c) A) -- but not "J. Patel", so capitals need a parenthesis
const ENUM_START = /^(?:\d{1,2}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)]|\(?[A-Z]\)|\(\d{1,2}\))\s+(?=\S)/;
const LETTER1 = /\p{L}/u;

// Letters at the end of s before index end (a loop: tail-anchored regex runs are slow).
function trailingLetters(s, end) {
  let i = end;
  while (i > 0 && LETTER1.test(s[i - 1])) i--;
  return s.slice(i, end);
}

const isHyphen = (c) => c === '-' || c === '‐';

const LONE = new Set('the an of and his its their our your my with from which was were is are has had have been'.split(' '));

export function joinLines(a, b, words) {
  const left = a.trimEnd();
  const right = b.trimStart();
  if (!left) return right;
  if (!right) return left;
  if (left.endsWith('­')) return left.slice(0, -1) + right;
  const last = left[left.length - 1];
  if (isHyphen(last) && /^\p{L}/u.test(right)) {
    const a1 = trailingLetters(left, left.length - 1);
    if (a1) {
      const b1 = /^\p{L}+/u.exec(right)[0];
      if (dehyphenate(a1, b1, words)) return left.slice(0, -1) + right;
      // a little word on its own never starts a compound ('the-' / 'funds': a speck read
      // as a hyphen at the line's end)
      if (LONE.has(a1.toLowerCase()) && /(?:^|[\s(["“‘])$/u.test(left.slice(0, -1 - a1.length))) return left.slice(0, -1) + ' ' + right;
      return left + right; // a real compound: keep the hyphen, no space ("forty-two")
    }
  }
  if (isHyphen(last) && /^\d/.test(right) && LETTER1.test(left[left.length - 2] || '')) return left + right; // COVID-\n19
  if ((last === '—' || last === '–') && left[left.length - 2] !== ' ') return left + right;
  const tok = left.slice(left.lastIndexOf(' ') + 1);
  if (/^(?:https?:\/\/|www\.)/.test(tok) && /[/._?=&#-]$/.test(tok)) return left + right;
  return left + ' ' + right;
}

// Should "a-" + "b" lose its hyphen? Only when the joined word is a word, or when the
// pieces are fragments; two real words stay a compound.
export function dehyphenate(a, b, words) {
  if (!words) return /^\p{Ll}/u.test(b);
  if (/^\p{Lu}/u.test(b) && /^\p{Lu}/u.test(a)) return known(words, a + b.toLowerCase()) && !known(words, b);
  if (/^\p{Lu}/u.test(b)) return false;
  const joined = a + b;
  if (known(words, joined) || stemKnown(joined, words)) return true;
  if (known(words, a) && known(words, b)) return false;
  return true;
}

const SUFFIXES = ['ing', 'ed', 'es', 's', 'ly', 'er', 'ers', 'est', 'ment', 'ments', 'ness', 'ation', 'ations', 'able', 'al', 'ally', 'ity', 'ies', 'ied'];
function stemKnown(w, words) {
  const lw = w.toLowerCase();
  for (const suf of SUFFIXES) {
    if (lw.length > suf.length + 3 && lw.endsWith(suf)) {
      const stem = lw.slice(0, -suf.length);
      if (words.has(stem) || words.has(stem + 'e') || (suf.startsWith('i') && words.has(stem + 'y'))) return true;
    }
  }
  return false;
}

function continues(prev, next) {
  const p = prev.trimEnd();
  if (/\p{L}[-‐­]$/u.test(p) && /^\p{L}/u.test(next)) return true;
  if (/[,;]$/.test(p)) return true;
  if (!TERMINAL.test(p) && /^\p{Ll}/u.test(next)) return true;
  return false;
}

// Typical baseline-to-baseline distance as a multiple of the font size, from lines in
// the same column that follow each other at the same size. OCR'd sizes come from word
// heights and wobble from line to line (descenders, capitals), so `tol` is wider there.
function lineRatio(lines, tol = 0.05) {
  const r = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    if (a.col !== b.col || Math.abs(a.fs - b.fs) > tol * a.fs) continue;
    const fs = (a.fs + b.fs) / 2;
    const pitch = b.base - a.base;
    if (pitch > 0.85 * fs && pitch < 2.6 * fs) r.push(pitch / fs);
  }
  if (r.length < 3) return 0;
  // the most common pitch: paragraph gaps are the minority
  const s = r.sort((x, y) => x - y);
  let best = s[0];
  let bestN = 0;
  for (let i = 0, j = 0; i < s.length; i++) {
    while (s[i] - s[j] > 0.04) j++;
    if (i - j + 1 > bestN) (bestN = i - j + 1), (best = s[(i + j) >> 1]);
  }
  return best;
}

function columnBounds(lines) {
  const by = new Map();
  for (const l of lines) {
    let e = by.get(l.col);
    if (!e) by.set(l.col, (e = []));
    e.push(l);
  }
  const out = new Map();
  for (const [col, ls] of by) {
    const counts = new Map();
    for (const l of ls) {
      const x = Math.round(l.x0);
      counts.set(x, (counts.get(x) || 0) + 1);
    }
    let left = Math.min(...ls.map((l) => l.x0));
    let bestN = 0;
    for (const [x, n] of counts) {
      const near = n + (counts.get(x - 1) || 0) + (counts.get(x + 1) || 0);
      if (near > bestN || (near === bestN && x < left)) (bestN = near), (left = x);
    }
    if (bestN < 0.3 * ls.length) left = Math.min(...ls.map((l) => l.x0));
    const ends = ls.map((l) => l.x1).sort((a, b) => a - b);
    const right = ends[Math.floor(0.9 * (ends.length - 1))];
    out.set(col, { left, right: Math.max(right, left + 1) });
  }
  return out;
}

// Does this page mark paragraphs with a first-line indent? Then an unindented line at
// the top of a column continues the paragraph from the column before.
function indentsSeen(lines, bounds) {
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const P = lines[i - 1];
    const L = lines[i];
    const b = bounds.get(L.col);
    if (!b || P.col !== L.col) continue;
    const d = L.x0 - b.left;
    if (d > 0.8 * L.fs && d < 6 * L.fs && Math.abs(P.x0 - b.left) < 0.5 * L.fs && SENTENCE_END.test(P.text)) n++;
  }
  return n >= 2;
}

// ctx: { words, source: 'text' | 'ocr', loose }
export function linesToParagraphs(lines, ctx = {}) {
  const loose = !!ctx.loose || ctx.source === 'ocr';
  const bounds = columnBounds(lines);
  const env = { ratio: lineRatio(lines, loose ? 0.2 : 0.05), bounds, loose, indents: indentsSeen(lines, bounds) };
  const paras = [];
  let cur = null;
  const startPara = (l) => {
    const bullet = BULLET_START.exec(l.text);
    const en = !bullet && ENUM_START.exec(l.text);
    cur = { lines: [l], text: bullet ? l.text.slice(bullet[0].length) : l.text, list: !!(bullet || en), bullet: !!bullet, hang: null };
    if (cur.list && l.segs && l.segs.length) {
      // continuation lines of a list item line up with its text, not its marker
      const first = l.segs[0];
      const runs = first.runs || [];
      if (runs.length > 1 && (bullet || en)) cur.hang = runs[1].x0;
    }
    paras.push(cur);
  };
  for (const L of lines) {
    if (!cur) {
      startPara(L);
      continue;
    }
    const P = cur.lines[cur.lines.length - 1];
    if (breakBetween(P, L, cur, env)) startPara(L);
    else {
      cur.text = joinLines(cur.text, L.text, ctx.words);
      cur.lines.push(L);
    }
  }
  return paras;
}

function breakBetween(P, L, cur, env) {
  const { ratio, bounds } = env;
  const ocr = env.loose;
  const fs = Math.max(P.fs, L.fs);
  const below = L.top >= P.top + 0.3 * fs && L.top - P.bot < 4 * fs;
  const overlapX = L.x0 < P.x1 && L.x1 > P.x0;
  if (P.col !== L.col || !below || !overlapX) {
    // A jump to the next column (or region).
    if (BULLET_START.test(L.text) || isCaption(L.text) || Math.abs(L.fs - P.fs) > (ocr ? 0.3 : 0.12) * Math.min(L.fs, P.fs)) return true;
    if (continues(cur.text, L.text)) return false;
    const bp = bounds.get(P.col);
    const bl = bounds.get(L.col);
    if (bp && bl && env.indents && P.x1 >= bp.right - 1.5 * fs && L.x0 - bl.left < 0.4 * fs && !ENUM_START.test(L.text) && P.bold < 0.85) return false;
    return true;
  }
  if (BULLET_START.test(L.text)) return true;
  if (ENUM_START.test(L.text) && (SENTENCE_END.test(cur.text) || /:$/.test(cur.text) || cur.list)) return true;
  if (isCaption(L.text) && SENTENCE_END.test(cur.text)) return true;
  if (isCaption(cur.lines[0].text) && cur.lines.length === 1 && SENTENCE_END.test(P.text)) return true;
  const sizeTol = ocr ? 0.3 : 0.12;
  if (Math.abs(L.fs - P.fs) > sizeTol * Math.min(L.fs, P.fs)) return !(ocr && continues(cur.text, L.text));
  if (!ocr && P.bold >= 0.85 !== L.bold >= 0.85 && !/[-,]$/.test(P.text)) {
    // a bold heading line over body text, or the reverse
    if (P.bold >= 0.85 ? !SENTENCE_END.test(P.text) || cur.lines.length <= 2 : true) return true;
  }
  // Extra space between lines. A sentence that runs on (no end on this line, a lowercase
  // word or the rest of a broken word next) is one paragraph however loosely it is set:
  // only a gap of about a blank line splits it (OCR'd pages at 1.6x spacing, and short
  // pages with too few lines to measure the spacing).
  const pitch = L.base - P.base;
  const runOn = (/^\p{Ll}/u.test(L.text) && !/[.!?…:]["”’')\]]*$/.test(P.text)) || (/\p{L}[-‐­]$/u.test(P.text) && /^\p{L}/u.test(L.text));
  if (ratio && !ocr) {
    if (pitch - ratio * fs > Math.max(0.2 * fs, 1.5)) return true;
  } else if (ratio && ocr) {
    if (pitch - ratio * fs > (runOn ? 0.9 : 0.5) * fs) return true;
  } else if (L.top - P.bot > (runOn ? 1.2 : 0.6) * fs) return true;
  const b = bounds.get(L.col) || { left: P.x0, right: P.x1 };
  const width = b.right - b.left;
  const tol = ocr ? 0.8 * fs : 0.5 * fs;
  // List item continuation lines hang under the item's text.
  if (cur.list && cur.hang != null && Math.abs(L.x0 - cur.hang) < tol) return false;
  if (cur.list && L.x0 > b.left + tol) return false;
  // First-line indent.
  const indented = L.x0 - b.left > (ocr ? 1.2 : 0.8) * fs && L.x0 - b.left < 10 * fs;
  if (indented && Math.abs(P.x0 - b.left) < tol && (TERMINAL.test(P.text) || P.x1 < b.right - 3 * fs)) return true;
  // Back out of an indented block (a quote) after it ends. Not after the full first line of
  // a paragraph on a page that indents first lines: that line just happened to end a sentence.
  const firstLine = cur.lines.length === 1 && env.indents && P.x1 >= b.right - 1.5 * fs;
  if (P.x0 - L.x0 > (ocr ? 1.2 : 0.8) * fs && SENTENCE_END.test(P.text) && !cur.list && !firstLine) return true;
  // A short line that ends a sentence ends the paragraph.
  if (P.x1 < b.right - Math.max(3 * fs, 0.12 * width) && SENTENCE_END.test(P.text) && /^[\p{Lu}\d"“'‘(]/u.test(L.text)) return true;
  return false;
}

// Paragraphs -> typed blocks. body: { fs, bold } of the document's body text.
export function classify(paras, body, ctx = {}) {
  const ocr = !!ctx.loose || ctx.source === 'ocr';
  const out = [];
  for (const p of paras) {
    const text = p.text.replace(/­/g, '').replace(/\s+/g, ' ').replace(/(?: ?\.){4,} ?/g, ' ').trim();
    if (!text) continue;
    const chars = p.lines.reduce((n, l) => n + l.chars, 0) || 1;
    const fs = p.lines.reduce((n, l) => n + l.fs * l.chars, 0) / chars;
    const bold = p.lines.reduce((n, l) => n + l.bold * l.chars, 0) / chars;
    const ratio = body.fs ? fs / body.fs : 1;
    const conf = p.lines.some((l) => l.conf != null) ? avg(p.lines.map((l) => l.conf).filter((c) => c != null)) : undefined;
    let type = 'p';
    const short = p.lines.length <= 3 && text.length <= 200 && !/[.,;]$/.test(text) && !/^\p{Ll}/u.test(text);
    if (isCaption(text) || (!ocr && !p.list && figureText(text, ratio, ctx.words))) type = 'caption';
    else if (short && (ocr ? ratio >= 1.3 : ratio >= 1.15)) type = ratio >= (ocr ? 1.9 : 1.7) ? 'h1' : ratio >= (ocr ? 1.5 : 1.35) ? 'h2' : 'h3';
    else if (!ocr && short && bold >= 0.85 && !body.bold && ratio >= 0.95 && p.lines.length <= 2 && text.length <= 120 && /\p{L}/u.test(text) && !p.bullet) type = 'h4';
    else if (short && ratio >= (ocr ? 0.8 : 0.95) && centeredCaps(p, text, ctx.block)) type = 'h3';
    else if (p.list) type = 'li';
    const b = { type, text };
    b._top = p.lines[0].top;
    b._bot = p.lines[p.lines.length - 1].bot;
    b._ratio = ratio;
    if (type === 'caption') b.skip = 'caption';
    if (conf != null) b.conf = conf;
    out.push(b);
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const NUMBERS_ONLY = /^[\d\s.,%()+\-−–×x/:]+$/;

// Text inside a figure (axis ticks, a legend, labels): a few words, or mostly codes and
// numbers, in a small font, or a line of bare numbers; never a sentence. Kept out of
// the reading like captions.
function figureText(text, ratio, words) {
  if (SENTENCE_END.test(text)) return false;
  const toks = text.split(' ');
  if (ratio <= 0.9 && toks.length >= 2 && NUMBERS_ONLY.test(text) && /\d/.test(text)) return true;
  if (ratio > 0.75) return false;
  if (toks.length <= 8) return true;
  if (!words) return false;
  let real = 0;
  for (const t of toks) {
    const c = core(t);
    if (c.length >= 2 && /^\p{L}+$/u.test(c) && known(words, c)) real++;
  }
  return real < 0.5 * toks.length;
}

// A paragraph broken off by a figure set between the lines of its column (the figure's
// labels and caption come between) runs on after it.
function joinAcrossFigures(blocks, words) {
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i];
    if (a.type !== 'p' || a.skip || a._ratio < 0.9 || !/[\p{Ll},;\-‐]$/u.test(a.text)) continue;
    let j = i + 1;
    while (j < blocks.length && blocks[j].skip === 'caption') j++;
    if (j === i + 1 || j >= blocks.length) continue;
    const b = blocks[j];
    if (b.type !== 'p' || b.skip || b._ratio < 0.9 || !/^\p{Ll}/u.test(b.text)) continue;
    a.text = joinLines(a.text, b.text, words);
    if (typeof b.conf === 'number') a.conf = typeof a.conf === 'number' ? Math.min(a.conf, b.conf) : b.conf;
    blocks.splice(j, 1);
  }
}

// A short centred line in capitals ('CHAPTER VII', 'INTRODUCTION') is a heading even at
// body size.
function centeredCaps(p, text, blk) {
  if (!blk || p.lines.length > 2 || text.length > 120) return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  if (upper < 0.8 * letters.length) return false;
  const mid = (blk.left + blk.right) / 2;
  return p.lines.every((l) => {
    const w = l.x1 - l.x0;
    return w < 0.8 * blk.width && Math.abs((l.x0 + l.x1) / 2 - mid) < 0.06 * blk.width && l.x0 > blk.left + 0.08 * blk.width;
  });
}

/* ---------- a whole page ---------- */

// Lays out one page's segments. ctx: { words, page, source, H, body: { fs, bold },
// repeated: (side, key) => boolean }. Returns { body, headers, footers, notes }.
// Line numbers in a gutter (pleading paper, a bill, a manuscript set with lineno): bare
// numbers in a column outside the text block, each level with a line of text, counting up.
// Not text: they would be read into the body ('... the rain continued. The 2 village ...'),
// and the '1' at the top taken for a page number would take the first line with it as a
// running head. A numbered list is not one: its numbers stand inside the text block.
export function lineNumbers(segs, bodyFs) {
  const nums = segs.filter((s) => /^\d{1,4}$/.test(s.text.trim()));
  const text = segs.filter((s) => /\p{L}/u.test(s.text));
  if (nums.length < 2 || !text.length) return new Set();
  const left = Math.min(...text.map((s) => s.x0));
  const right = Math.max(...text.map((s) => s.x1));
  const level = (s) => text.some((o) => Math.abs(o.base - s.base) < 0.5 * Math.max(o.fs, s.fs));
  const out = new Set();
  for (const side of ['left', 'right']) {
    const outside = nums.filter((s) => (side === 'left' ? s.x1 < left - 0.3 * bodyFs : s.x0 > right + 0.3 * bodyFs) && level(s));
    // the biggest set sharing an edge (right-aligned or left-aligned numbers), within an em
    let best = [];
    for (const a of outside) {
      for (const edge of ['x0', 'x1']) {
        const g = outside.filter((b) => Math.abs(b[edge] - a[edge]) < Math.max(a.fs, bodyFs));
        if (g.length > best.length) best = g;
      }
    }
    if (best.length < 2) continue;
    best.sort((a, b) => a.top - b.top);
    const v = best.map((s) => +s.text.trim());
    const steps = v.slice(1).map((x, i) => x - v[i]);
    const up = steps.filter((d) => d > 0).length;
    // (numbered every fifth or tenth line: two are enough, multiples of 5 a step apart)
    const fives = steps.every((d) => d === steps[0]) && (steps[0] === 5 || steps[0] === 10) && v.every((x) => x % 5 === 0);
    // they count lines: a line's height per step up (numbered paragraphs are further apart)
    const per = steps.map((d, i) => (d > 0 ? (best[i + 1].base - best[i].base) / d : Infinity));
    const pitch = median(per) <= 2.6 * bodyFs && per.filter((p) => p <= 4 * bodyFs).length >= 0.8 * per.length;
    if (pitch && ((best.length >= 5 && up >= 0.8 * steps.length) || (best.length >= 3 && steps.every((d) => d === 1)) || fives)) for (const s of best) out.add(s);
  }
  return out;
}

// A segment that starts or ends with a bare number set well apart from its words (wider than a
// word space, closer than a segment gap): the number and the words as two segments, for
// lineNumbers().
function numberPieces(segs) {
  const bare = (r) => !!r && !r.sup && !r.sub && /^\d{1,4}$/.test(String(r.str).trim());
  const piece = (s, runs) => {
    const p = { runs, x0: Math.min(...runs.map((r) => r.x0)), x1: Math.max(...runs.map((r) => r.x1)), base: s.base, fs: s.fs, top: Math.min(...runs.map((r) => r.top)), bot: Math.max(...runs.map((r) => r.bot)) };
    if (s.zone) p.zone = s.zone;
    finishSegment(p, null);
    return p;
  };
  let split = false;
  const out = [];
  for (const s of segs) {
    const rs = s.runs || [];
    const n = rs.length;
    if (n > 1 && bare(rs[0]) && rs[1].x0 - rs[0].x1 > 0.6 * s.fs) out.push(piece(s, rs.slice(0, 1)), piece(s, rs.slice(1)));
    else if (n > 1 && bare(rs[n - 1]) && rs[n - 1].x0 - rs[n - 2].x1 > 0.6 * s.fs) out.push(piece(s, rs.slice(0, -1)), piece(s, rs.slice(-1)));
    else {
      out.push(s);
      continue;
    }
    split = true;
  }
  return split ? out : segs;
}

export function layoutPage(segs0, ctx) {
  const H = ctx.H;
  const body = ctx.body || { fs: median(segs0.map((s) => s.fs)), bold: false };
  // a line-number gutter is left out before anything else (the pieces are used only then)
  const pieces = numberPieces(segs0);
  const gutter = lineNumbers(pieces, body.fs);
  const segs = gutter.size ? pieces.filter((s) => !gutter.has(s)) : segs0;
  const used = new Set();
  const headers = [];
  const footers = [];
  // Tagged PDFs mark running heads as artifacts; trust that unless it covers most text.
  const total = segs.reduce((n, s) => n + s.chars, 0) || 1;
  const artChars = segs.reduce((n, s) => n + (s.artifact ? s.chars : 0), 0);
  const trustArtifacts = artChars < 0.4 * total;
  if (trustArtifacts) {
    for (const s of segs) {
      if (!s.artifact) continue;
      used.add(s);
      const mid = (s.top + s.bot) / 2;
      if (mid < 0.35 * H) headers.push(s);
      else if (mid > 0.65 * H) footers.push(s);
      // artifacts in the middle of the page (watermarks) are dropped
    }
  }
  const bands = bandSegments(segs, H, body.fs);
  // A page number stands apart on its line; '12 [Ed. 1 reads ...' is a footnote.
  const alone = (s) => !segs.some((o) => o !== s && Math.abs(o.base - s.base) < 0.5 * s.fs && ((o.x0 >= s.x1 - 1 && o.x0 - s.x1 < 2.5 * s.fs) || (s.x0 >= o.x1 - 1 && s.x0 - o.x1 < 2.5 * s.fs)));
  const numbers = new Set(bands.filter((c) => !used.has(c.seg) && !isCaption(c.seg.text) && isPageNumber(c.seg.text) && alone(c.seg)).map((c) => c.seg));
  for (const c of bands) {
    if (used.has(c.seg)) continue;
    if (isCaption(c.seg.text)) continue;
    const pageNo = numbers.has(c.seg);
    // (a bare number repeats on every page; it counts only as a page number, alone)
    let repeats = !pageNo && ctx.repeated && /\p{L}/u.test(c.key) && ctx.repeated(c.side, c.key);
    // A numbered line above the page's own page number is a footnote, not a running foot.
    if (repeats && c.side === 'bottom' && NOTE_START.test(c.seg.text) && [...numbers].some((n) => n.top > c.seg.bot - 0.2 * n.fs)) repeats = false;
    if (pageNo || repeats) {
      used.add(c.seg);
      (c.side === 'top' ? headers : footers).push(c.seg);
    }
  }
  // A running head that shares its line with the page number is a running head too,
  // however garbled its OCR ('bk. n., ch. iv] THE MILLS AND THE BOATS 213').
  // (top only: at the foot, a footnote's last line can share a row with a stray mark;
  // any size: a letter-spaced head in capitals can measure larger than the body)
  const pageNos = headers.filter((h) => isPageNumber(h.text));
  for (const s of segs) {
    if (used.has(s) || s.top > 0.15 * H || s.text.length > 100) continue;
    const mid = (s.top + s.bot) / 2;
    if (pageNos.some((h) => Math.abs((h.top + h.bot) / 2 - mid) < 0.6 * Math.max(h.fs, s.fs) + 2 && Math.abs(h.top - s.top) < 0.8 * Math.max(h.fs, s.fs) + 2)) {
      used.add(s);
      headers.push(s);
    }
  }
  const rest = splitAtNotches(segs.filter((s) => !used.has(s)), body.fs);
  const margin = ctx.margins === false ? null : marginNotes(rest, body.fs, H, !(ctx.loose || ctx.source === 'ocr'));
  if (margin) for (const s of margin.segs) used.add(s);
  const loose = !!ctx.loose || ctx.source === 'ocr';
  const noteSegs = footnoteSegments(rest, H, body.fs, used, loose ? 0.94 : 0.9, loose);
  for (const s of noteSegs) used.add(s);
  const main = rest.filter((s) => !used.has(s));
  if (margin) for (const [s, x] of margin.shift) s.x0n = x;
  const lines = leavesToLines(xycut(main));
  if (margin) for (const s of margin.shift.keys()) delete s.x0n;
  const paras = linesToParagraphs(lines, ctx);
  const blocks = classify(paras, body, { ...ctx, block: textBlock(main) });
  joinAcrossFigures(blocks, ctx.words);
  const noteBlocks = notesFrom([...noteSegs], ctx);
  for (const b of noteBlocks) b.skip = 'footnote';
  const margins = [];
  if (margin) {
    for (const g of margin.groups) {
      // placed before the first body block that reaches down beside it
      let at = blocks.findIndex((b) => b._bot > g.top);
      if (at < 0) at = blocks.length;
      const confs = g.segs.map((x) => x.conf).filter((c) => c != null);
      for (const text of marginText(g, ctx.words)) {
        const b = { type: 'note', text, skip: 'margin', at };
        if (confs.length) b.conf = avg(confs);
        margins.push(b);
      }
    }
  }
  for (const b of blocks) {
    delete b._top;
    delete b._bot;
    delete b._ratio;
  }
  const mk = (list, skip) =>
    list
      .sort((a, b) => a.top - b.top || a.x0 - b.x0)
      .map((s) => ({ type: 'p', text: s.text.replace(/\s+/g, ' ').trim(), skip }))
      .filter((b) => b.text);
  return { body: blocks, headers: mk(headers, 'header'), footers: mk(footers, 'footer'), notes: noteBlocks, margins };
}

function notesFrom(segs, ctx) {
  if (!segs.length) return [];
  const lines = leavesToLines(xycut(segs));
  const notes = [];
  let cur = null;
  const minX = Math.min(...lines.map((l) => l.x0));
  for (const l of lines) {
    const starts = l.marker || NOTE_START.test(l.text);
    // a note whose number was lost: indented where the number stood, after a note that
    // closed its bracket
    const lost = cur && /[\])][”"’]?$/.test(cur.text) && /^[[(“"‘\p{Lu}]/u.test(l.text) && l.x0 > minX + 0.5 * l.fs;
    if (!cur || lost || (starts && l.x0 <= cur.x0 + 1.5 * l.fs)) {
      cur = { text: l.text, x0: l.x0, conf: l.conf };
      notes.push(cur);
    } else cur.text = joinLines(cur.text, l.text, ctx.words);
  }
  return notes.map((n) => {
    const text = n.text
      .replace(/­/g, '')
      .replace(/^(\d{1,3}|[*†‡§¶]{1,3})[.)]?\s*/, (m, k) => (/\d/.test(k) ? k + '. ' : k + ' '))
      .replace(/\s+/g, ' ')
      .trim();
    const b = { type: 'note', text };
    if (n.conf != null) b.conf = n.conf;
    return b;
  });
}
