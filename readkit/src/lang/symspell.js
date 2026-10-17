// SymSpell spelling candidates (symmetric delete index) with an OCR-aware edit
// distance. Lookups use the delete index to find every dictionary word within
// two plain edits of the input's first `prefix` letters, then rank them with a
// weighted Damerau-Levenshtein distance where typical OCR confusions are cheap.
// prefix 5 needs about a quarter of the memory of prefix 7 for the same accuracy.

const CHEAP = 0.6;

// One-for-one confusions, lowercase (inputs are lowercased before comparison).
// Each pair is cheap in both directions.
const SUB_PAIRS = [
  'l1', 'li', 'i1', 'ij', 'l|', 'i|', '1|', 'l!', 'i!', 'o0', 's5', 'b8', 'z2', 'g9', 'q9', 'b6', 'e3', 'a4', 't7',
  'ec', 'ao', 'ns', 'hb', 'ti', 'yv', 'gq', 'ft', 'rt', 'nu', 'ae', 'eo', 'co', 'uv', 'nh', 'tl', 'fl', 't1', 'ou',
];
// Two glyphs read as one, or one read as two ('rn' for 'm', 'li' for 'h').
const MULTI_PAIRS = [
  ['rn', 'm'], ['cl', 'd'], ['li', 'h'], ['ln', 'h'], ['vv', 'w'], ['ii', 'u'], ['ri', 'n'], ['in', 'm'],
  ['fi', 'b'], ['fl', 'b'], ['tl', 'd'], ['nn', 'm'], ['iu', 'm'], ['ni', 'm'], ['lc', 'k'], ['lt', 'k'],
];

const A = 128; // confusions are ASCII; anything else costs 1
const SUB = new Float64Array(A * A).fill(1); // float32 0.6 is 0.6000000238: over a 0.6 limit
for (const p of SUB_PAIRS) {
  SUB[p.charCodeAt(0) * A + p.charCodeAt(1)] = CHEAP;
  SUB[p.charCodeAt(1) * A + p.charCodeAt(0)] = CHEAP;
}
// TWO[pair] = the single glyph code a pair can stand for (either direction).
const TWO = new Int32Array(A * A).fill(-1);
for (const [two, one] of MULTI_PAIRS) TWO[two.charCodeAt(0) * A + two.charCodeAt(1)] = one.charCodeAt(0);

export const confusions = { SUB_PAIRS, MULTI_PAIRS, cost: CHEAP };

const MAXLEN = 48;
const rowsA = new Float64Array(MAXLEN + 1);
const rowsB = new Float64Array(MAXLEN + 1);
const rowsC = new Float64Array(MAXLEN + 1);
const ca = new Int32Array(MAXLEN);
const cb = new Int32Array(MAXLEN);

const subCost = (x, y) => (x === y ? 0 : x < A && y < A ? SUB[x * A + y] : 1);
const pair = (x, y) => (x < A && y < A ? TWO[x * A + y] : -1);

