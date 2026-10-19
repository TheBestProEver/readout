// The verbalizer: written text -> the words a voice should say, for American or British
// English. 'Dr. Patel paid $5 on 4/7' -> 'Doctor Patel paid five dollars on April seventh'.
//
// About a hundred ordered rules, grouped in rules/*.js. Order matters: dates before
// fractions (4/7), decades before units ('90s' is not 90 seconds), units before letter-number
// codes (5km vs B12), numbers before symbols, capitals last. Every rule rewrites a Tracked
// string, so plan() can still map each spoken word back to the source text.

import { Tracked } from './tracked.js';
import { cleanTracked } from './clean.js';
import { junkTracked } from './junk.js';
import { skipRules } from './rules/skip.js';
import { webRules } from './rules/web.js';
import { phoneRules } from './rules/phone.js';
import { dateRules, timeRules } from './rules/dates.js';
import { moneyRules, oldMoneyRules } from './rules/money.js';
import { fractionRules, rangeRules, dimensionRules, unitRules } from './rules/measure.js';
import { isbnRules, versionRules, europeanNumbers, decadeRules, yearRules, ordinalRules, serialRules, codeRules, ratioRules, numberRules, magnitudeRules } from './rules/num.js';
import { abbrRules } from './rules/abbr.js';
import { romanRules } from './rules/roman.js';
import { mathRules, symbolRules } from './rules/symbols.js';
import { capsRules } from './rules/caps.js';
import { escapeRe } from './rules/util.js';

const SKIP_DEFAULTS = { citations: true, urls: 'auto', footnoteMarks: true };
const PUA = 0xe000;
const PUA_RE = /[-]/g;

// User pronunciations, compiled once per lexicon object. Keys with a capital match exactly;
// lowercase keys match any case. Values written /like this/ are phonemes for g2p, not
// respellings, so the word is left for g2p to find.
const lexCache = new WeakMap();
function compileLexicon(lex) {
  if (!lex || typeof lex !== 'object') return null;
  if (lexCache.has(lex)) return lexCache.get(lex);
  const exact = new Map();
  const loose = new Map();
  for (const [k, v] of Object.entries(lex)) {
    const key = String(k).trim();
    if (!key || typeof v !== 'string' || /^\/.*\/$/.test(v.trim())) continue;
    if (key === key.toLowerCase()) loose.set(key, v.trim());
    else exact.set(key, v.trim());
  }
  const re = (keys, flags) => (keys.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${keys.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, flags) : null);
  const out = exact.size || loose.size ? { exact, loose, exactRe: re([...exact.keys()], 'gu'), looseRe: re([...loose.keys()], 'giu') } : null;
  lexCache.set(lex, out);
  return out;
}

export function makeContext(opts = {}) {
  if (opts.__ctx) return opts;
  const dialect = opts.dialect === 'en-GB' ? 'en-GB' : 'en-US';
  return {
    __ctx: true,
    dialect,
    uk: dialect === 'en-GB',
    dateOrder: opts.dateOrder,
    skip: Object.assign({}, SKIP_DEFAULTS, opts.skip),
    lexicon: compileLexicon(opts.lexicon),
    words: opts.words,
    dropped: opts.dropped || [],
    saved: [],
    savedFrom: [], // the words the saved texts replaced ('Patel' for 'Puh-tell'), for rules that look at names
  };
}

function protect(ctx, text, from) {
  ctx.saved.push(text);
  ctx.savedFrom.push(from);
  return String.fromCharCode(PUA + ctx.saved.length - 1);
}

function lexiconRules(t, ctx) {
  const lex = ctx.lexicon;
  if (!lex) return t;
  if (lex.exactRe) t.replace(lex.exactRe, (m) => protect(ctx, lex.exact.get(m[0]), m[0]));
  if (lex.looseRe) t.replace(lex.looseRe, (m) => protect(ctx, lex.loose.get(m[0].toLowerCase()), m[0]));
  return t;
}

// Dashes between words become a comma pause; 'A–Z' is 'A to Z'.
function dash(m, s, lo, hi) {
  const end = m.index + m[0].length;
  if (m.index <= lo || end >= hi) return '';
  const before = s.slice(Math.max(0, m.index - 4), m.index);
  const after = s.slice(end, end + 4);
  if (/[,;:.!?(\[]\s*$/.test(before) || /^\s*[,;:.!?)\]]/.test(after)) return ' ';
  if (/(?:^|[^\p{L}])\p{Lu}$/u.test(before) && /^\p{Lu}(?![\p{L}])/u.test(after)) return ' to ';
  return ', ';
}

// Legal drafting repeats amounts: 'thirty (30) days', '$500 (five hundred dollars)'. Once
// both are words, the bracketed copy is dropped.
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim();
function dedupeParens(t) {
  if (!t.s.includes('(')) return t;
  t.replace(/[ \t]?\(([^()\n]{1,80})\)/g, (m, s) => {
    const inner = words(m[1]);
    if (!inner || !/[a-z]/.test(inner)) return null;
    const before = words(s.slice(Math.max(0, m.index - inner.length - 30), m.index));
    return before === inner || before.endsWith(' ' + inner) ? '' : null;
  });
  return t;
}

