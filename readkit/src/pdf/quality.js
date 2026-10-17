// Is a PDF text layer real English, or garbage from a broken font map? A font with a
// missing or wrong ToUnicode map renders perfectly but extracts as "{P23gf49y". pdf.js
// can't tell us, so we judge the text itself: the share of tokens that look like words
// times the share of those found in the dictionary, plus mixed letter-digit tokens, the
// vowel ratio, odd symbols and private-use/control characters. Each font is also scored
// on its own, so one broken body or heading font is caught among good ones.

const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const VOWEL = /[aeiouyAEIOUYàáâäæèéêëìíîïòóôöœùúûüÿ]/;
// Punctuation and symbols normal text uses. Anything else (~ \ { } | ^ ` < > _ and
// unusual symbols) counts as odd.
const NORMAL_PUNCT = /[.,;:!?'"()[\]\-‐-―‘-‟/&%$£€¥#*+=@§¶†‡•◦▪·°©®™…′″±×÷−←-⇿∀-⋿]/u;
const ODD_INNER = /[~\\{}|^`<>_]/;
const ALNUM = /[\p{L}\p{N}]/u;
const WORDLIKE = /^\p{L}[\p{L}\p{M}'’-]*$/u;
const NUMERIC = /^[+-]?[$£€¥]?\d[\d.,:/x-]*%?$/;
const FORMULA = /^(?:[A-Z][a-z]?\d{0,3}){2,8}$/; // H2O, CO2, H2SO4, C6H12O6

// A token without its leading and trailing punctuation. A loop, not a regex: a
// tail-anchored character run is quadratic on long runs.
export function core(t) {
  const chars = [...t];
  let a = 0;
  let b = chars.length;
  while (a < b && !ALNUM.test(chars[a])) a++;
  while (b > a && !ALNUM.test(chars[b - 1])) b--;
  return a === 0 && b === chars.length ? t : chars.slice(a, b).join('');
}

export function isBadChar(c) {
  return (c >= 0xe000 && c <= 0xf8ff) || c < 32 || c === 0xfffd || (c >= 0x7f && c < 0xa0) || (c >= 0xf0000 && c <= 0x10ffff);
}

// Letter-digit mixes that are normal: 2nd, 1990s, 10km, 4K, 3D, B12, MP3, A4, x86,
// COVID-19, iPhone15, H2O, H2SO4, 3x4, 1080p, F-16. Garbage from a broken font map
// alternates letters and digits many times ("d3zd2", "P23gf49y").
export function codeLike(t) {
  if (t.includes('-')) return t.split('-').every((p) => !p || !(LETTER.test(p) && DIGIT.test(p)) || codeLike(p));
  if (t.length > 14) return false;
  let switches = 0;
  let prev = 0;
  for (const ch of t) {
    const k = DIGIT.test(ch) ? 1 : LETTER.test(ch) ? 2 : 3;
    if (k === 3) return false;
    if (prev && k !== prev) switches++;
    prev = k;
  }
  if (switches <= 1) return true;
  if (FORMULA.test(t)) return true;
  return switches === 2 && t.length <= 6;
}

/* ---------- word-likeness: letter-bigram model built from the word list ---------- */

// Index 0 is the word boundary, 1..26 a-z, 27 apostrophe; other letters are skipped.
function sym(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 97 && c <= 122) return c - 96;
  if (ch === "'" || ch === '’') return 27;
  return -1;
}

// Mean log probability of a word's letter pairs. English words score about -2.3; random
// or shifted letters (a broken map) about -4. Used to give names and jargon partial
// credit and to spot garbage that happens to be all letters.
export function letterModel(words) {
  if (!words || typeof words.entries !== 'function') return null;
  const N = 28;
  const counts = new Float64Array(N * N).fill(0.3);
  let n = 0;
  for (const [w] of words.entries()) {
    if (++n > 60000) break;
    let prev = 0;
    for (const ch of w) {
      const s = sym(ch);
      if (s < 0) continue;
      counts[prev * N + s]++;
      prev = s;
    }
    counts[prev * N]++;
  }
  const logp = new Float64Array(N * N);
  for (let a = 0; a < N; a++) {
    let row = 0;
    for (let b = 0; b < N; b++) row += counts[a * N + b];
    for (let b = 0; b < N; b++) logp[a * N + b] = Math.log(counts[a * N + b] / row);
  }
  return {
    score(word) {
      let prev = 0;
      let sum = 0;
      let k = 0;
      for (const ch of word.toLowerCase()) {
        const s = sym(ch);
        if (s < 0) continue;
        sum += logp[prev * N + s];
        prev = s;
        k++;
      }
      if (!k) return 0;
      sum += logp[prev * N];
      return sum / (k + 1);
    },
  };
}

const PLAUSIBLE = -3.25;

const modelCache = new WeakMap();
function modelFor(words) {
  if (!words || typeof words !== 'object') return null;
  if (!modelCache.has(words)) modelCache.set(words, letterModel(words));
  return modelCache.get(words);
}

export function known(words, w) {
  if (!words) return false;
  if (words.has(w)) return true;
  const lw = w.toLowerCase().replace(/’/g, "'");
  if (/'s$/.test(lw) && words.has(lw.slice(0, -2))) return true;
  if (/s'$/.test(lw) && words.has(lw.slice(0, -1))) return true;
  if (lw.includes('-')) {
    const parts = lw.split('-').filter(Boolean);
    return parts.length > 0 && parts.every((p) => words.has(p));
  }
  return false;
}

// 'known' | 'plausible' (name, jargon) | 'implausible'
export function wordClass(words, w) {
  if (known(words, w)) return 'known';
  const m = modelFor(words);
  if (!m) return 'plausible';
  const letters = w.replace(/[^\p{L}]/gu, '');
  if (letters.length <= 2) return 'plausible';
  if (/^\p{Lu}+$/u.test(letters) && letters.length <= 6) return 'plausible'; // acronyms
  if (!VOWEL.test(letters) && letters.length >= 4) return 'implausible';
  return m.score(letters) >= PLAUSIBLE ? 'plausible' : 'implausible';
}

// One token on its own: would reading it aloud be reading garbage?
export function isJunkToken(raw, words) {
  for (const ch of raw) if (isBadChar(ch.codePointAt(0))) return true;
  const t = core(raw);
  if (!t) return false;
  if (NUMERIC.test(t)) return false;
  if (LETTER.test(t) && DIGIT.test(t) && !codeLike(t)) return !/[@/.]/.test(t) || /[~\\{}|^`<>]/.test(t);
  if (ODD_INNER.test(t)) return !/^[\w.+-]+@[\w.-]+$/.test(t) && !/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(t);
  if (WORDLIKE.test(t)) return t.length >= 3 && wordClass(words, t) === 'implausible';
  return false;
}

