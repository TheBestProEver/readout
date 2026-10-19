// Numbers that aren't money, dates or measurements.
//   ISBN 978-0-306-40615-7 -> digit by digit; 192.168.0.1; v2.0.1 -> 'version two point oh point one'
//   1.234,56 (European) -> 1234.56
//   1990s -> 'nineteen nineties', '90s -> 'nineties'
//   1066 -> 'ten sixty-six' when it is a year (cues, or no counted noun after it)
//   21st -> 'twenty-first'; Boeing 747 -> 'seven forty-seven'; ZIP 20500 -> 'two oh five oh oh'
//   B12, MP3, COVID-19, F-35, 4K, x86, H2O, sub-4-minute -> letters and numbers
//   3:1 -> 'three to one'; -5 -> 'minus five'; 3.14; 0123 -> 'oh one two three'

import { WORD, SPELL } from '../../../data/speech/acronyms.js';
import { cardinal, decimal, digits, numberWords, ordinal, pluralWords, serial, under100, year } from '../numbers.js';
import { spellLetters } from './util.js';

export function isbnRules(t) {
  if (!/\bISBN|\bISSN/.test(t.s)) return t;
  t.replace(/\b(ISBN|ISSN)(?:-1[03])?:?\s?((?:97[89][- ]?)?\d[\d -]{6,15}[\dXx])(?![\w-])/g, (m) => {
    const groups = m[2].split(/[- ]+/).map((g) => g.split('').map((c) => (/\d/.test(c) ? digits(c, 'oh') : 'X')).join(' '));
    return spellLetters(m[1]) + ' ' + groups.join(', ');
  });
  return t;
}

export function versionRules(t, ctx) {
  if (!/\d\.\d|[vV]\d/.test(t.s)) return t;
  t.replace(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.]|\.\d)/g, (m) => {
    const parts = m.slice(1, 5);
    if (parts.some((p) => +p > 255)) return null;
    return parts.map((p) => digits(p)).join(' dot ');
  });
  const part = (p) => (p === '0' ? 'oh' : cardinal(p, ctx.uk));
  t.replace(/(?<![\w.])(?:([vV])|([Vv]ersion)\s)?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?![\w.]|\.\d)/g, (m) => {
    const parts = [m[3], m[4], m[5], m[6]].filter((p) => p !== undefined);
    const lead = m[1] ? 'version ' : m[2] ? m[2] + ' ' : '';
    return lead + parts.map(part).join(' point ');
  });
  t.replace(/(?<![\w.])[vV](\d+(?:\.\d+)?)(?![\w.]|\.\d)/g, (m) => 'version ' + numberWords(m[1], ctx.uk));
  return t;
}

export function europeanNumbers(t) {
  // '1 234 567' (SI style): a short first group, then two or more groups of three
  // ('100 200 300' is more likely a list)
  if (/\d \d{3} \d{3}/.test(t.s)) t.replace(/(?<![\d.,])\d{1,2}(?: \d{3}){2,}(?![\d.,]|\s\d)/g, (m) => m[0].replace(/ /g, ','));
  if (!/\d\.\d{3}/.test(t.s)) return t;
  t.replace(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+),(\d{1,2})(?![\d.,])/g, (m) => m[1].replace(/\./g, '') + '.' + m[2]);
  t.replace(/(?<![\d.,])\d{1,3}(?:\.\d{3}){2,}(?![\d.,])/g, (m) => m[0].replace(/\./g, ''));
  return t;
}