const MID_STOP = /(?<=[\p{L}\p{N}])\.(?=[ \t]+["'“‘(]?\p{Ll})/gu;
const REF_WORD = /^[ \t]+["'“‘(]?(?:chapters?|sections?|volumes?|pages?|parts?|books?|articles?|paragraphs?|lines?|verses?|notes?|numbers?|figures?|tables?|appendix|folios?|columns?|plates?)\b/;
const NUMBER_WORD = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|hundred|thousand|million|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|\w+teenth|\w+tieth)$/i;
function midStop(m, s) {
  const next = s.slice(m.index + 1, m.index + 16);
  if (REF_WORD.test(next)) return ',';
  const w = /[\p{L}\p{N}]+$/u.exec(s.slice(Math.max(0, m.index - 24), m.index))[0];
  if (w.length <= 4 || /^\p{Lu}|\p{N}/u.test(w) || !/[aeiouy]/i.test(w) || NUMBER_WORD.test(w)) return '';
  return ',';
}

// Spaces and punctuation after all the rewriting.
// (Runs of spaces are matched from their first character only, (?<!\s), so long runs stay linear.)
export function tidy(t) {
  t.replace(/(?<!\s)\s*\n\s*/g, ' ');
  if (/[—–―]|\s-\s/.test(t.s)) {
    const lo = t.s.search(/\S/);
    const hi = t.s.trimEnd().length;
    t.replace(/(?<![ \t])[ \t]*(?:[—–―]+|(?<=\s)-(?=\s))[ \t]*/g, (m, s) => dash(m, s, lo, hi));
  }
  if (/[()[\]]/.test(t.s)) {
    // brackets left unmatched by a page break or a dropped citation are not read
    const bad = new Set();
    const stack = [];
    const s = t.s;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(' || c === '[') stack.push(i);
      else if (c === ')' || c === ']') {
        const j = stack.length ? stack[stack.length - 1] : -1;
        if (j >= 0 && (s[j] === '(') === (c === ')')) stack.pop();
        else bad.add(i);
      }
    }
    for (const j of stack) bad.add(j);
    if (bad.size) t.replace(/[()[\]]/g, (m) => (bad.has(m.index) ? ' ' : null));
  }
  t.replace(/(?<=[(\[])\s+/g, '');
  t.replace(/\(\s*\)|\[\s*\]/g, '');
  t.replace(/\.(?=,)/g, '');
  t.replace(/(?<!\s)\s+(?=[,.;:!?…)\]])/g, '');
  t.replace(/,(?:\s*,)+/g, ',');
  t.replace(/[,;:](?=\s*[.!?])/g, '');
  t.replace(/([;:])\s*[,;:]+/g, (m) => m[1]);
  t.replace(/\.(?:\s*\.)+/g, '.');
  t.replace(/(?<=[!?])\s*\.(?!\.)/g, '');
  // A full stop the splitter didn't end the sentence at ('5 per cent. of', 'Edward III. the',
  // 'vol. i. chap. iv.') would make the voice stop and fall: dropped after abbreviations and
  // names, a comma between reference parts or after an ordinary word.
  if (/\.[ \t]+["'“‘(]?\p{Ll}/u.test(t.s)) t.replace(MID_STOP, midStop);
  t.replace(/^[\s,;:.\-–—]+/g, '');
  t.replace(/[ \t]{2,}/g, ' ');
  t.replace(/^\s+|(?<!\s)\s+$/g, '');
  return t;
}

// Runs every rule on a Tracked in place. opts: { dialect, skip, lexicon, dateOrder, words, dropped }
export function verbalizeTracked(t, opts) {
  const ctx = makeContext(opts);
  ctx.saved = [];
  ctx.savedFrom = [];
  cleanTracked(t, { footnoteMarks: ctx.skip.footnoteMarks, words: ctx.words });
  skipRules(t, ctx);
  junkTracked(t, ctx.dropped);
  lexiconRules(t, ctx);
  oldMoneyRules(t, ctx);
  webRules(t, ctx);
  isbnRules(t);
  phoneRules(t);
  europeanNumbers(t);
  dateRules(t, ctx);
  timeRules(t);
  versionRules(t, ctx);
  moneyRules(t, ctx);
  magnitudeRules(t, ctx);
  fractionRules(t, ctx);
  abbrRules(t, ctx);
  romanRules(t);
  decadeRules(t, ctx);
  serialRules(t, ctx);
  rangeRules(t, ctx);
  dimensionRules(t);
  yearRules(t, ctx);
  ordinalRules(t, ctx);
  unitRules(t, ctx);
  mathRules(t);
  ratioRules(t, ctx);
  codeRules(t, ctx);
  numberRules(t, ctx);
  symbolRules(t, ctx);
  dedupeParens(t);
  capsRules(t, ctx);
  tidy(t);
  if (ctx.saved.length) t.replace(PUA_RE, (m) => ctx.saved[m[0].charCodeAt(0) - PUA] ?? '');
  return t;
}

// verbalize(text, { dialect: 'en-US' | 'en-GB', skip, lexicon, dateOrder }) -> string
export function verbalize(text, opts) {
  return verbalizeTracked(Tracked.of(String(text ?? '')), opts).s;
}