/* ---------- text quality ---------- */

export function quality(text, words) {
  const s = String(text || '');
  let chars = 0, letters = 0, vowels = 0, odd = 0, bad = 0;
  for (const ch of s) {
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') continue;
    chars++;
    const c = ch.codePointAt(0);
    if (isBadChar(c)) bad++;
    else if (LETTER.test(ch)) {
      letters++;
      if (VOWEL.test(ch)) vowels++;
    } else if (!DIGIT.test(ch) && !NORMAL_PUNCT.test(ch)) odd++;
  }
  let tokens = 0, neutral = 0, wordlike = 0, knownN = 0, plausible = 0, mixed = 0;
  for (const raw of s.split(/\s+/)) {
    if (!raw) continue;
    tokens++;
    const t = core(raw);
    if (!t || NUMERIC.test(t)) {
      neutral++;
      continue;
    }
    if (LETTER.test(t) && DIGIT.test(t) && !codeLike(t)) mixed++;
    if (!WORDLIKE.test(t)) continue;
    wordlike++;
    const k = wordClass(words, t);
    if (k === 'known') knownN++;
    else if (k === 'plausible') plausible++;
  }
  const content = tokens - neutral;
  const m = {
    chars,
    tokens,
    content,
    wordShare: content ? wordlike / content : 0,
    dictShare: wordlike ? (knownN + 0.5 * plausible) / wordlike : 0,
    mixedRatio: content ? mixed / content : 0,
    oddRatio: chars ? odd / chars : 0,
    badRatio: chars ? bad / chars : 0,
    vowelRatio: letters ? vowels / letters : 0,
    letters,
  };
  m.score = m.wordShare * m.dictShare;
  m.verdict = verdictOf(m);
  return m;
}

