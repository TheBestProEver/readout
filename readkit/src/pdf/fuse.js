// Two readings of a scanned page, fused word by word. A scanner's invisible text layer
// (render mode 3 over the page image) is someone else's OCR: usually good, but with its
// own misreads ('whe^l’ a^<' for 'wheel, and'), lost words and lost lines. Our own
// OCR of the rendered page makes different mistakes. Both come with positions, so the
// words can be paired up row by row, and where they disagree the reading that is a
// dictionary word, fits its neighbours and was read with more confidence wins. Where
// they agree the word is all but certain. Pure functions (no DOM), tested in Node.
//
// Coordinates are page points in the layout frame (y down), like layout.js runs.

import { core, known, isJunkToken, wordClass, isBadChar, codeLike } from './quality.js';

/* ---------- the invisible layer's words ---------- */

// Advance widths of Times Roman (1/1000 em). Scanners fit each run of their text layer
// to the width of the line image with horizontal scaling, so relative widths are what
// matter; a serif table is close enough for any font.
const WIDTHS = {
  ' ': 250, a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278, m: 778, n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722, L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  '.': 250, ',': 250, ';': 278, ':': 278, '!': 333, '?': 444, "'": 180, '’': 333, '‘': 333, '"': 408, '“': 444, '”': 444, '(': 333, ')': 333, '[': 333, ']': 333, '-': 333, '–': 500, '—': 1000, '&': 778, '*': 500, '/': 278,
};
const charWidth = (ch) => WIDTHS[ch] || (/\d/.test(ch) ? 500 : /\p{Lu}/u.test(ch) ? 700 : 480);

// Text runs -> words with estimated boxes (pdf.js gives one box per run).
export function runWords(runs) {
  const out = [];
  for (const r of runs) {
    let total = 0;
    for (const ch of r.str) total += charWidth(ch);
    if (!(total > 0) || !(r.x1 > r.x0)) continue;
    const k = (r.x1 - r.x0) / total;
    let x = r.x0;
    let cur = null;
    for (const ch of r.str) {
      const w = charWidth(ch) * k;
      if (ch === ' ') {
        if (cur) out.push(cur);
        cur = null;
      } else {
        if (!cur) cur = { text: '', x0: x, x1: x, top: r.top, bot: r.bot, base: r.base, fs: r.fs, run: r };
        cur.text += ch;
        cur.x1 = x + w;
      }
      x += w;
    }
    if (cur) out.push(cur);
  }
  return out;
}

const LONG_WORD = /\p{L}{3}/u;

// Our OCR's lines (ocrpage.js ocrLines: pixels) -> words in page points.
export function ocrWords(lines, scale, ctxWords = null) {
  const out = [];
  lines.forEach((l, li) => {
    // The line's text size from its words' heights (the median over words of three
    // letters or more): far steadier than the line box, which one tall bracket stretches.
    const hs = l.words.filter((w) => w.box && LONG_WORD.test(w.text)).map((w) => (w.box.y1 - w.box.y0) / scale);
    const wordH = hs.length ? medianOf(hs) : 0;
    for (const w of l.words) {
      const b = w.box || l.box;
      if (!b) continue;
      const top = b.y0 / scale;
      const bot = b.y1 / scale;
      const o = { text: w.text, conf: w.conf, x0: b.x0 / scale, x1: b.x1 / scale, top, bot, line: li, lineTop: l.box.y0 / scale, lineBot: l.box.y1 / scale, wordH, crop: !!l.crop, lineN: l.words.length };
      // a number run into the next word ('1660to'): two words
      const m = /^(\d{2,4})(\p{Ll}{2,}[.,;:]?)$/u.exec(w.text);
      if (m && (TWO.has(core(m[2])) || (core(m[2]).length > 2 && known(ctxWords, core(m[2]))))) {
        const k = o.x0 + ((o.x1 - o.x0) * m[1].length) / w.text.length;
        out.push({ ...o, text: m[1], x1: k - 0.5 }, { ...o, text: m[2], x0: k + 0.5 });
      } else out.push(o);
    }
  });
  return dropRereads(out);
}

// An OCR engine's second look at part of a page can read a line again, as a line of its
// own over the first ('If a person person should should at at'). Of two words on
// different lines in the same place (boxes mostly over each other, or the same word side
// by side), the surer reading stays.
function dropRereads(ws) {
  const sorted = ws.slice().sort((a, b) => a.x0 - b.x0);
  const gone = new Set();
  for (let a = 0; a < sorted.length; a++) {
    const p = sorted[a];
    const ph = p.bot - p.top;
    for (let b = a + 1; b < sorted.length && sorted[b].x0 < p.x1 + ph; b++) {
      const q = sorted[b];
      if (q.line === p.line || q.crop !== p.crop || gone.has(p) || gone.has(q)) continue;
      const qh = q.bot - q.top;
      if (Math.min(p.bot, q.bot) - Math.max(p.top, q.top) < 0.5 * Math.min(ph, qh)) continue;
      const ox = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const np = normWord(p.text);
      const nq = normWord(q.text);
      const touch = ox > -0.6 * Math.min(ph, qh);
      // (or a piece of the word beside it: 'ex' read again next to 'exceed')
      const [short, long] = np.length <= nq.length ? [p, q] : [q, p];
      const ns = normWord(short.text);
      const nl = normWord(long.text);
      if (touch && ns.length >= 2 && ns !== nl && (nl.startsWith(ns) || nl.endsWith(ns))) {
        // (the piece shows where the whole word really starts or ends)
        long.x0 = Math.min(long.x0, short.x0);
        long.x1 = Math.max(long.x1, short.x1);
        gone.add(short);
        continue;
      }
      const same = np && np === nq && touch;
      if (!same && ox < 0.6 * Math.min(p.x1 - p.x0, q.x1 - q.x0)) continue;
      // (equally sure: the word from the fuller line, the engine's first reading)
      const keepP = Math.abs(p.conf - q.conf) < 0.02 ? (p.lineN || 0) >= (q.lineN || 0) : p.conf > q.conf;
      gone.add(keepP ? q : p);
    }
  }
  return gone.size ? ws.filter((w) => !gone.has(w)) : ws;
}

