// Number words for American and British English. British English says "and" after
// hundreds and before a last group under a hundred: "one hundred and one",
// "two thousand and seven", "one million and five". American English doesn't.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion'];
const ORDINAL_WORDS = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

export const digitWord = (d) => ONES[+d];

export function under100(n) {
  n = +n;
  return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
}

function under1000(n, uk) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!h) return under100(r);
  return ONES[h] + ' hundred' + (r ? (uk ? ' and ' : ' ') + under100(r) : '');
}

// Digit by digit: '0123' -> 'oh one two three'.
export function digits(str, zero = 'zero') {
  const out = [];
  for (const c of String(str)) {
    if (c >= '0' && c <= '9') out.push(c === '0' ? zero : ONES[+c]);
  }
  return out.join(' ');
}

// '1,234' | 1234 | '-5' -> words. Integers only; anything past septillions is read digit by digit.
export function cardinal(value, uk = false) {
  let s = String(value).replace(/[,\s_]/g, '');
  let neg = false;
  if (s[0] === '-' || s[0] === '−') {
    neg = true;
    s = s.slice(1);
  }
  if (!/^\d+$/.test(s)) return String(value);
  s = s.replace(/^0+(?=\d)/, '');
  const sign = neg ? 'minus ' : '';
  if (s.length > SCALES.length * 3) return sign + digits(s);
  if (s === '0') return sign + 'zero';
  const groups = [];
  for (let e = s.length; e > 0; e -= 3) groups.push(+s.slice(Math.max(0, e - 3), e));
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    if (i === 0 && uk && groups.length > 1 && g < 100) parts.push('and');
    parts.push(under1000(g, uk) + (i ? ' ' + SCALES[i] : ''));
  }
  return sign + parts.join(' ');
}

// 'twenty-one' -> 'twenty-first'
export function toOrdinal(words) {
  return words.replace(/([a-z]+)$/, (w) => ORDINAL_WORDS[w] || (w.endsWith('y') ? w.slice(0, -1) + 'ieth' : w + 'th'));
}

export const ordinal = (value, uk = false) => toOrdinal(cardinal(value, uk));

// 'nineteen ninety' -> 'nineteen nineties', 'twenty' -> 'twenties', 'six' -> 'sixes'
export function pluralWords(words) {
  return words.replace(/([a-z]+)$/, (w) => (w.endsWith('y') ? w.slice(0, -1) + 'ies' : /(?:x|s|sh|ch)$/.test(w) ? w + 'es' : w + 's'));
}

// '3.14' -> 'three point one four'; '.5' -> 'point five'; UK '0.5' -> 'nought point five'.
export function decimal(str, uk = false) {
  let s = String(str).replace(/[,\s]/g, '');
  let neg = false;
  if (s[0] === '-' || s[0] === '−') {
    neg = true;
    s = s.slice(1);
  }
  const dot = s.indexOf('.');
  const int = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  let out = '';
  if (int) out = /^0+$/.test(int) ? (uk ? 'nought' : 'zero') : cardinal(int, uk);
  if (frac) out += (out ? ' ' : '') + 'point ' + digits(frac, uk ? 'oh' : 'zero');
  return (neg ? 'minus ' : '') + (out || 'zero');
}

export const numberWords = (s, uk = false) => (String(s).includes('.') ? decimal(s, uk) : cardinal(s, uk));

// Years read in pairs: 1066 'ten sixty-six', 1905 'nineteen oh five', 1900 'nineteen
// hundred', 2024 'twenty twenty-four'; 2000-2009 as cardinals ('two thousand and seven' in UK).
export function year(value, uk = false) {
  const s = String(value);
  const n = +s;
  if (!/^\d+$/.test(s) || n < 1000 || n >= 10000) return cardinal(s, uk);
  if (n % 1000 === 0 || (n >= 2000 && n < 2010)) return cardinal(s, uk);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return under100(hi) + ' hundred';
  if (lo < 10) return under100(hi) + ' oh ' + ONES[lo];
  return under100(hi) + ' ' + under100(lo);
}

// Model and room numbers: 747 'seven forty-seven', 101 'one oh one', 380 'three eighty',
// 4090 'forty ninety'. Leading zeros and long strings fall back to digits.
export function serial(str, uk = false) {
  const s = String(str);
  if (/^0/.test(s) && s.length > 1) return digits(s, 'oh');
  if (s.length <= 2) return cardinal(s, uk);
  if (s.length === 3) {
    const r = +s.slice(1);
    if (r === 0) return cardinal(s, uk);
    return ONES[+s[0]] + ' ' + (r < 10 ? 'oh ' + ONES[r] : under100(r));
  }
  if (s.length === 4) return year(s, uk);
  return digits(s, 'oh');
}

// Roman numerals, validated: 'XIV' -> 14, 'IIII' -> null.
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const ROMAN_RE = /^M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
export function romanValue(str) {
  const s = String(str).toUpperCase();
  if (!s || !ROMAN_RE.test(s)) return null;
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    const a = ROMAN[s[i]];
    const b = ROMAN[s[i + 1]] || 0;
    t += a < b ? -a : a;
  }
  return t;
}