// Weighted edit distance between `a` (OCR text) and `b` (dictionary word). Returns
// Infinity once the distance must exceed `max`.
export function ocrDistance(a, b, maxEdit = Infinity) {
  const max = maxEdit + 1e-9; // sums of 0.6 costs are not exact
  const n = a.length;
  const m = b.length;
  if (a === b) return 0;
  if (Math.abs(n - m) > max * 2 || n > MAXLEN || m > MAXLEN) return Infinity;
  for (let i = 0; i < n; i++) ca[i] = a.charCodeAt(i);
  for (let j = 0; j < m; j++) cb[j] = b.charCodeAt(j);
  let p2 = rowsA;
  let p1 = rowsB;
  let cur = rowsC;
  for (let j = 0; j <= m; j++) p1[j] = j;
  let prevMin = 0;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = ca[i - 1];
    const ap = i > 1 ? ca[i - 2] : -1;
    const two = i > 1 ? pair(ap, ai) : -1; // input pair ap+ai may stand for one glyph
    for (let j = 1; j <= m; j++) {
      const bj = cb[j - 1];
      let v = p1[j - 1] + subCost(ai, bj);
      if (p1[j] + 1 < v) v = p1[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (j > 1) {
        const bp = cb[j - 2];
        if (i > 1 && ai === bp && ap === bj && ai !== bj && p2[j - 2] + 1 < v) v = p2[j - 2] + 1;
        // one input glyph read for two dictionary glyphs ('m' for 'rn')
        if (pair(bp, bj) === ai && p1[j - 2] + CHEAP < v) v = p1[j - 2] + CHEAP;
      }
      // two input glyphs for one dictionary glyph ('rn' for 'm')
      if (two === bj && p2[j - 1] + CHEAP < v) v = p2[j - 1] + CHEAP;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // A later row can still reach back two rows, so stop only when two
    // consecutive rows are both over the limit.
    if (rowMin > max && prevMin > max) return Infinity;
    prevMin = rowMin;
    const t = p2;
    p2 = p1;
    p1 = cur;
    cur = t;
  }
  const d = Math.round(p1[m] * 100) / 100;
  return d > max ? Infinity : d;
}

function deletesOf(key, maxEdit) {
  const seen = new Set([key]);
  let frontier = [key];
  for (let d = 0; d < maxEdit; d++) {
    const next = [];
    for (const s of frontier) {
      if (s.length <= 1) continue;
      for (let i = 0; i < s.length; i++) {
        const t = s.slice(0, i) + s.slice(i + 1);
        if (!seen.has(t)) {
          seen.add(t);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// entries: iterable of [word, count], words lowercase. The delete lists are packed
// into one Int32Array afterwards, which keeps the index around 40 MB.
export function buildIndex(entries, { maxEdit = 2, prefix = 5 } = {}) {
  const words = [];
  const counts = [];
  const ids = new Map();
  const lists = new Map();
  let total = 0;
  for (const [w, c] of entries) {
    if (!w || ids.has(w) || w.length > MAXLEN) continue;
    const id = words.length;
    ids.set(w, id);
    words.push(w);
    counts.push(c);
    total += c;
    const key = w.length > prefix ? w.slice(0, prefix) : w;
    for (const d of deletesOf(key, maxEdit)) {
      const list = lists.get(d);
      if (list) list.push(id);
      else lists.set(d, [id]);
    }
  }
  let size = 0;
  for (const l of lists.values()) size += l.length;
  const flat = new Int32Array(size);
  const keys = new Map();
  let at = 0;
  for (const [k, l] of lists) {
    keys.set(k, at * 4096 + l.length); // start and length in one number (lists stay under 4096)
    if (l.length >= 4096) throw new Error('delete list too long');
    flat.set(l, at);
    at += l.length;
  }
  lists.clear();
  return { words, counts: Float64Array.from(counts), ids, keys, flat, total, maxEdit, prefix };
}

export function count(index, word) {
  const id = index.ids.get(word);
  return id === undefined ? 0 : index.counts[id];
}

// Dictionary words within `maxEdit` (weighted) of `input`, nearest first, then
// most frequent first. `input` should be lowercase.
export function lookup(index, input, { maxEdit = index.maxEdit, filter } = {}) {
  const key = input.length > index.prefix ? input.slice(0, index.prefix) : input;
  const seen = new Set();
  const out = [];
  for (const d of deletesOf(key, index.maxEdit)) {
    const packed = index.keys.get(d);
    if (packed === undefined) continue;
    const start = Math.floor(packed / 4096);
    const end = start + (packed % 4096);
    for (let k = start; k < end; k++) {
      const id = index.flat[k];
      if (seen.has(id)) continue;
      seen.add(id);
      const w = index.words[id];
      // 2-for-1 confusions can cover a length difference of 2 for 1.2.
      if (Math.abs(w.length - input.length) > maxEdit * 2) continue;
      if (filter && !filter(w)) continue;
      const dist = ocrDistance(input, w, maxEdit);
      if (dist <= maxEdit) out.push({ word: w, dist, count: index.counts[id] });
    }
  }
  out.sort((a, b) => a.dist - b.dist || b.count - a.count);
  return out;
}
