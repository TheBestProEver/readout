// Cleaning before verbalization: markup remnants, entities, superscripts, fractions and
// symbols (all before NFKC, which would turn 'x²' into 'x2', a footnote 'word¹²' into
// 'word12' and '½' into '1⁄2'), then NFKC, invisible characters, spaces, quotes, primes,
// line-break hyphens, and runs of punctuation.
//
// clean(text) returns a string; cleanTracked(t) rewrites a Tracked in place so offsets
// still point into the source.

import { Tracked } from './tracked.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', middot: '·', bull: '•', euro: '€', pound: '£', cent: '¢',
  yen: '¥', sect: '§', para: '¶', micro: 'µ', shy: '­', minus: '−', le: '≤', ge: '≥', ne: '≠', asymp: '≈',
  infin: '∞', prime: '′', Prime: '″', zwj: '‍', zwnj: '‌', lrm: '', rlm: '', iexcl: '¡', iquest: '¿',
  dagger: '†', Dagger: '‡', permil: '‰', larr: '←', rarr: '→', harr: '↔', rArr: '⇒', hArr: '⇔', sum: '∑', radic: '√',
  pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ',
  tau: 'τ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó',
  uacute: 'ú', agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', acirc: 'â', ecirc: 'ê', icirc: 'î',
  ocirc: 'ô', ucirc: 'û', auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ', atilde: 'ã', ntilde: 'ñ',
  otilde: 'õ', ccedil: 'ç', szlig: 'ß', aring: 'å', oslash: 'ø', aelig: 'æ', oelig: 'œ', Eacute: 'É', Ouml: 'Ö',
  Uuml: 'Ü', Auml: 'Ä', Ntilde: 'Ñ', Ccedil: 'Ç',
};
const BLOCK_TAGS = new Set(['br', 'p', 'div', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'dt', 'dd', 'table', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'figcaption', 'caption', 'pre']);
const TAG_RE = /<\/?(a|abbr|b|big|blockquote|body|br|caption|center|cite|code|dd|del|dfn|div|dl|dt|em|figcaption|figure|font|footer|h[1-6]|head|header|hr|html|i|img|ins|kbd|li|main|mark|nav|nobr|ol|p|pre|q|s|samp|section|small|span|strike|strong|sub|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var|wbr)(?=[\s>/])[^<>]{0,500}>/gi;

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i' };
const VULGAR = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅐': '1/7', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅑': '1/9', '⅒': '1/10', '↉': '0/3' };
// Units that take an exponent ('cm²'), so the mark after them isn't a footnote.
const UNIT_BEFORE_EXP = /(?:^|[^A-Za-z])(?:cm|mm|km|dm|nm|μm|µm|ft|in|mi|yd|m|s)$/;
// Hyphenated line breaks are joined ('infor-\nmation') unless the first half usually
// starts a hyphenated compound ('well-\nknown').
const COMPOUND_FIRST = new Set(['self', 'well', 'non', 'anti', 'ex', 'multi', 'semi', 'cross', 'half', 'all', 'long', 'short', 'high', 'low', 'full', 'part', 'mid', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'brother', 'sister', 'mother', 'father', 'great', 'vice', 'quasi', 'pseudo', 'ultra', 'one', 'two', 'three', 'four', 'five', 'first', 'second', 'third']);

function decodeEntity(m) {
  const name = m[3];
  if (name) return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : null;
  const code = m[1] ? parseInt(m[1], 10) : parseInt(m[2], 16);
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
  return String.fromCodePoint(code);
}

// Is the superscript run at s[i] an exponent (x², cm², (a+b)², E = mc²) or a footnote mark?
function isExponent(s, i) {
  const before = s.slice(Math.max(0, i - 24), i);
  const tok = /\S*$/.exec(before)[0];
  if (!tok) return false;
  const prev = tok[tok.length - 1];
  if (/[)\]]/.test(prev)) return true;
  if (/\d/.test(prev)) return !/^(?:1[5-9]|20)\d\d$/.test(tok.replace(/[^\d]/g, '').slice(-4)) || /[=+−×^]/.test(before);
  if (/(?:^|[^A-Za-z])[A-Za-z]$|[α-ωΑ-Ω][A-Za-z]$|[α-ωΑ-Ω]$/.test(tok)) return true;
  if (UNIT_BEFORE_EXP.test(tok)) return true;
  return /[=+−×÷^]|\s-\s/.test(before);
}