function verdictOf(m) {
  if (m.tokens < 8 && m.content < 8) {
    // Too little text to judge by words; only obvious garbage counts.
    if (m.chars >= 4 && (m.badRatio > 0.2 || m.oddRatio > 0.3)) return 'garbage';
    return 'sparse';
  }
  if (m.badRatio > 0.05 || m.oddRatio > 0.15 || m.mixedRatio > 0.2) return 'garbage';
  if (m.letters >= 40 && (m.vowelRatio < 0.2 || m.vowelRatio > 0.65)) return 'garbage';
  if (m.content < 8) return 'ok'; // mostly numbers (a table): nothing wrong with that
  if (m.score < 0.5) return 'garbage';
  if (m.score < 0.7) return 'suspect';
  return 'ok';
}

// Text per font, from runs ({ str, font }) or pdf.js items ({ str, fontName }).
export function textByFont(items) {
  const by = new Map();
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str) continue;
    const f = it.font ?? it.fontName ?? '';
    let e = by.get(f);
    if (!e) by.set(f, (e = { parts: [], chars: 0 }));
    e.parts.push(it.str);
    e.chars += it.str.replace(/\s+/g, '').length;
  }
  return by;
}

const ASCII_MARKS = /^[!-/:-@[-`{-~]+$/;

// Is one font's text broken (a wrong character map)? Only tokens that can show it
// count: three characters or more with a letter in them, or runs of three different
// ASCII marks ('Wkh', '{P23gf49y', '%&*('; not '...,'). Math (single letters, Greek, operators), numbers,
// codes, addresses and a plot's axis labels are no evidence either way: a word score
// per font flagged every LaTeX math font and every figure's labels as garbage.
export function fontBroken(text, words) {
  let all = 0;
  let bad = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 32 || c === 10 || c === 9 || c === 13) continue;
    all++;
    if (isBadChar(c)) bad++;
  }
  if (all && bad / all > 0.05) return true;
  let n = 0;
  let junk = 0;
  for (const t of text.split(/\s+/)) {
    if (t.length < 3) continue;
    const marks = ASCII_MARKS.test(t) && new Set(t).size >= 3;
    if (!marks && !(core(t).length >= 3 && LETTER.test(t))) continue;
    n += t.length;
    if (marks || isJunkToken(t, words)) junk += t.length;
  }
  return junk >= 8 && junk / n >= 0.5;
}

// The verdict for a page's text layer: { verdict, score, metrics, badFonts, badShare }.
// badFonts holds fonts whose text is garbage; when they carry most of the page the
// whole page is garbage, otherwise their items can be patched from OCR or dropped.
export function judgePage(items, words) {
  const by = textByFont(items);
  const all = [];
  let total = 0;
  for (const e of by.values()) {
    all.push(e.parts.join(' '));
    total += e.chars;
  }
  const metrics = quality(all.join(' '), words);
  const badFonts = new Set();
  let badChars = 0;
  for (const [font, e] of by) {
    const text = e.parts.join(' ');
    const bad = by.size === 1 ? metrics.verdict === 'garbage' : fontBroken(text, words);
    if (bad) {
      badFonts.add(font);
      badChars += e.chars;
    }
  }
  const badShare = total ? badChars / total : 0;
  let verdict = metrics.verdict;
  if (badFonts.size && (badShare >= 0.3 || badChars >= 400)) verdict = 'garbage';
  return { verdict, score: metrics.score, metrics, badFonts, badShare };
}
