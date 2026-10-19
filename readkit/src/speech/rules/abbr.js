// Abbreviations, expanded only where the context says what they mean.
//   Dr. Patel -> 'Doctor Patel', but Mulholland Dr. -> 'Mulholland Drive'
//   St. Paul's -> 'Saint Paul's', Elm St. / 42nd St -> 'Street'; UK 'Dr Jones', 'St Andrews'
//   Fig. 3, pp. 12-14, No. 5, s. 21, Book IV, ch. VII -> only before a number (or numeral)
//   e.g. / i.e. / cf. / vs. / etc. / &c. / et al. anywhere; Roe v. Wade; c. 1750; (b. 1950)
//   Martin Luther King Jr. -> 'Junior'

import {
  TITLES, DOTLESS_TITLES, ALWAYS_TITLES, POST_NAME, STREETS, BEFORE_NUMBER, BEFORE_NUMBER_NODOT, ROMAN_AFTER, GENERAL,
  SENTENCE_END,
} from '../../../data/speech/abbreviations.js';
import { cardinal, romanValue } from '../numbers.js';
import { STARTERS, alternation, atEnd, capitalize, endDot, endDotCap } from './util.js';

const LEFT = "(?<![\\p{L}\\p{N}.'’&])";
const WORD_END = /[\p{L}\p{N}]$/u;
const IS_WORD = /[\p{L}\p{N}'’]/u;

const GENERAL_MAP = new Map(GENERAL);
const END_MAP = new Map(SENTENCE_END);
const ANYWHERE_RE = new RegExp(`${LEFT}(${alternation([...GENERAL_MAP.keys(), ...END_MAP.keys()])})`, 'gu');

// Uppercase forms of the cue abbreviations, for running heads like 'BK. II., CH. IV'.
const UPPER_CUES = {};
for (const k of ROMAN_AFTER) if (k.length > 1 && /^[A-Z]/.test(k)) UPPER_CUES[k.toUpperCase()] = BEFORE_NUMBER[k];
const KEYS = new Set([...Object.keys(TITLES), ...Object.keys(STREETS), ...Object.keys(POST_NAME), ...Object.keys(BEFORE_NUMBER), ...Object.keys(UPPER_CUES)]);
const ABBR_RE = new RegExp(`${LEFT}(${alternation([...KEYS])})(\\.)?(?![\\p{L}\\p{N}'’])`, 'gu');

const NEXT = /\s+(\(?)([^\s]*)/y;
const BOOK_CHAPTER = /(?<![\p{L}\p{N}.])([Bb])k?\.\s?([IVXLC]{1,6}|[ivxlc]{1,6})\.?,?\s?([Cc])(?:h|hap)?\.\s?(\d{1,3}|[IVXLC]{1,7}|[ivxlc]{1,7})(?![\p{L}\p{N}])/gu;
const STATUTE_BEFORE = /(?:\b[IVX]{1,5}|\bAnne|\bEliz)\.?,?\s*$/;
const REGNAL_ABBR = { Geo: 'George', Edw: 'Edward', Hen: 'Henry', Eliz: 'Elizabeth', Car: 'Charles', Jac: 'James', Ric: 'Richard', Wm: 'William', Vict: 'Victoria' };
const REGNAL_ABBR_RE = /(?<![\p{L}\p{N}.])(Geo|Edw|Hen|Eliz|Car|Jac|Ric|Wm|Vict)\./gu;
const ORDINAL_NOUN = { ed: 'edition', edn: 'edition', vol: 'volume', chap: 'chapter', pt: 'part' };
const FORMATS = { '4to': 'quarto', '8vo': 'octavo', '12mo': 'duodecimo', '16mo': 'sixteenmo', '24mo': 'twenty-fourmo', '32mo': 'thirty-twomo' };
const ROMAN_NEXT = /\s?([IVXLCDM]+|[ivxlc]+)(?![\p{L}\p{N}])/uy;
const DIGIT_NEXT = /\s?\(?\d/y;
const CAP_WORD = /^["'“‘(]?\p{Lu}/u;
const NAME = /^\p{Lu}[\p{L}'’-]*,?$/u;
const ORDINAL = /^\d+(?:st|nd|rd|th|[A-Z])$/;

// A word the user's lexicon respelled is held as one private-use character until the end;
// the rules here see the word it stands for ('Dr. Patel' with Patel -> 'Puh-tell').
const HELD = /[-]/gu;
function seen(tok, ctx) {
  if (!tok || !ctx || !ctx.savedFrom || !ctx.savedFrom.length) return tok;
  return tok.replace(HELD, (c) => ctx.savedFrom[c.charCodeAt(0) - 0xe000] ?? c);
}

function nextToken(s, end, ctx) {
  NEXT.lastIndex = end;
  const m = NEXT.exec(s);
  return m ? seen(m[2], ctx) : '';
}

function prevToken(s, i, ctx) {
  const m = /(\S+)\s+$/.exec(s.slice(Math.max(0, i - 40), i));
  return m ? seen(m[1], ctx) : '';
}

// A capitalized word that isn't just a sentence opener ('Patel', not 'The').
function nameNext(tok) {
  if (!CAP_WORD.test(tok)) return false;
  const w = tok.replace(/^["'“‘(]+/, '').replace(/[^\p{L}'’-].*$/u, '');
  return !!w && !STARTERS.has(w);
}

function numberNext(s, end, key) {
  DIGIT_NEXT.lastIndex = end;
  if (DIGIT_NEXT.test(s)) return true;
  if (!ROMAN_AFTER.has(key) && !UPPER_CUES[key]) return false;
  ROMAN_NEXT.lastIndex = end;
  const m = ROMAN_NEXT.exec(s);
  if (!m || romanValue(m[1]) === null || /^(?:mix|dim|mid|civil|liv|vi)$/i.test(m[1])) return false;
  // a lone 'I' is more likely the pronoun, unless punctuation follows ('ch. I.', 'vol. i.')
  return m[1].length > 1 || /^[VXivx]$/.test(m[1]) || /^\s*(?:[.,;:)\]]|$)/.test(s.slice(ROMAN_NEXT.lastIndex, ROMAN_NEXT.lastIndex + 3));
}

function expandAbbr(m, s, ctx) {
  const key = m[1];
  const dot = !!m[2];
  const i = m.index;
  const end = i + m[0].length;
  const len = m[0].length;
  const glued = /\S/.test(s[end] || ' ') ? ' ' : '';
  const keep = (word, withDot) => [[word + (withDot && dot ? endDot(s, end) : ''), 0, len], ...(glued ? [glued] : [])];

  // Fig. 3, pp. 12-14, No. 5, s. 21, ch. III
  const num = BEFORE_NUMBER[key] || UPPER_CUES[key];
  if (num && (dot || BEFORE_NUMBER_NODOT.has(key) || UPPER_CUES[key]) && numberNext(s, end, key)) {
    // 'No' only with a capital: 'no 5-year-old' isn't 'number'
    if (!(key === 'no' && !dot)) return [[num, 0, len], ...(glued ? [' '] : [])];
  }
  const next = nextToken(s, end, ctx);
  const prev = prevToken(s, i, ctx);
  const prevName = NAME.test(prev) || ORDINAL.test(prev);
  // Martin Luther King Jr., John Patel Sr.
  // ('Sr. Mary' before a name is a nun, so Sr/Snr need no name after them)
  if (POST_NAME[key] && (dot || key !== 'Sr') && NAME.test(prev) && (!/^S/.test(key) || !nameNext(next))) return keep(POST_NAME[key], true);
  const title = TITLES[key];
  const street = STREETS[key];
  const titleOk = title && (dot || DOTLESS_TITLES.has(key));
  let word = title;
  if (key === 'Hon' && ctx.uk) word = 'Honourable';
  if (key === 'Cllr' && !ctx.uk) word = 'Councilor';
  if (titleOk && CAP_WORD.test(next)) {
    if (key === 'Gen' && /^[A-Z][.,]?$/.test(next)) return null; // Gen Z
    // 'Elm St. The...' is a street at the end of a sentence; 'St. Paul's' is a saint
    if (street && prevName && !nameNext(next)) return keep(street, true);
    return [[word, 0, len], ...(glued ? [' '] : [])];
  }
  if (street && prevName && !/^\d+$/.test(prev)) return keep(street, true);
  if (titleOk && ALWAYS_TITLES.has(key) && /^\p{Ll}/u.test(next)) return [[word, 0, len]];
  return null;
}

export function abbrRules(t, ctx) {
  const s0 = t.s;
  if (!/[A-Za-z]/.test(s0)) return t;
  // anywhere: e.g., i.e., cf., etc., &c., et al.
  t.replace(ANYWHERE_RE, (m, s) => {
    const key = m[1];
    const end = m.index + key.length;
    if (WORD_END.test(key) && IS_WORD.test(s[end] || '')) return null;
    if (key === 'YoY' && ctx.uk) return 'year on year';
    if (GENERAL_MAP.has(key)) return GENERAL_MAP.get(key) + (key.endsWith('.') && atEnd(s, end) ? '.' : '');
    // 'Patel & Co.' is a company; 'Co. Durham' is a county
    if (key === 'Co.' && !/(?:\p{Lu}[\p{L}'’-]*|&|and)\s+$/u.test(s.slice(Math.max(0, m.index - 30), m.index))) return null;
    const said = END_MAP.get(key);
    if (!key.endsWith('.')) return said;
    const etc = key === 'etc.' || key === '&c.';
    // '&c. &c.' -> 'et cetera, et cetera'
    if (etc && /^\s+(?:&c|etc)\b/.test(s.slice(end, end + 6))) return said + ',';
    return said + (etc ? endDotCap(s, end) : endDot(s, end));
  });
  // eighteenth-century references: 'b. i. c. 11', 'B. IV. ch. 7' -> 'book one, chapter eleven'
  if (/[Bb]k?\.\s?[IVXLCivxlc]/.test(t.s)) {
    t.replace(BOOK_CHAPTER, (m) => {
      const b = romanValue(m[2]);
      const c = /^\d+$/.test(m[4]) ? +m[4] : romanValue(m[4]);
      if (!b || !c) return null;
      return `${m[1] === 'B' ? 'Book' : 'book'} ${cardinal(b)}, ${m[3] === 'C' ? 'Chapter' : 'chapter'} ${cardinal(c)}`;
    });
  }
  // after an ordinal: '2nd ed.', '3d edn', '4th Ed.', 'the 2d vol.' -> 'edition', 'volume'
  if (/\d(?:st|nd|rd|th|d)\s(?:[Ee]dn?|[Vv]ol|[Cc]hap|[Pp]t)\b/.test(t.s)) {
    t.replace(/(?<=\d(?:st|nd|rd|th|d)\s)([Ee]dn?|[Vv]ol|[Cc]hap|[Pp]t)(\.)?(?![\p{L}\p{N}])/gu, (m, s) => {
      const word = ORDINAL_NOUN[m[1].toLowerCase()];
      return (m[1][0] === m[1][0].toUpperCase() ? capitalize(word) : word) + (m[2] ? endDot(s, m.index + m[0].length) : '');
    });
  }
  // book sizes: '4to', '8vo', '12mo'
  if (/\d(?:to|vo|mo)\b/.test(t.s)) t.replace(/(?<![\p{L}\p{N}])(4to|8vo|12mo|16mo|24mo|32mo)(?![\p{L}\p{N}])/gu, (m) => FORMATS[m[1]]);
  // Roe v. Wade, Brown v Board
  t.replace(/(?<=\s)v\.?(?=\s+\p{Lu})/gu, (m, s) => (NAME.test(prevToken(s, m.index, ctx)) ? 'versus' : null));
  // statutes: '22 Charles II. c. 13', '30 Geo. III. c. 4', '5 Anne, c. 6' -> 'chapter'
  if (/[IVXe][.,]?\s?c\.\s?\d/.test(t.s)) {
    t.replace(/(?<![\p{L}\p{N}.])c\.\s?(?=\d{1,3}(?!\d))/gu, (m, s) => (STATUTE_BEFORE.test(s.slice(Math.max(0, m.index - 16), m.index)) ? 'chapter ' : null));
  }
  // 'Geo. III.', 'Edw. I.', 'the 5th of Eliz.' -> the king's or queen's name
  if (/\b(?:Geo|Edw|Hen|Eliz|Car|Jac|Ric|Wm|Vict)\./.test(t.s)) {
    t.replace(REGNAL_ABBR_RE, (m, s) => {
      const end = m.index + m[0].length;
      const roman = /^\s?[IVX]{1,5}\b/.test(s.slice(end, end + 7));
      if (!roman && m[1] !== 'Eliz' && !/^\s*(?:[,;:)]|$)/.test(s.slice(end, end + 3))) return null;
      return REGNAL_ABBR[m[1]] + (roman ? '' : endDot(s, end));
    });
  }
  // c. 1750, ca. 300 BC, est. 1890, (b. 1950; d. 2001)
  t.replace(/(?<![\p{L}\p{N}.])(c|ca|circa|est|Est|b|d|fl|r)\.\s?(?=\d{2,4}(?!\d))/gu, (m, s) => {
    const k = m[1];
    if (/^[bdr]$|^fl$/.test(k) && !/(?:^|[(,;[]\s?)$/.test(s.slice(Math.max(0, m.index - 2), m.index))) return null;
    const word = { c: 'circa', ca: 'circa', circa: 'circa', est: 'established', Est: 'Established', b: 'born', d: 'died', fl: 'flourished', r: 'reigned' }[k];
    return word + ' ';
  });
  t.replace(ABBR_RE, (m, s) => expandAbbr(m, s, ctx));
  // Equation (5), Figure (2b) -> no brackets; § 12(b) -> 'twelve b'
  t.replace(/\b(Equations?|equations?|Figures?|figures?|Tables?|Formula|formula)\s?\((\d+(?:\.\d+)?[a-z]?)\)/g, (m) => [[m[1], 0, m[1].length], ' ', [m[2], m[0].length - m[2].length - 1, m[0].length - 1]]);
  // subsections: '§ 12(b)', '2(a)(iii)', 'Rule 12(b)(6)' -> 'twelve b', 'two a three', 'twelve b six'
  t.replace(/(?<=\d)(?:\((?:[a-z]{1,2}|[ivx]{2,5}|\d{1,2})\))+/g, (m) => {
    const out = [];
    for (const p of m[0].matchAll(/\(([^)]+)\)/g)) {
      const inner = p[1];
      const n = /^[ivx]{2,5}$/.test(inner) ? romanValue(inner) : null;
      out.push(' ', [n ? String(n) : inner, p.index + 1, p.index + 1 + inner.length]);
    }
    return out;
  });
  return t;
}