const feet = (n) => (+n === 1 ? 'foot' : 'feet');
const inches = (n) => (+n === 1 ? 'inch' : 'inches');
const COMPASS = { N: 'north', S: 'south', E: 'east', W: 'west' };

export function cleanTracked(t, opts = {}) {
  const dropFootnotes = opts.footnoteMarks !== false;
  t.replace(/\r\n?/g, '\n');
  // markup remnants
  if (t.s.includes('&')) t.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, decodeEntity);
  if (t.s.includes('<')) {
    t.replace(/<!--[^]{0,1000}?-->/g, '');
    t.replace(TAG_RE, (m) => (BLOCK_TAGS.has(m[1].toLowerCase()) ? ' ' : ''));
    // <jane@example.com>, <https://example.com>: the brackets are not read
    t.replace(/<([\w.+\-]{1,64}@[\w\-]{1,63}(?:\.[\w\-]{1,63}){1,8}|(?:https?:\/\/|www\.)[^\s<>]{1,500})>/g, (m) => [[m[1], 1, 1 + m[1].length]]);
  }
  if (t.s.includes('](')) {
    t.replace(/!\[([^[\]\n]{0,300})\]\([^()\s]{0,1000}(?:\s"[^"\n]{0,200}")?\)/g, (m) => m[1]);
    t.replace(/\[([^[\]\n]{1,300})\]\([^()\s]{0,1000}(?:\s"[^"\n]{0,200}")?\)/g, (m) => m[1]);
  }
  t.replace(/``|''/g, '"');
  t.replace(/`+/g, '');
  t.replace(/(?<=^|[\s(“"'])[*_]{1,3}(?=[^\s*_])/g, '');
  t.replace(/(?<=[^\s*_])[*_]{1,3}(?=$|[\s).,;:!?”"'])/g, '');
  t.replace(/(?<=^|\n)[ \t]{0,3}#{1,6}[ \t]+/g, '');
  t.replace(/(?<=^|\n)[ \t]{0,3}(?:>[ \t]?)+/g, '');
  t.replace(/(?<=^|\n)[ \t]*\|/g, '');
  t.replace(/\|[ \t]*(?=\n|$)/g, '');

  // superscripts, fractions and symbols, before NFKC
  t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g, (m, s) => {
    const mapped = [...m[0]].map((c) => SUPERSCRIPTS[c]).join('');
    if (isExponent(s, m.index)) return '^' + mapped;
    if (dropFootnotes) return '';
    return ' ' + mapped;
  });
  t.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒↉]/g, (m, s) => {
    const f = VULGAR[m[0]].replace('/', '⁄');
    return /\d/.test(s[m.index - 1] || '') ? ' ' + f : f;
  });
  t.replace(/[™®℠]/g, '');
  t.replace(/©(\s?)(?=\d{4})|©/g, (m) => (m[1] !== undefined ? 'copyright ' : ''));
  t.replace(/№\s?/g, 'number ');
  t.replace(/℅/g, 'care of');
  // degrees, minutes and seconds of arc, then feet and inches
  if (/[′″'"°]/.test(t.s)) {
    t.replace(/(?<![\w.])(\d{1,3})°\s?(\d{1,2}(?:\.\d+)?)\s?[′'](?:\s?(\d{1,2}(?:\.\d+)?)\s?(?:″|"|''|′′))?(?:\s?([NSEW])(?![\w]))?/g, (m) =>
      `${m[1]} degrees ${m[2]} minutes` + (m[3] ? ` ${m[3]} seconds` : '') + (m[4] ? ' ' + COMPASS[m[4]] : ''));
    t.replace(/(?<![\w.])(\d{1,2})\s?(?:′|')\s?(\d{1,2}(?:\.\d+)?)\s?(?:″|′′|"|'')/g, (m) => `${m[1]} ${feet(m[1])} ${m[2]} ${inches(m[2])}`);
    t.replace(/(?<![\w.])(\d{1,2})′\s?(\d{1,2}(?:\.\d+)?)(?![\d″"'])/g, (m) => `${m[1]} ${feet(m[1])} ${m[2]} ${inches(m[2])}`);
    t.replace(/(?<![\w.'])([4-8])'(\d{1,2})(?![\d'"%]|\.\d)/g, (m) => (+m[2] < 12 ? `${m[1]} feet ${m[2]} ${inches(m[2])}` : null));
    t.replace(/(?<=\d)\s?″/g, (m, s) => ' ' + inches(s.slice(Math.max(0, m.index - 3), m.index).replace(/\D/g, '')));
    t.replace(/(?<=\d)\s?′/g, ' feet');
    t.replace(/(?<=\b[A-Za-z])′/g, ' prime');
  }

  // compatibility forms (ligatures, full-width, ℃, Ⅳ), one non-ASCII run at a time
  t.replace(/[A-Za-z]?[^\x00-\x7f]+/g, (m) => m[0].normalize('NFKC'));
  t.replace(/[­​-‍⁠﻿᠎‎‏‪-‮⁦-⁩︀-️]/g, '');
  t.replace(/[-]/g, '');
  t.replace(/[\x0b\x0c]/g, '\n');
  t.replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, '');
  t.replace(/(?<=\d)[   ](?=\d{3}(?!\d))/g, '');
  t.replace(/[   -   　\t]/g, ' ');
  t.replace(/′′|″/g, '"');
  t.replace(/[‘’‚‛ʼ´`′]/g, "'");
  t.replace(/[“”„‟«»‹›]/g, '"');
  // a straight double quote after a number that doesn't close a quotation is inches: '55" TV'
  if (/\d"/.test(t.s)) {
    let at = 0;
    let open = 0;
    t.replace(/(?<=\d)"(?=$|[\s.,;:!?)]|\s?[x×]\s?\d)/g, (m, s) => {
      for (; at < m.index; at++) if (s[at] === '"') open ^= 1;
      at = m.index + 1;
      if (open) {
        open = 0;
        return null;
      }
      return 'in';
    });
  }

  // line-break hyphenation: 'infor-\nmation'
  if (t.s.includes('-\n') || t.s.includes('- \n')) {
    t.replace(/(?<![A-Za-z])([A-Za-z]{2,})-[ \t]*\n[ \t]*([a-z]{2,})/g, (m) => {
      const left = m[1];
      const right = m[2];
      const words = opts.words;
      if (words && typeof words.has === 'function') {
        if (words.has(left + right)) return left + right;
        if (words.has(left) && words.has(right)) return left + '-' + right;
        return left + right;
      }
      return COMPOUND_FIRST.has(left.toLowerCase()) ? left + '-' + right : left + right;
    });
  }

  // runs of punctuation
  t.replace(/(?<!\.)\.{4,}(?=[ \t]*\d)/g, ' ');
  t.replace(/\.(?: \.){2,}|\.{3,}|…+/g, '…');
  t.replace(/[!?][!?]+/g, (m) => (m[0].includes('?') ? '?' : '!'));
  t.replace(/,{2,}/g, ',');
  t.replace(/;{2,}/g, ';');
  t.replace(/(?<=^|\s)[-–—=_~*#•·](?:[ \t]?[-–—=_~*#•·]){2,}(?=\s|$)/g, ' ');
  t.replace(/(?<=[\p{L}\p{N}.,;:!?'")\]])[ \t]*-{2,3}[ \t]*(?=[\p{L}\p{N}'"([])/gu, ' — ');
  return t;
}

export function clean(text, opts) {
  return cleanTracked(Tracked.of(String(text ?? '')), opts).s;
}