// '100s of people', '1,000s of birds', '10,000s of dollars': informal plurals of round numbers
// (not seconds, not a decade). Only before 'of' and a plural, so 'a timeout of 100s', 'the
// first 10s of the video' and 'the 1900s' are left to the other rules.
const ROUND_PLURAL = /(?<![\w.,$£€¥#])(1|10|100)((?:,?000)*)s(?=\s+of\s+(?:[a-z]+s|people|men|women|children|staff|cattle)\b)/g;
const BIG = ['', 'thousands', 'millions', 'billions'];

export function decadeRules(t, ctx) {
  if (!/0['’]?s/.test(t.s)) return t;
  if (/0s\s+of\s/.test(t.s)) {
    t.replace(ROUND_PLURAL, (m) => {
      const k = m[2].replace(/,/g, '').length / 3;
      if (k > 3 || (m[2] && !/^(?:,000)+$|^(?:000)+$/.test(m[2]))) return null;
      const big = BIG[k];
      if (m[1] === '1') return k ? big : null;
      return (m[1] === '10' ? 'tens' : 'hundreds') + (k ? ' of ' + big : '');
    });
  }
  t.replace(/(?<![\w.,])(1\d|20)(\d)0['’]?s(?![\w'’])/g, (m) => pluralWords(year(m[1] + m[2] + '0', ctx.uk)));
  t.replace(/(?<![\w.,'’])['’]?([1-9])0['’]?s(?![\w'’])/g, (m) => pluralWords(under100(+m[1] * 10)));
  return t;
}

// Before a four-digit number these make it a year even if a noun follows ('in 2020 people stayed home').
const STRONG_CUE = /\b(?:in|since|by|until|till|during|before|after|circa|c\.|ca\.|year|born|died|founded|established|est\.?|mid|early|late|spring|summer|autumn|fall|winter|Christmas|Easter|AD|A\.D\.|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|vintage|season|fiscal|FY|Q[1-4]|class of)[.,]?\s+$/i;
// These make it a year unless a counted noun follows ('of 2000 people').
const YEAR_CUE = /\b(?:from|to|of|the|and|or|between|through|around|years|’s|'s)[.,]?\s+$/i;
const NOT_YEAR = /\b(?:pages?|pp?\.|numbers?|no\.|nos\.|#|over|under|than|nearly|almost|only|just|exactly|some|approximately|about|roughly|at least|at most|up to|top|first|last|next|scored|scores?|costs?|paid|pay|weighs?|weighed)\s+$/i;
// Nouns that are counted rather than dated: '1500 people', 'the 2000 students'.
const COUNT_NOUN = /^\s*(?:people|persons|children|men|women|staff|employees|workers|students|pupils|members|voters|votes|residents|patients|cases|deaths|soldiers|troops|users|customers|visitors|participants|respondents|homes|houses|jobs|copies|units|items|words|pages|points|calories|feet|miles|metres|meters|kilometres|kilometers|acres|hectares|tons|tonnes|dollars|pounds|euros|times|bytes|pixels|cars|vehicles|tickets|seats|beds|rooms|steps|lines|characters|samples|images|files|hours|minutes|seconds|days|weeks|months|kg|km|m|ft|lb|mi|cm|mm|g|mg|ml)\b/;
// Any plural noun, for numbers before 1900, which are more often counts than years.
const PLURAL = /^\s*[a-z]+s\b(?<!\b(?:was|is|has|saw|as|its|this|his|hers|ours|yours|less|plus|thus|across|always|perhaps|becomes|begins|ends|sees|marks|makes|brings|remains|starts|finds|shows|gives|takes|looks|follows|comes|goes|runs|sets|says|seems|means|turns|us))/;
const ERA_AFTER = /^\s*(?:BC|BCE|AD|CE|B\.C\.|A\.D\.)/;

export function yearRules(t, ctx) {
  if (!/\b(?:1\d|20)\d\d\b/.test(t.s)) return t;
  t.replace(/(?<![\w$£€¥#.,:/\-–+−])(1\d{3}|20\d{2})(?![\w%°]|[.,:]\d|\s?[–\-/]\s?\d)/g, (m, s) => {
    const end = m.index + m[0].length;
    const before = s.slice(Math.max(0, m.index - 24), m.index);
    const after = s.slice(end, end + 24);
    const n = +m[1];
    if (ERA_AFTER.test(after) || STRONG_CUE.test(before)) return year(m[1], ctx.uk);
    if (COUNT_NOUN.test(after)) return cardinal(m[1], ctx.uk);
    if (YEAR_CUE.test(before)) return year(m[1], ctx.uk);
    if (NOT_YEAR.test(before) || (n < 1900 && PLURAL.test(after))) return cardinal(m[1], ctx.uk);
    return year(m[1], ctx.uk);
  });
  return t;
}

// Old ordinals: '2dly', '3dly', '4thly' -> 'secondly'...; '2d' and '3d' as the eighteenth
// and nineteenth centuries wrote 'second' and 'third' ('the 3d of March', '2d edition').
const OLD_ORDINAL = /(?<![\w.,])(\d{0,2}[23])d(?=\s+(?:of|edition|ed\.|volume|vol\.|book|chapter|part|regiment|battalion|session|congress|day|year|century|class|place|time|series|section|article|inst\.|ult\.|instant|ultimo)(?![a-z])|,?\s+(?:and|or|to|&)\s+\d{1,3}(?:st|nd|rd|th|d)\b)/g;

export function ordinalRules(t, ctx) {
  if (/\dd?ly\b/.test(t.s)) {
    t.replace(/(?<![\w.,])(\d{1,2})(st|nd|rd|th|d)ly(?![a-zA-Z])/g, (m) => {
      const n = +m[1];
      return n ? ordinal(n, ctx.uk) + 'ly' : null;
    });
  }
  if (/\dd\s/.test(t.s)) t.replace(OLD_ORDINAL, (m) => (+m[1] % 100 === 12 || +m[1] % 100 === 13 ? null : ordinal(m[1], ctx.uk)));
  if (!/\d(?:st|nd|rd|th|ST|ND|RD|TH)/.test(t.s)) return t;
  t.replace(/(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(st|nd|rd|th|ST|ND|RD|TH)(?![a-zA-Z])/g, (m) => {
    const n = +m[1].replace(/,/g, '');
    const sfx = m[2].toLowerCase();
    const want = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    if (sfx !== want) return null;
    return ordinal(m[1], ctx.uk);
  });
  return t;
}

const SERIAL_CUE = /\b(?:Boeing|Airbus|Flight|flight|Room|room|Route|route|Bus|bus|Platform|platform|Gate|gate|Suite|suite|Highway|Interstate|Porsche|Peugeot|Model|model|Office|Track|track|Terminal|terminal|Studio|studio|Apartment|apartment|Unit|unit|Area|Atari|Nokia|Engine|Ward|ward|Bay|bay|Locker|locker|Lot|lot)\s+$/;
const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';

const ZIP_RE = /(?<![\w.,$£€-])(\d{5})(?:-(\d{4}))?(?![\w,]|[.,]\d|\s?%)/g;
const STATE_BEFORE = new RegExp(`\\b(?:${STATES})\\s$`);

export function serialRules(t, ctx) {
  if (!/\d{3}/.test(t.s)) return t;
  t.replace(/(?<![\w.,])(\d{3,4})(?![\w,]|[.,]\d|\s?%|\s?[-–]\s?\d)/g, (m, s) => (SERIAL_CUE.test(s.slice(Math.max(0, m.index - 16), m.index)) ? serial(m[1], ctx.uk) : null));
  const zip = /\b(?:ZIP|zip|Zip)\b|\b(?:postal|post) code\b/.test(t.s);
  t.replace(ZIP_RE, (m, s) => {
    if (!zip && !STATE_BEFORE.test(s.slice(Math.max(0, m.index - 4), m.index))) return null;
    return digits(m[1], 'oh') + (m[2] ? ', ' + digits(m[2], 'oh') : '');
  });
  return t;
}

// Letters and numbers glued together.
function sayLetters(run) {
  if (run.length === 1) return run;
  if (run === run.toUpperCase()) {
    if (WORD.has(run)) return run;
    if (SPELL.has(run) || run.length <= 3 || !/[AEIOU]/.test(run)) return spellLetters(run);
    return run;
  }
  if (run === run.toLowerCase() && run.length <= 4 && !/[aeiouy]/.test(run)) return spellLetters(run);
  return run;
}

function sayDigits(d, ctx) {
  if (d.includes('.')) return decimal(d, ctx.uk);
  if (/^0\d/.test(d)) return digits(d, 'oh');
  if (d.length <= 2) return cardinal(d, ctx.uk);
  if (d.length <= 4) return serial(d, ctx.uk);
  if (d.length <= 6) return cardinal(d, ctx.uk);
  return digits(d, 'oh');
}

// '3e-4' -> 'three e minus four'; '7B parameters', '10k steps', '2T tokens' -> magnitudes
const E_NOTATION = /(?<![\w.])(\d+(?:\.\d+)?)[eE]([-+−]?)(\d{1,3})(?![\w.]|\.\d)/g;
const MAGNITUDE = /(?<![\w.,$£€¥])(\d+(?:\.\d+)?)\s?(k|K|M|B|T|bn|tn|mn)(?=\s+(?:people|men|women|children|staff|data|[a-z]+s)\b)/g;
const MAG_WORD = { k: 'thousand', K: 'thousand', M: 'million', mn: 'million', B: 'billion', bn: 'billion', T: 'trillion', tn: 'trillion' };
// '4K videos' is a resolution
const RESOLUTION = /^\s+(?:videos?|displays?|screens?|monitors?|tvs?|televisions?|streams?|cameras?|resolution|footage|movies?|films?|textures?|panels?)\b/;

export function magnitudeRules(t, ctx) {
  if (!/\d[eE][-+−]?\d|\d\s?(?:[kKMBT]|bn|tn|mn)\s/.test(t.s)) return t;
  t.replace(E_NOTATION, (m) => `${numberWords(m[1], ctx.uk)} e ${m[2] === '-' || m[2] === '−' ? 'minus ' : ''}${cardinal(m[3], ctx.uk)}`);
  t.replace(MAGNITUDE, (m, s) => {
    if (/^[kK]$/.test(m[2]) && RESOLUTION.test(s.slice(m.index + m[0].length, m.index + m[0].length + 14))) return null;
    return `${numberWords(m[1], ctx.uk)} ${MAG_WORD[m[2]]}`;
  });
  return t;
}

// not the tail of a comma-grouped number ('5,000-word')
const CODE = /(?<![\w.\-'’])(?<!\d,)(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.\d+)?(?![\w\-'’])/g;

export function codeRules(t, ctx) {
  // lettered sections: 'Appendix B.2', 'A.1.3' -> 'B point two'
  if (/[A-Z]\.\d/.test(t.s)) {
    t.replace(/(?<![\p{L}\p{N}.])([A-Z])\.(\d{1,3}(?:\.\d{1,3}){0,3})(?![\p{L}\p{N}]|\.\d)/gu, (m) => [[m[1], 0, 1], [' point ' + m[2].split('.').map((p) => cardinal(p, ctx.uk)).join(' point '), 1, m[0].length]]);
  }
  if (!/[A-Za-z]-?\d|\d-?[A-Za-z]/.test(t.s)) return t;
  t.replace(CODE, (m) => {
    const pieces = m[0].split('-');
    let out = '';
    pieces.forEach((piece, k) => {
      const runs = piece.match(/[A-Za-z]+|\d+(?:\.\d+)?/g) || [];
      const said = runs.map((r) => (/\d/.test(r) ? sayDigits(r, ctx) : sayLetters(r))).join(' ');
      if (k) {
        // keep the hyphen in words like 'sub-4-minute' and '3-year-old'
        const word = (p) => /^[a-z]{2,}$/.test(p) || (/^\d+$/.test(p) && pieces.some((q) => /^[a-z]{2,}$/.test(q)));
        out += word(pieces[k - 1]) && word(piece) ? '-' : ' ';
      }
      out += said;
    });
    return out;
  });
  return t;
}

export function ratioRules(t, ctx) {
  if (!/\d:\d/.test(t.s)) return t;
  // '1:100,000' (map scales): the second number may have thousands groups
  t.replace(/(?<![\w.:])(\d+):(\d{1,3}(?:,\d{3})+|\d+)(?![\w:]|\.\d)/g, (m) => `${cardinal(m[1], ctx.uk)} to ${cardinal(m[2].replace(/,/g, ''), ctx.uk)}`);
  return t;
}

export function numberRules(t, ctx) {
  if (!/\d/.test(t.s)) return t;
  t.replace(/(?<![\w&])#(?=\d)/g, 'number ');
  t.replace(/(?<![\w.)\]])[-−](?=\.?\d)/g, 'minus ');
  t.replace(/(?<![\w.])(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?![\w])|(?<![\w.])\.\d+(?![\w])/g, (m) => {
    const plain = m[0].replace(/,/g, '');
    if (plain[0] === '.') return 'point ' + digits(plain.slice(1), ctx.uk ? 'oh' : 'zero');
    if (/^0\d+$/.test(plain)) return digits(plain, 'oh');
    if (/^\d{7,}$/.test(m[0])) return digits(plain, 'oh');
    return numberWords(plain, ctx.uk);
  });
  // anything left glued to letters
  t.replace(/\d+/g, (m, s) => {
    const w = sayDigits(m[0], ctx);
    const pre = /\w/.test(s[m.index - 1] || '') ? ' ' : '';
    const post = /\w/.test(s[m.index + m[0].length] || '') ? ' ' : '';
    return pre + w + post;
  });
  return t;
}
