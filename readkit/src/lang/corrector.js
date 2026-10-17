// Post-OCR correction. The rules, in order:
//   0. a lone '|', 'l' or '1' before a lowercase word is the pronoun 'I'
//   1. drop symbol-only junk and anything Tesseract itself barely saw
//   2. join split words ('lam p' -> 'lamp') and split run-together ones ('ofthe')
//   3. replace non-words (and very unsure real words) with the best dictionary word
//      within OCR edit distance, scored by frequency and the neighbouring words
//   4. drop tokens that are still junk, and report them
// Names, acronyms, numbers and codes (B12, CO2, COVID-19, x86, MP3, 4K, iPhone) are
// never changed. Nothing is ever invented: every replacement is a dictionary word
// close to what was on the page. Confidences are 0..1 (Tesseract's / 100).

import { buildIndex, lookup, count as countOf, confusions } from './symspell.js';

const CHEAP = confusions.cost;
import { core, isKnown, isNumberish, isCode, isAcronym, isWeird, isShortWord, isShortTarget } from './tokens.js';
import { periodWords, isPeriod, archaic } from './period.js';

export const DEFAULTS = {
  fixConf: 0.8, // non-words at or above this confidence are left alone
  realConf: 0.45, // real words are only reconsidered below this
  junkConf: 0.35, // unknown tokens below this are dropped
  weirdConf: 0.8, // odd-shaped unknown tokens below this are dropped
  minConf: 0.1, // anything below this is noise
  editPenalty: 5, // log-probability cost per unit of edit distance
  minGain: 1, // a replacement must beat keeping the word by this much
};