/* ---------- rows and pairing ---------- */

function rowsOf(words) {
  const sorted = words.slice().sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows = [];
  for (const w of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(w.base - last.base) <= 0.25 * Math.min(w.fs, last.words[0].fs)) last.words.push(w);
    else rows.push({ base: w.base, words: [w], ocr: [] });
  }
  for (const r of rows) {
    r.words.sort((a, b) => a.x0 - b.x0);
    r.top = Math.min(...r.words.map((w) => w.top));
    r.bot = Math.max(...r.words.map((w) => w.bot));
    r.x0 = r.words[0].x0;
    r.x1 = Math.max(...r.words.map((w) => w.x1));
    r.fs = Math.max(...r.words.map((w) => w.fs));
  }
  return rows;
}

const vOverlap = (a, b) => (Math.min(a.bot, b.bot) - Math.max(a.top, b.top)) / Math.max(0.1, Math.min(a.bot - a.top, b.bot - b.top));

// Gives each OCR word to the invisible-layer row it sits on: first by the layer words
// right next to it (a margin note and the body beside it can share a band), then by the
// row's whole band. Words on no row form rows of their own (lines the layer lost).
function assign(rows, ocr) {
  const orphans = [];
  for (const o of ocr) {
    const h = o.bot - o.top;
    let best = null;
    let bestS = 0;
    for (const r of rows) {
      if (r.bot < o.top - h || r.top > o.bot + h) continue;
      for (const w of r.words) {
        if (w.x1 < o.x0 - 0.5 * h || w.x0 > o.x1 + 0.5 * h) continue;
        const s = vOverlap(w, o);
        if (s > bestS) (bestS = s), (best = r);
      }
    }
    // (a closer reading of a margin note keeps its own lines unless the layer has
    // words right there)
    if (o.crop && bestS < 0.35) best = null;
    else if (!best || bestS < 0.35) {
      best = null;
      bestS = 0;
      for (const r of rows) {
        if (o.x1 < r.x0 - 3 * r.fs || o.x0 > r.x1 + 3 * r.fs) continue;
        const s = vOverlap(r, o);
        if (s > bestS) (bestS = s), (best = r);
      }
      if (bestS < 0.5) best = null;
    }
    if (best) best.ocr.push(o);
    else orphans.push(o);
  }
  return orphans;
}

/* ---------- aligning two word sequences ---------- */

const normWord = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

function lev(a, b) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Math.max(n, m);
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

function textCost(a, b) {
  if (!a && !b) return 0.3;
  if (a === b) return 0;
  // (no word is this long: a run of junk, compared cheaply)
  if (a.length > 64 || b.length > 64) return Math.min(1, Math.abs(a.length - b.length) / Math.max(a.length, b.length) + 0.5);
  return lev(a, b) / Math.max(a.length, b.length);
}

const span = (ws) => ({ x0: ws[0].x0, x1: ws[ws.length - 1].x1 });

// Monotone alignment of the row's layer words H with its OCR words O, allowing a word
// on one side to match two or three on the other ('There are two' / 'Therearetwo').
// Returns units [{ H: [...], O: [...] }] in reading order.
export function align(H, O) {
  const n = H.length;
  const m = O.length;
  const INF = 1e9;
  const D = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const P = new Int8Array((n + 1) * (m + 1) * 2);
  const at = (i, j) => i * (m + 1) + j;
  D[0] = 0;
  const hn = H.map((w) => normWord(w.text));
  const on = O.map((w) => normWord(w.text));
  const geo = (hs, os) => {
    const a = span(hs);
    const b = span(os);
    const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const fs = hs[0].fs || 10;
    return ov > -0.6 * fs ? 0 : Math.min(1, (-ov - 0.6 * fs) / (3 * fs));
  };
  const steps = [
    [1, 1],
    [1, 0],
    [0, 1],
    [2, 1],
    [1, 2],
    [3, 1],
    [1, 3],
  ];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const base = D[at(i, j)];
      if (base >= INF) continue;
      for (const [di, dj] of steps) {
        const i2 = i + di;
        const j2 = j + dj;
        if (i2 > n || j2 > m) continue;
        let c;
        if (!di || !dj) c = 0.9;
        else {
          const a = hn.slice(i, i2).join('');
          const b = on.slice(j, j2).join('');
          c = textCost(a, b) + 0.12 * (di + dj - 2) + geo(H.slice(i, i2), O.slice(j, j2));
          if (di + dj > 2 && a !== b) c += 0.7; // merges must be near-exact
        }
        const k = at(i2, j2);
        if (base + c < D[k]) {
          D[k] = base + c;
          P[2 * k] = di;
          P[2 * k + 1] = dj;
        }
      }
    }
  }
  const units = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const k = at(i, j);
    const di = P[2 * k];
    const dj = P[2 * k + 1];
    units.push({ H: H.slice(i - di, i), O: O.slice(j - dj, j) });
    i -= di;
    j -= dj;
  }
  return units.reverse();
}

/* ---------- choosing a reading ---------- */

// Marks a scanner's OCR uses for doubt, and the specks OCR turns into symbols.
const ODD = /[\^~\\{}|<>_`°¬©®™«»¤¦¨•■□]/;
const EDGE_OK = /^[(["“‘'¿¡]*[\p{L}\p{N}]|^[&—–-]$|^[(["“‘']*&c\./u;

// Two-letter words. The word list also holds 'rr', 'ar', 'th' (abbreviations, web
// noise), which in a scan are mostly specks and broken words.
const TWO = new Set('am an as at ax be by do eh go ha he hi ho if in is it lo ma me mi my no of oh ok on or ow ox pa so to up us we ye yo'.split(' '));
// Two-letter abbreviations that take a full stop.
const ABBR2 = new Set('mr dr st jr sr co cf vs pt ch bk ed pp no vi ii iv ix xi xv xx ms mt ft rd av lb oz yd km cm mm kg mg ml hr pm am ca ff op cp ib id fo fr gr mo wk yr bp'.split(' '));

function tokScore(t, words) {
  if (!t) return -1;
  for (const ch of t) if (isBadChar(ch.codePointAt(0))) return -4;
  if (ODD.test(t)) return -3;
  const c = core(t);
  if (!c) return /^[&—–-]$/.test(t) ? 0 : -1.5;
  if (t.length > 1 && t.includes('*')) return -2; // a speck: 'ou*', '1*'
  let s;
  if (/^\d+(?:[.,:/-]\d+)*$/.test(c)) s = 0.5;
  // amounts and codes ('3s.', '6d.', '2nd', '10km', 'B12'), dotted abbreviations ('a.m.')
  else if ((/\d/.test(c) && /\p{L}/u.test(c) && codeLike(c)) || /^(?:\p{L}\.){1,4}\p{L}?$/u.test(c + (/\.$/.test(t) ? '.' : ''))) s = 0.5;
  else if (c.length <= 2 && /^\p{L}+$/u.test(c) && !/^(?:[aAIO]|\p{Lu}\p{Lu})$/u.test(c) && !TWO.has(c.toLowerCase())) {
    // a lone letter or letter pair: an abbreviation when a full stop follows ('p.',
    // '&c.', 'ed.'), otherwise most likely a speck read as a letter
    s = /\.$/.test(t.replace(/[)\]”’"']+$/, '')) && (c.length === 1 || ABBR2.has(c.toLowerCase())) ? 0.5 : -0.8;
  }
  else if (known(words, c)) s = 2 + Math.min(0.3, Math.log10(1 + (words.freq ? words.freq(c) : 0)) / 30);
  else if (isJunkToken(t, words)) s = -3;
  else {
    const k = wordClass(words, c);
    s = k === 'plausible' && /^\p{Lu}\p{Ll}+$/u.test(c) ? 0.4 : k === 'plausible' ? -0.6 : -1.5;
  }
  if (!EDGE_OK.test(t)) s -= 0.6; // a stray mark before the word: ’are
  return s;
}

const meanScore = (toks, words) => (toks.length ? toks.reduce((s, t) => s + tokScore(t, words), 0) / toks.length : -1);

// Context: does the pair (a, b) occur in English?
function pairBonus(bigrams, a, b) {
  if (!bigrams || !a || !b) return 0;
  const x = normWord(a);
  const y = normWord(b);
  if (!x || !y) return 0;
  return bigrams.get(x, y) > 0 ? 0.2 : 0;
}

// A footnote reference glued to its word: 'remarkable1', 'workers.2', 'careful,3'.
const GLUED = /^(.*\p{L}[.,;:!?)\]’”"']?)(\d{1,2})$/u;
// What OCR makes of a superscript digit.
const SUP_READ = /^[’'”"*°¹²³⁴⁵⁶⁷⁸⁹\d]$/u;

const ETC = /^[(["“‘']*&c\.$/u;

// seen: OCR's reading of the same word. A two-letter word ('at9') counts only when OCR
// saw it with a raised mark after it ('it’'): 'is1' alone may be a misread 'isl'.
function gluedMarker(t, words, seen) {
  const m = GLUED.exec(t);
  if (!m) return null;
  if (ETC.test(m[1]) && m[2] !== '0') return { word: m[1], mark: m[2] }; // '&c.7'
  const c = core(m[1]);
  if (!/^\p{L}+$/u.test(c) || !known(words, c) || m[2] === '0') return null;
  if (c.length === 2) {
    const sup = seen && seen.length === m[1].length + 1 && seen.startsWith(m[1]) && SUP_READ.test(seen.slice(-1)) && !/\d/.test(seen.slice(-1));
    if (!TWO.has(c.toLowerCase()) || !sup) return null;
  } else if (c.length < 3) return null;
  return { word: m[1], mark: m[2] };
}

// What a scanner's OCR writes for a letter it doubts, and the letters it may stand for.
const STANDS_FOR = { '°': 'o', '^': 'li', '0': 'o', '1': 'li', '|': 'liI', '<': 'ce', '~': 'n' };
const MARKS_AT_EDGE = /^[\^~°*•]+|[\^~°*•]+$/g;
const LEAD_O = /^([(["“‘']*)[QD](\p{Ll}[\p{Ll}.,;:!?)\]’”"']*)$/u;

// Mends a layer token whose only fault is a doubt mark: strips marks at the edges,
// then tries the letters one inner mark may stand for. Returns the token unchanged
// when no single mended spelling is a dictionary word.
export function repair(t, words) {
  // (no dictionary word is this long; each candidate costs the token's length)
  if (t.length > 40) return t;
  // a round letter read as a capital Q or D: 'Qf', 'Df' for 'of', 'Dther' for 'other'
  const q = LEAD_O.exec(t);
  if (q && !known(words, core(t))) {
    const cand = q[1] + 'o' + q[2];
    if (known(words, core(cand))) return cand;
  }
  if (!ODD.test(t) && !/\p{L}[01|]|[01|]\p{L}/u.test(t)) return t;
  const chars = [...t];
  const found = new Set();
  let odd = 0;
  const letter = (i) => i >= 0 && i < chars.length && /\p{L}/u.test(chars[i]);
  chars.forEach((ch, i) => {
    const alts = STANDS_FOR[ch];
    if (!alts) return;
    // a digit or bar counts only inside a word ('m0ving'), never in '1st' or 'B12'
    if (/[01|]/.test(ch) && !(letter(i - 1) && letter(i + 1))) return;
    odd++;
    for (const a of alts) {
      const cand = chars.slice(0, i).join('') + a + chars.slice(i + 1).join('');
      const c = core(cand);
      if (!ODD.test(cand) && /^\p{L}+$/u.test(c) && known(words, c)) found.add(cand);
    }
  });
  if (odd === 1 && found.size === 1) return [...found][0];
  const bare = t.replace(MARKS_AT_EDGE, '');
  const c = core(bare);
  if (bare !== t && c.length >= 3 && !ODD.test(bare) && known(words, c)) return bare;
  return t;
}

const HIDDEN_CONF = 0.82;
const CONF_W = 2; // how much a confidence point is worth against a dictionary verdict

// Decides one aligned unit. Returns [{ text, conf, from: 'both'|'layer'|'ocr', src: words, mark? }].
export function decide(u, ctx) {
  const { words, bigrams } = ctx;
  const H = u.H.map((w) => w.text);
  const O = u.O.map((w) => w.text);
  const oConf = u.O.length ? u.O.reduce((s, w) => s + w.conf, 0) / u.O.length : 0;
  const out = (toks, from, conf) => toks.map((text, k) => ({ text, conf, from, src: from === 'ocr' ? u.O : from === 'layer' ? u.H : [...u.H, ...u.O], k, n: toks.length }));

  // Footnote markers first: the layer often keeps the digit that OCR reads as a quote.
  if (H.length === 1 && O.length <= 1) {
    const g = gluedMarker(H[0], words, O[0]);
    if (g && (!O.length || normWord(O[0]) === normWord(g.word) || (O[0].startsWith(g.word.replace(/[.,;:!?)\]’”"']$/, '')) && SUP_READ.test(O[0].slice(-1))))) {
      const r = out([g.word], O.length ? 'both' : 'layer', O.length ? 0.97 : HIDDEN_CONF);
      r[0].mark = g.mark;
      return r;
    }
  }
  // One layer token holding two words where OCR read two, one of them the same
  // ('Qfwater,' / 'ft water,'): split the layer token there and settle each part.
  if (H.length === 1 && O.length >= 2 && !ctx.split && !known(words, core(H[0]))) {
    const parts = splitLike(u.H[0], u.O);
    if (parts) {
      const sub = { ...ctx, split: true };
      const a = { H: [{ ...parts[0], text: repair(parts[0].text, words) }], O: parts[2] };
      const b = { H: [parts[1]], O: parts[3] };
      const ta = decide(a, { ...sub, next: parts[3][0].text });
      const tb = decide(b, { ...sub, prev: ta.length ? ta[ta.length - 1].text : ctx.prev });
      for (const t of ta) t.box = boxOf(t, a);
      for (const t of tb) t.box = boxOf(t, b);
      return [...ta, ...tb];
    }
  }
  if (!H.length) {
    // OCR only: keep real words and numbers; drop OCR noise.
    return out(O, 'ocr', oConf).filter((t) => {
      const s = tokScore(t.text, words);
      return s >= 1.5 ? oConf >= 0.45 : s >= 0 ? oConf >= 0.6 : s > -1 && oConf >= 0.85;
    });
  }
  if (!O.length) {
    // Layer only: OCR saw nothing there. Keep words and numbers, mended where one
    // doubtful mark stands for a letter ('Gr°und', 'whe^l').
    // In a margin strip read up close, a mark the close reading didn't see there is a
    // speck the scanner read ('6', 't0'); only a real word stays.
    const real = (t) => {
      const c = core(t);
      return c.length >= 3 && /^\p{L}+$/u.test(c) && known(words, c);
    };
    return out(H.map((t) => repair(t, words)), 'layer', HIDDEN_CONF).filter((t) => tokScore(t.text, words) >= 0 && (!ctx.strip || real(t.text)));
  }
  const hn = H.map(normWord).join('');
  const on = O.map(normWord).join('');
  // Both read only marks here: specks, unless a dash or an ampersand.
  if (!hn && !on) return out(H, 'both', 0.9).filter((t) => tokScore(t.text, words) >= 0);
  if (hn === on && H.length === O.length) {
    // Agreement on the letters: pick the cleaner spelling of each word (punctuation, case).
    return H.map((h, k) => {
      const o = O[k];
      const sh = tokScore(h, words);
      const so = tokScore(o, words);
      const pick = so > sh + 0.01 ? o : sh > so + 0.01 ? h : u.O[k].conf >= 0.7 ? o : h;
      return { text: pick, conf: 0.99, from: 'both', src: [u.H[k], u.O[k]], k, n: H.length };
    });
  }
  // Both readings broken in different places ('ha<^ves*ed' / ';a rvested'): letters
  // where they agree, and the one dictionary word their differences allow.
  const isWord = (t) => {
    const c = core(t);
    return c.length > 2 && /^\p{L}+$/u.test(c) && known(words, c);
  };
  if (H.length <= 2 && O.length <= 2 && hn.length >= 4 && on.length >= 4 && !H.some(isWord) && !O.some(isWord)) {
    const m = mergeLetters(hn, on, words);
    if (m) return [{ text: dress(m, H, O), conf: 0.8, from: 'both', src: [...u.H, ...u.O], k: 0, n: 1 }];
  }
  let sh = meanScore(H, words) + CONF_W * HIDDEN_CONF;
  let so = meanScore(O, words) + CONF_W * oConf;
  sh += pairBonus(bigrams, ctx.prev, H[0]) + pairBonus(bigrams, H[H.length - 1], ctx.next);
  so += pairBonus(bigrams, ctx.prev, O[0]) + pairBonus(bigrams, O[O.length - 1], ctx.next);
  if (hn === on) {
    // Same letters, different splits ('There are two' / 'Therearetwo'): the split
    // into dictionary words wins.
    return so >= sh ? out(O, 'both', 0.95) : out(H, 'both', 0.95);
  }
  // The loser's reading still counts as weak evidence: an agreeing first letter, a
  // close spelling, means the winner is probably right.
  const close = textCost(hn, on) <= 0.34;
  const won = so >= sh ? out(O, 'ocr', close ? Math.max(oConf, 0.85) : oConf * 0.9) : out(H, 'layer', close ? 0.85 : HIDDEN_CONF * 0.85);
  // Neither reading may be right (both garbled): keep only what looks like words.
  const kept = won.filter((t) => {
    const s = tokScore(t.text, words);
    return s > -2.5 && (s >= 0 || t.conf >= 0.85);
  });
  // A footnote reference the layer kept as digits and OCR as a quote ('1702,13' /
  // '1702,"'): the quote is the raised number.
  const last = kept[kept.length - 1];
  const dm = /[.,;:]\d{1,2}$/.exec(H[H.length - 1]);
  if (last && last.from === 'ocr' && dm && /[\p{L}\p{N}][.,;:]["”’']$/u.test(last.text) && last.text.slice(-2, -1) === dm[0][0]) {
    last.text = last.text.slice(0, -1);
    last.mark = dm[0].slice(1);
  }
  return kept;
}

// A layer word that holds two OCR words, the last (or first) of them read alike:
// [first part, second part, OCR words of the first, OCR words of the second], or null.
function splitLike(h, O) {
  const t = h.text;
  if (t.length > 40) return null; // (each cut costs the token's length)
  const tail = normWord(O[O.length - 1].text);
  const head = normWord(O[0].text);
  const piece = (a, b, text) => {
    const k = (h.x1 - h.x0) / Math.max(1, t.length);
    return { ...h, text, x0: h.x0 + a * k, x1: h.x0 + b * k };
  };
  const before = normWord(O.slice(0, -1).map((o) => o.text).join(''));
  const after = normWord(O.slice(1).map((o) => o.text).join(''));
  for (let p = 1; p < t.length; p++) {
    const left = t.slice(0, p);
    const right = t.slice(p);
    const nl = normWord(left);
    const nr = normWord(right);
    if (!nl || !nr) continue;
    if (tail.length >= 3 && nr === tail && before && nl !== before) return [piece(0, p, left), piece(p, t.length, right), O.slice(0, -1), O.slice(-1)];
    if (head.length >= 3 && nl === head && after && nr !== after) return [piece(0, p, left), piece(p, t.length, right), O.slice(0, 1), O.slice(1)];
  }
  return null;
}

// Aligns two lowercase spellings letter by letter and tries every way of settling the
// places they differ (at most 5): returns the most frequent dictionary word, or null.
function mergeLetters(a, b, words) {
  const n = a.length;
  const m = b.length;
  if (n > 30 || m > 30) return null;
  const D = [];
  for (let i = 0; i <= n; i++) {
    D.push(new Array(m + 1).fill(0));
    D[i][0] = i;
  }
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  if (D[n][m] > Math.max(2, 0.4 * Math.max(n, m))) return null;
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) ops.push([a[--i], b[--j]]);
    else if (i > 0 && D[i][j] === D[i - 1][j] + 1) ops.push([a[--i], '']);
    else ops.push(['', b[--j]]);
  }
  ops.reverse();
  let cands = [''];
  let diffs = 0;
  for (const [x, y] of ops) {
    if (x === y) {
      cands = cands.map((c) => c + x);
      continue;
    }
    if (++diffs > 5) return null;
    // (a substitution may also be two letters, each reading having lost one)
    cands = cands.flatMap((c) => (x && y ? [c + x, c + y, c + x + y, c + y + x] : [c + x, c + y]));
  }
  let best = null;
  let bestF = -1;
  const near = Math.max(n, m) >= 9 ? 3 : 2;
  for (const c of new Set(cands)) {
    if (c.length < 3 || !words.has(c) || lev(c, a) > near || lev(c, b) > near) continue;
    const f = words.freq ? words.freq(c) : 1;
    if (f > bestF) (bestF = f), (best = c);
  }
  return best;
}

// A merged spelling, with the case and the edge punctuation of the readings.
function dress(w, H, O) {
  const h = H.join('');
  const o = O.join('');
  const first = (t) => (t.match(/\p{L}/u) || [''])[0];
  const lead = (t) => (t.match(/^[(["“‘']+/) || [''])[0];
  const tail = (t) => (t.match(/[.,;:!?)\]”’"']+$/) || [''])[0];
  const cap = /\p{Lu}/u.test(first(h) || first(o)) && /\p{Lu}/u.test(first(o) || first(h));
  const word = cap ? w[0].toUpperCase() + w.slice(1) : w;
  return (lead(h) || lead(o)) + word + (tail(h) || tail(o));
}

/* ---------- the whole page ---------- */

// layerRuns: the page's text-layer runs (layout frame); ocrLinesPt: OCR lines as from
// ocrLines(); scale: OCR pixels per point. ctx: { words, bigrams }.
// Returns { runs, stats } where runs are layout runs (one per word) with conf, ready
// for segmentsOf(); footnote markers come out as separate superscript runs.
export function fusePage(layerRuns, ocrLinesPx, scale, ctx, { zones } = {}) {
  const words = ctx.words;
  const H = runWords(layerRuns);
  const O = ocrLinesPx && ocrLinesPx.length ? ocrWords(ocrLinesPx, scale, words) : [];
  // Inside a margin-note zone read up close, the close reading's lines are the rows
  // (a note's tight lines would otherwise mix); elsewhere the layer's rows are.
  const Oz = O.filter((o) => o.crop);
  const zoned = zones && zones.length ? (w) => inZone(zones, w) && !outOfStrip(zones, w, Oz) : () => false;
  const Hz = H.filter(zoned);
  const rows = rowsOf(H.filter((w) => !zoned(w)));
  const orphans = assign(rows, O.filter((o) => !o.crop));
  const stats = { layerWords: H.length, ocrWords: O.length, agree: 0, layer: 0, ocr: 0, ocrRows: 0 };

  // Font size from OCR line heights, calibrated against the layer where both exist.
  const ratios = [];
  for (const r of rows) for (const o of r.ocr) if (o.lineBot > o.lineTop) ratios.push(r.fs / (o.lineBot - o.lineTop));
  ratios.sort((a, b) => a - b);
  const fsPerH = ratios.length >= 5 ? ratios[ratios.length >> 1] : 0.83;
  const wr = [];
  for (const r of rows) for (const o of r.ocr) if (o.wordH > 0) wr.push(r.fs / o.wordH);
  const fsPerWordH = wr.length >= 5 ? medianOf(wr) : 1.04;
  const firstZoneRow = rows.length;
  if (Hz.length || Oz.length) rows.push(...lineRows(Hz, Oz, fsPerH, words));
  const zoneRows = rows.length;

  const fused = []; // { text, conf, x0, x1, top, bot, base, fs, mark, row }
  const ocrRowFs = (o) => (o.wordH > 0 ? o.wordH * fsPerWordH : (o.lineBot - o.lineTop) * fsPerH);
  const lonelyRows = O.length === 0;
  const aligned = rows.map((r) => {
    r.ocr.sort((a, b) => a.x0 - b.x0);
    return align(r.words, r.ocr);
  });
  // (OCR word boxes can't correct the layer's sizes: italic ascenders and descenders
  // make a 7 pt note word's box as tall as a 10 pt body word's.)
  const sizeOf = (w) => w.fs;
  rows.forEach((r, ri) => {
    const units = aligned[ri];
    let prev = '';
    units.forEach((u, ui) => {
      const nx = units[ui + 1];
      const next = nx ? (nx.O[0] || nx.H[0] || {}).text : '';
      const toks = decide(u, { words, bigrams: ctx.bigrams, prev, next, lonely: lonelyRows || !r.ocr.length, strip: ri >= firstZoneRow && ri < zoneRows && r.ocr.length > 0 });
      for (const t of toks) {
        const box = boxOf(t, u);
        const fs = u.H.length ? u.H.reduce((s, w) => s + sizeOf(w), 0) / u.H.length : r.words.length ? nearestFs(r, box, sizeOf) : r.fs;
        fused.push({ text: t.text, conf: t.conf, mark: t.mark, from: t.from, ...box, base: r.base, fs, row: ri });
        stats[t.from === 'both' ? 'agree' : t.from]++;
        prev = t.text;
      }
    });
  });
  // OCR lines the layer lost entirely.
  const byLine = new Map();
  for (const o of orphans) {
    if (!byLine.has(o.line)) byLine.set(o.line, []);
    byLine.get(o.line).push(o);
  }
  for (const [, ws] of byLine) {
    ws.sort((a, b) => a.x0 - b.x0);
    const ri = rows.length + stats.ocrRows++;
    let prev = '';
    for (let k = 0; k < ws.length; k++) {
      const o = ws[k];
      const toks = decide({ H: [], O: [o] }, { words, bigrams: ctx.bigrams, prev, next: (ws[k + 1] || {}).text });
      for (const t of toks) {
        const fs = ocrRowFs(o);
        fused.push({ text: t.text, conf: t.conf, from: 'ocr', x0: o.x0, x1: o.x1, top: o.top, bot: o.bot, base: o.lineBot - 0.22 * fs, fs, row: ri });
        stats.ocr++;
        prev = t.text;
      }
    }
  }
  tidyRows(fused);
  if (zones && zones.length) {
    for (const w of fused) {
      // (a layer word kept out of the strip stays with the body row it went to)
      if (w.row < firstZoneRow || w.row >= zoneRows) continue;
      const cx = (w.x0 + w.x1) / 2;
      const cy = (w.top + w.bot) / 2;
      const z = zones.find((z) => cx >= z.x0 && cx <= z.x1 && cy >= z.top && cy <= z.bot);
      if (z) w.zone = z.kind || 'margin';
    }
  }
  const kept = fused.filter((w) => !w.ref);
  return { runs: toRuns(kept), words: kept, stats };
}

// Per row: a footnote reference read as a word of its own ('instant 10 in', the layer
// setting '10' in a small font, our OCR boxing it small and raised) becomes the mark of
// the word before it; and a short token takes the size of the words around it (a
// scanner may give a lone '6' the size of the line above).
function tidyRows(fused) {
  const rows = new Map();
  for (const w of fused) {
    if (!rows.has(w.row)) rows.set(w.row, []);
    rows.get(w.row).push(w);
  }
  for (const list of rows.values()) {
    list.sort((a, b) => a.x0 - b.x0);
    // a row of one short token only one reading saw: a speck between lines
    if (list.length === 1 && list[0].from !== 'both' && core(list[0].text).length <= 2 && !/^\d+$/.test(core(list[0].text))) {
      list[0].ref = true;
      continue;
    }
    const long = list.filter((w) => /\p{L}{3}/u.test(w.text));
    const rowFs = medianOf(long.map((w) => w.fs));
    const boxH = medianOf(long.filter((w) => w.from !== 'layer').map((w) => w.bot - w.top));
    for (let k = 1; k < list.length; k++) {
      const w = list[k];
      const p = list[k - 1];
      if (!rowFs || !/^\d{1,3}$/.test(w.text) || p.mark || p.ref || !/(?:\p{L}{2}|[.,;:!?)\]"”’])$/u.test(p.text)) continue;
      if (w.x0 - p.x1 > 0.4 * rowFs) continue;
      const small = w.fs <= 0.7 * rowFs;
      const raised = w.from !== 'layer' && boxH > 0 && w.bot - w.top < 0.65 * boxH && w.bot < w.base - 0.25 * rowFs;
      if (small || raised) {
        p.mark = w.text;
        w.ref = true;
      }
    }
    if (!long.length) continue;
    // a word the layer gave a size half as big again as the rest of its row, though the
    // image shows it no taller ('frugality' at 15 pt among 10 pt words)
    for (const w of long) {
      if (!(w.fs > 1.3 * rowFs) || w.from === 'layer') continue;
      const others = long.filter((o) => o !== w && o.from !== 'layer' && o.fs <= 1.1 * rowFs).map((o) => o.bot - o.top);
      if (others.length >= 2 && w.bot - w.top <= 1.1 * Math.max(...others)) w.fs = rowFs;
    }
    for (const w of list) {
      if (w.ref || core(w.text).length > 2) continue;
      // the closest long word, edge to edge, if it is right next to this one
      let best = null;
      let d = Infinity;
      for (const o of long) {
        const dd = Math.max(o.x0 - w.x1, w.x0 - o.x1);
        if (dd < d) (d = dd), (best = o);
      }
      if (best && d < 1.5 * best.fs && Math.abs(best.base - w.base) < 0.5 * best.fs && best.fs < w.fs) w.fs = best.fs;
    }
  }
}

// A layer word whose box sticks out of a strip towards the body (the layer's boxes are
// estimates, and a misread size stretches them: 'or' at 15 pt) belongs to the strip only
// if the close reading saw it there.
function outOfStrip(zones, w, Oz) {
  const cx = (w.x0 + w.x1) / 2;
  const cy = (w.top + w.bot) / 2;
  const z = zones.find((q) => cx >= q.x0 && cx <= q.x1 && cy >= q.top && cy <= q.bot);
  if (!z || (z.side === 'right' ? w.x0 >= z.x0 : w.x1 <= z.x1)) return false;
  const nw = normWord(w.text);
  return !Oz.some((o) => o.x1 > w.x0 && o.x0 < w.x1 && Math.abs((o.top + o.bot) / 2 - cy) < w.fs && textCost(normWord(o.text), nw) <= 0.34);
}

function inZone(zones, w) {
  const cx = (w.x0 + w.x1) / 2;
  const cy = (w.top + w.bot) / 2;
  return zones.some((z) => cx >= z.x0 && cx <= z.x1 && cy >= z.top && cy <= z.bot);
}

// Rows from a close reading's lines: each OCR line takes the layer words it overlaps
// most; layer words on no line keep rows of their own.
function lineRows(Hz, Oz0, fsPerH, words) {
  // (the strip's edge can cut through the next line: the tops of its letters, read as
  // '1 1', are far shorter than the strip's words)
  const hs = Oz0.filter((o) => LONG_WORD.test(o.text)).map((o) => o.bot - o.top);
  const wordH = hs.length ? medianOf(hs) : 0;
  const Oz = wordH ? Oz0.filter((o) => o.bot - o.top >= 0.5 * wordH) : Oz0;
  const lines = new Map();
  for (const o of Oz) {
    if (!lines.has(o.line)) lines.set(o.line, { ocr: [], words: [], top: o.lineTop, bot: o.lineBot, x0: o.x0, x1: o.x1 });
    const l = lines.get(o.line);
    l.ocr.push(o);
    l.x0 = Math.min(l.x0, o.x0);
    l.x1 = Math.max(l.x1, o.x1);
  }
  const ls = [...lines.values()];
  // (a line's extent from its words' boxes: a stray bar can make the line box twice as tall)
  for (const l of ls) {
    const real = l.ocr.filter((o) => /[\p{L}\p{N}]{2}/u.test(o.text));
    if (!real.length) continue;
    l.top = medianOf(real.map((o) => o.top));
    l.bot = medianOf(real.map((o) => o.bot));
  }
  // A scanner's layer can sit half a line off the image in a note's small print: a layer
  // word goes to a nearby line that read the same word right there, else the closest.
  // (a line of short letters, 'now.', has a box only an x-height tall)
  const lineH = medianOf(ls.filter((l) => l.ocr.some((o) => LONG_WORD.test(o.text))).map((l) => l.bot - l.top));
  const rest = [];
  for (const w of Hz) {
    const cy = (w.top + w.bot) / 2;
    const nw = normWord(w.text);
    let best = null;
    let bestS = -Infinity;
    for (const l of ls) {
      if (w.x1 < l.x0 - w.fs || w.x0 > l.x1 + w.fs) continue;
      const lh = Math.max(1, l.bot - l.top, lineH);
      const d = Math.abs(cy - (l.top + l.bot) / 2);
      if (d > 0.9 * lh) continue;
      let s = 1 - d / lh;
      const here = l.ocr.filter((o) => o.x1 > w.x0 - 2 && o.x0 < w.x1 + 2);
      if (nw && here.some((o) => normWord(o.text) === nw)) s += 2;
      else if (nw && here.some((o) => textCost(normWord(o.text), nw) <= 0.34)) s += 1;
      if (s > bestS) (bestS = s), (best = l);
    }
    if (best) best.words.push(w);
    else rest.push(w);
  }
  // A layer word the close reading saw nowhere: a speck the scanner read ('6', 't0') or
  // a word it set half a line off and twice ('now.' and "now'"). Only a real word read
  // nowhere near stays.
  const kept = rest.filter((w) => {
    const c = core(w.text);
    if (!(c.length >= 3 && /^\p{L}+$/u.test(c) && known(words, c))) return !Oz.length;
    const nw = normWord(w.text);
    const cy = (w.top + w.bot) / 2;
    return !Oz.some((o) => normWord(o.text) === nw && Math.abs((o.top + o.bot) / 2 - cy) < 2.5 * Math.max(lineH, 0.5 * w.fs));
  });
  const out = [];
  // (sizes from the layer, which knows them; positions from the image, which the layer
  // may be off from, so that lines keep their order)
  const zoneFs = medianOf(ls.filter((l) => l.words.length).map((l) => medianOf(l.words.map((w) => w.fs))));
  for (const l of ls) {
    l.words.sort((a, b) => a.x0 - b.x0);
    l.fs = l.words.length ? medianOf(l.words.map((w) => w.fs)) : zoneFs || (l.bot - l.top) * fsPerH;
    // (from the tops of the words: steadier than their bottoms, which a descender or a
    // stray brace can push down)
    l.base = l.top + 0.72 * l.fs;
    if (l.words.length) {
      l.x0 = Math.min(l.x0, l.words[0].x0);
      l.x1 = Math.max(l.x1, ...l.words.map((w) => w.x1));
    }
    out.push(l);
  }
  out.push(...rowsOf(kept));
  return out.sort((a, b) => a.base - b.base);
}

function nearestFs(r, box, sizeOf) {
  let best = r.words[0];
  let d = Infinity;
  for (const w of r.words) {
    const dd = Math.abs((w.x0 + w.x1) / 2 - (box.x0 + box.x1) / 2);
    if (dd < d) (d = dd), (best = w);
  }
  return sizeOf(best);
}

function medianOf(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

// A fused word's box: the OCR box when OCR read it (the layer's boxes are estimates),
// split evenly when one box held several of the chosen words.
function boxOf(t, u) {
  if (t.box) return t.box;
  let src = t.from === 'layer' ? u.H : u.O.length ? u.O : u.H;
  const n = t.n || 1;
  // a speck read as '~' next to a word must not stretch the word's box
  if (src.length > n) {
    const real = src.filter((w) => normWord(w.text));
    if (real.length) src = real;
  }
  if (src.length === n) {
    const w = src[t.k];
    return { x0: w.x0, x1: w.x1, top: w.top, bot: w.bot };
  }
  const x0 = Math.min(...src.map((w) => w.x0));
  const x1 = Math.max(...src.map((w) => w.x1));
  const top = Math.min(...src.map((w) => w.top));
  const bot = Math.max(...src.map((w) => w.bot));
  const step = (x1 - x0) / n;
  return { x0: x0 + t.k * step, x1: x0 + (t.k + 1) * step - 0.15 * step, top, bot };
}

// Fused words -> layout runs. Each word is its own run; footnote markers become small
// raised runs after their word, which the layout drops as note references.
export function toRuns(fused) {
  const runs = [];
  for (const w of fused) {
    const fs = w.fs || 10;
    runs.push({ str: w.text, x0: w.x0, x1: Math.max(w.x1, w.x0 + 0.3 * fs), base: w.base, fs, top: w.base - 0.72 * fs, bot: w.base + 0.22 * fs, font: '', bold: false, artifact: false, conf: w.conf, sp: true, zone: w.zone });
    if (w.mark) {
      const mfs = 0.6 * fs;
      runs.push({ str: w.mark, x0: w.x1, x1: w.x1 + 0.5 * mfs * w.mark.length, base: w.base, fs: mfs, top: w.base - 0.72 * fs, bot: w.base - 0.3 * fs, font: '', bold: false, artifact: false, sup: true, conf: w.conf, zone: w.zone });
    }
  }
  return runs;
}

// How the two readings compare, for tests and the progress log.
export function fuseSummary(stats) {
  const n = stats.agree + stats.layer + stats.ocr || 1;
  return { agree: stats.agree / n, layer: stats.layer / n, ocr: stats.ocr / n, ...stats };
}