// Symbols that mean something on their own; any other symbol-only token is noise.
const KEEP_SYMBOL = /^(?:&|—|–|-|…|%|\+|=|@|#|\$|£|€|\/)$/;
// Symbols inside a word that OCR produces from specks and edges. '|' and '!' are
// left out: they are often misread letters and go to correction instead.
const ODD_INSIDE = /[^\p{L}\p{N}'’.,\-&/@:%$£€°|!]/u;

// Older spellings join the dictionary as rare words: kept when read, and a target
// only when they are clearly closer than the modern form ('expcnce' -> 'expence').
const PERIOD_COUNT = 2e5;

export function makeModel({ words, bigrams, dialect = 'en-US' }) {
  const extra = [...periodWords].filter((w) => !words.has(w));
  const entries = function* () {
    yield* words.entries();
    for (const w of extra) yield [w, PERIOD_COUNT];
  };
  const index = buildIndex(entries(), { maxEdit: 2, prefix: 5 });
  const has = (w) => words.has(w) || periodWords.has(lower(w));
  const all = { has, freq: (w) => words.freq(w) || (periodWords.has(lower(w)) ? PERIOD_COUNT : 0), size: words.size + extra.length };
  return { index, words: all, modern: words, bigrams, dialect, period: (w) => isPeriod(lower(w), (x) => words.has(x)) };
}

const lower = (s) => s.toLowerCase().replace(/[’‘]/g, "'");

function logP(M, w) {
  return Math.log((countOf(M.index, w) + 0.5) / M.index.total);
}
// log P(b | a) with stupid backoff: the pair's share of a's count when the pair is
// known, else 0.4 x P(b). The two lists come from different corpora, so the
// ratio is capped at 1.
function logNext(M, a, b) {
  if (!a || !M.bigrams) return logP(M, b);
  const c = M.bigrams.get(a, b);
  if (c) return Math.min(0, Math.log(c / (countOf(M.index, a) + 1)));
  return Math.log(0.4) + logP(M, b);
}
// Score of `words` (one candidate, or two for a split) between prev and next.
function seqScore(M, prev, words, next) {
  let s = logNext(M, prev, words[0]);
  for (let k = 1; k < words.length; k++) s += logNext(M, words[k - 1], words[k]);
  if (next) s += logNext(M, words[words.length - 1], next);
  return s;
}

// US and UK spellings of one word map to the same key (colour/color, centre/center,
// organise/organize, catalogue/catalog, travelled/traveled, defence/defense).
function variantKey(w) {
  return w
    .replace(/our/g, 'or')
    .replace(/([^aeiou])re(s|d)?$/, '$1er$2')
    .replace(/is(e|es|ed|ing|ation|ations|er|ers)$/, 'iz$1')
    .replace(/ys(e|es|ed|ing)$/, 'yz$1')
    .replace(/ogue(s)?$/, 'og$1')
    .replace(/ll(ed|ing|er|ers)$/, 'l$1')
    .replace(/ence$/, 'ense')
    .replace(/ae/g, 'e')
    .replace(/oe/g, 'e');
}
const isBritish = (w) => variantKey(w) !== w;

function recase(orig, cand, sentenceStart) {
  if (cand === 'i' || cand.startsWith("i'")) return 'I' + cand.slice(1);
  if (orig.length > 1 && orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return cand.toUpperCase();
  const first = orig[0];
  // In mid-sentence a capital that was itself misread ('Bnished' for 'finished')
  // is not a capital.
  if (first !== first.toLowerCase() && !sentenceStart && first.toLowerCase() !== cand[0]) return cand;
  // '|t' or 'lt' at the start of a sentence was 'It'
  if (first !== first.toLowerCase() || (sentenceStart && (/^[|!1]/.test(first) || (first === 'l' && cand[0] === 'i')))) return cand[0].toUpperCase() + cand.slice(1);
  return cand;
}

// Two dictionary words run together that make a plausible compound: both at
// least three letters, neither a function word ('thequick' is two words).
function compound(M, lo) {
  if (lo.length < 7) return false;
  for (let k = 3; k <= lo.length - 3; k++) {
    const a = lo.slice(0, k);
    const b = lo.slice(k);
    const ca = countOf(M.index, a);
    const cb = countOf(M.index, b);
    if (ca >= 1e6 && cb >= 1e6 && ca < 1e9 && cb < 1e9) return true;
  }
  return false;
}

const titleCase = (w) => /^\p{Lu}\p{Ll}+$/u.test(w);
const sentenceEnd = (t) => /[.!?:]["'”’)\]]*$/.test(t);

// words: [{ text, conf, line? }] -> { words: [{ ...word, text, conf, changed, dropped, merged? }], dropped: string[] }
export function correctWords(M, input, options) {
  const o = Object.assign({}, DEFAULTS, options);
  const toks = input.map((w) => ({
    ...w,
    text: String(w.text == null ? '' : w.text),
    conf: typeof w.conf === 'number' ? w.conf : 0.7,
    changed: false,
    dropped: false,
  }));
  const dropped = [];
  const drop = (t, report = true) => {
    t.dropped = true;
    if (report && t.text.trim()) dropped.push(t.text);
  };
  const known = (w) => isKnown(M.words, w);
  const live = () => toks.filter((t) => !t.dropped);
  const sameLine = (a, b) => a.line == null || b.line == null || a.line === b.line;

  // 0. the pronoun I
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = /^([|l])((?:['’](?:m|ll|d|ve))?)$/.exec(t.text);
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (m && next && /^\p{Ll}/u.test(core(next.text).w) && !(prev && isNumberish(core(prev.text).w))) {
      t.text = 'I' + m[2];
      t.conf = Math.max(t.conf, 0.6);
      t.changed = true;
    }
  }

  // 0b. '|' and capital 'I' read for 'l' ('|ike', 'Iater'), and '|' for 'I' ('|t')
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const c = core(t.text);
    if (!c.w) continue;
    const start = i === 0 || sentenceEnd(toks[i - 1].text);
    let fixed = null;
    if (c.pre.endsWith('|') && /^\p{Ll}/u.test(c.w)) {
      const asI = 'I' + c.w;
      const asL = 'l' + c.w;
      fixed = known(asL) && !(c.w.length === 1 && known(asI)) ? asL : known(asI) ? asI : asL;
      c.pre = c.pre.slice(0, -1);
    } else if (c.post.startsWith('|') && /\p{Ll}$/u.test(c.w) && known(c.w + 'l')) {
      fixed = c.w + 'l';
      c.post = c.post.slice(1);
    } else if (/^I\p{Ll}{2,}$/u.test(c.w) && !known(c.w)) {
      const asL = 'l' + c.w.slice(1);
      if (known(asL) && countOf(M.index, asL) >= 1e6) fixed = asL;
    }
    if (fixed) {
      if (start && /^\p{Ll}/u.test(fixed)) fixed = fixed[0].toUpperCase() + fixed.slice(1);
      t.text = c.pre + fixed + c.post;
      t.changed = true;
    }
  }

  // 1. symbol junk and noise
  for (const t of toks) {
    const { w } = core(t.text);
    // a long dictionary word is a word even when Tesseract scored it badly
    if (t.conf < o.minConf && !(w.length >= 4 && /^\p{L}+$/u.test(w) && known(w))) drop(t);
    else if (!w) {
      if (!(KEEP_SYMBOL.test(t.text) && t.conf >= 0.6)) drop(t, t.text.length > 1);
    } else if (ODD_INSIDE.test(w) && t.conf < 0.6 && !isNumberish(w)) drop(t);
  }

  // 2a. split words: 'lam p' -> 'lamp', 'w ithout' -> 'without'; never two real words ('or a')
  let L = live();
  for (let i = 0; i + 1 < L.length; i++) {
    const x = L[i];
    const y = L[i + 1];
    if (!sameLine(x, y) || x.changed || y.changed) continue;
    const a = core(x.text);
    const b = core(y.text);
    if (a.post || b.pre || !a.w || !b.w || /\d/.test(a.w + b.w)) continue;
    if (a.w.length + b.w.length < 3) continue;
    const j = lower(a.w + b.w);
    if (!M.words.has(j) || countOf(M.index, j) < 1e6) continue;
    const short = (w) => w.length <= 2 && isShortTarget(lower(w));
    const common = (w) => short(w) || (w.length > 2 && known(w) && countOf(M.index, lower(w)) >= 2e5);
    if (common(a.w) && common(b.w)) continue;
    // a confidently read 'a' or 'of' next to a fragment is more likely right than the join
    if ((short(a.w) && x.conf >= 0.8) || (short(b.w) && y.conf >= 0.8)) continue;
    if (x.conf >= 0.9 && y.conf >= 0.9 && known(a.w) && known(b.w)) continue;
    x.mergedFrom = x.text + ' ' + y.text;
    x.text = a.pre + a.w + b.w + b.post;
    x.conf = Math.min(x.conf, y.conf);
    x.changed = true;
    y.dropped = true;
    y.merged = true;
    i++;
  }

  // 3. corrections in context (across line breaks)
  L = live();
  const lw = (t) => (t ? lower(core(t.text).w) : null);
  for (let i = 0; i < L.length; i++) {
    const t = L[i];
    if (t.changed && !t.mergedFrom) continue; // the 'I' / 'l' fixes above are final
    const { pre, w: whole, post } = core(t.text);
    // (no dictionary word is longer than 40 letters: such tokens are left to step 4)
    if (!whole || whole.length < 2 || whole.length > 40 || isNumberish(whole) || isCode(whole)) continue;
    // keep possessives and contractions, fix the word in front of them
    const sm = /^(\p{L}+)(['’](?:s|d|ll|re|ve|m))$/u.exec(whole);
    const w = sm ? sm[1] : whole;
    const suffix = sm ? sm[2] : '';
    if (/[.'’@/:\-]/.test(w)) continue; // abbreviations, contractions, compounds, emails, URLs, times
    const prevTok = L[i - 1];
    const sentenceStart = !prevTok || sentenceEnd(prevTok.text);
    const kn = known(w);
    if (kn && (t.conf >= o.realConf || archaic.has(lower(w)))) continue;
    if (M.period(w)) continue; // 'publick', 'errour', 'loveth': old spellings, as printed
    // A confidently read non-word is only changed when one glyph was clearly
    // misread ('vellowed' -> 'yellowed', 'rnodern' -> 'modern').
    // A digit inside letters is a misread however sure Tesseract was ('1he', 'wh1ch').
    const misglyph = /\p{L}\p{N}|\p{N}\p{L}/u.test(w);
    const sure = t.conf >= o.fixConf && !misglyph;
    if (sure && (kn || w.length < 4 || !(/^\p{Ll}+$/u.test(w) || (sentenceStart && titleCase(w))))) continue;
    // A word in a line of capitals ('THE CORNPANY REPORT') is a word, not an acronym.
    const shout = !kn && /^\p{Lu}{4,}$/u.test(w) && [prevTok, L[i + 1]].some((x) => x && /^\p{Lu}{2,}$/u.test(core(x.text).w));
    if (isAcronym(w) && !shout) continue;
    // Capitalised words in mid-sentence are usually names: only fix the clear
    // misreads of common words ('Tlie', 'Iater').
    const cap = /^\p{Lu}/u.test(w) && !sentenceStart && !shout;
    if (cap && (kn || !titleCase(w))) continue;
    if (w.length <= 3 && t.conf < 0.3 && !misglyph) continue; // too short and unsure: dropping beats guessing
    const lo = lower(w);
    if (!kn && t.conf >= 0.5 && compound(M, lo)) continue; // 'roadmap', 'smartwatch': read as printed
    // Two real edits are a big change: only for words Tesseract itself doubted.
    // A real word read for another is a glyph confusion ('modem' for 'modern'),
    // not a spelling slip: 'spared' must not become 'scared'.
    const maxEdit = sure || kn || shout ? CHEAP : lo.length <= 3 ? 0.6 : lo.length === 4 || t.conf >= 0.6 ? 1.2 : 2;
    const cands = lookup(M.index, lo, {
      maxEdit,
      filter: (c) => c !== lo && (c.length > 2 || isShortTarget(c)),
    });
    const prev = lw(prevTok);
    const next = lw(L[i + 1]);
    const score = (c, d) => seqScore(M, prev, [c], next) - o.editPenalty * d;
    const base = kn ? score(lo, 0) : -Infinity;
    let best = null;
    let bs = -Infinity;
    for (const { word, dist } of cands) {
      if (cap && (dist > 0.6 || countOf(M.index, word) < 1e7)) continue;
      if (sure && countOf(M.index, word) < 1e5) continue;
      // a short unsure token becomes a common word or nothing ('tk' is not 'tlc')
      if (lo.length <= 3 && t.conf < 0.6 && countOf(M.index, word) < 5e6) continue;
      const s = score(word, dist);
      if (s > bs) {
        bs = s;
        best = word;
      }
    }
    // Prefer the dialect's spelling when the winner has a close US/UK twin.
    if (best) {
      const key = variantKey(best);
      const wantGB = M.dialect === 'en-GB';
      for (const { word, dist } of cands) {
        if (word !== best && variantKey(word) === key && isBritish(word) === wantGB && score(word, dist) > bs - 1.5) {
          best = word;
          bs = score(word, dist);
          break;
        }
      }
    }
    // Run-together words: 'ofthe' -> 'of the'. Compounds missing from the list
    // ('roadmap') are read with fair confidence, so unsure tokens only, unless
    // one part is a function word.
    if (!kn && !cap && lo.length >= 4 && /^\p{L}+$/u.test(lo)) {
      for (let k = 1; k < lo.length; k++) {
        const a = lo.slice(0, k);
        const b = lo.slice(k);
        const okPart = (p) => (p.length <= 2 ? isShortTarget(p) : M.words.has(p) && countOf(M.index, p) >= 1e6);
        if (!okPart(a) || !okPart(b)) continue;
        // 'ofthe', 'inthe', 'thequick': one part is a function word
        const ca = countOf(M.index, a);
        const cb = countOf(M.index, b);
        const veryCommon = Math.max(ca, cb) >= 1e9 && Math.min(ca, cb) >= 1e7;
        if (t.conf >= 0.65 && !veryCommon) continue;
        if (!(M.bigrams && M.bigrams.get(a, b)) && !veryCommon) continue;
        const s = seqScore(M, prev, [a, b], next) - o.editPenalty * 0.6;
        if (s > bs) {
          bs = s;
          best = a + ' ' + b;
        }
      }
    }
    if (best && bs > base + o.minGain) {
      const cased = best
        .split(' ')
        .map((p, k) => recase(k ? p.toLowerCase() : w, p, sentenceStart && k === 0))
        .join(' ');
      t.text = pre + cased + suffix + post;
      t.changed = true;
      t.fixedFrom = whole;
    }
  }

  // 4. junk that is still not a word
  const L4 = live();
  const capsAround = (i) => [L4[i - 1], L4[i + 1]].some((x) => x && x.conf >= 0.5 && /^\p{Lu}{2,}$/u.test(core(x.text).w));
  for (let i = 0; i < L4.length; i++) {
    const t = L4[i];
    if (t.changed) continue;
    const { w } = core(t.text);
    if (!w) continue;
    if (isNumberish(w)) {
      // numbers of two digits or more are kept unless Tesseract barely saw them
      if (t.conf < (/^\d{2,}/.test(w) ? 0.15 : o.junkConf)) drop(t);
      continue;
    }
    if (isCode(w)) {
      if (t.conf < 0.25) drop(t);
      continue;
    }
    if (/[./@-]/.test(w)) {
      // abbreviations, compounds, URLs and emails: fine if their parts are
      const parts = w.split(/[./@-]+/).filter(Boolean);
      const ok = parts.every((p) => known(p) || isNumberish(p) || isCode(p) || p.length === 1);
      if (t.conf < o.junkConf || (!ok && parts.some((p) => isWeird(p)) && t.conf < o.weirdConf)) drop(t);
      continue;
    }
    // capitals Tesseract doubted, among lowercase words: specks at a line's end
    // read as 'AG', 'RE', 'PIES'
    if (/^\p{Lu}{2,}$/u.test(w) && t.conf < 0.5 && !capsAround(i)) {
      drop(t);
      continue;
    }
    const kn = known(w) || M.period(w);
    if (kn) {
      if (w.length <= 3 && t.conf < 0.2) drop(t);
      else if (w === 'i' && t.conf < 0.75) drop(t); // the pronoun is a capital; a lone 'i' is a speck
      else if (/[a-z][A-Z]|^\p{Ll}+\p{Lu}/u.test(w)) {
        // 'tHe' -> 'the': a known word with scrambled capitals
        t.text = t.text.replace(w, /^\p{Lu}/u.test(w) ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase());
        t.changed = true;
      }
      continue;
    }
    if (t.conf < o.junkConf) drop(t);
    else if (isWeird(w) && t.conf < o.weirdConf) drop(t);
    else if (w.length === 1 && !/^\p{Lu}$/u.test(w) && t.conf < 0.75) drop(t);
    else if (/^\p{Ll}/u.test(w) && t.conf < 0.5) drop(t);
  }

  return { words: toks, dropped };
}

// Plain text in, corrected text out. Without confidences every word is treated as
// fairly sure (0.7), so only non-words are changed and only junk shapes dropped.
export function correctText(M, text, options) {
  const src = String(text == null ? '' : text);
  const toks = [];
  const re = /\S+/g;
  let m;
  let line = 0;
  let last = 0;
  while ((m = re.exec(src))) {
    for (let k = last; k < m.index; k++) if (src.charCodeAt(k) === 10) line++;
    last = m.index;
    toks.push({ text: m[0], conf: 0.7, line, start: m.index, end: m.index + m[0].length });
  }
  const { words, dropped } = correctWords(M, toks, options);
  let out = '';
  let pending = src.slice(0, toks.length ? toks[0].start : src.length);
  for (let i = 0; i < words.length; i++) {
    const after = src.slice(words[i].end, i + 1 < words.length ? words[i + 1].start : src.length);
    if (words[i].dropped) {
      if (words[i].merged) pending = after;
      else if (newlines(after) > newlines(pending)) pending = after;
      continue;
    }
    out += pending + words[i].text;
    pending = after;
  }
  out += pending;
  return { text: out, dropped };
}

const newlines = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};
