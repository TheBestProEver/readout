// Stray digits. plan() verbalizes numbers before g2p sees them, so this only has to
// keep odd leftovers (model numbers, raw text passed straight in) from being dropped.

const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = ' ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

function under1000(n, british) {
  const out = [];
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)], 'hundred');
    n %= 100;
    if (n && british) out.push('and');
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
  } else if (n || !out.length) out.push(ONES[n]);
  return out;
}

export function cardinal(digits, british) {
  let n = BigInt(digits);
  if (n === 0n) return 'zero';
  const groups = [];
  while (n > 0n) {
    groups.push(Number(n % 1000n));
    n /= 1000n;
  }
  const out = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (!groups[g]) continue;
    // British "one million and five"
    if (british && g === 0 && groups[0] < 100 && groups.length > 1) out.push('and');
    out.push(...under1000(groups[g], british), SCALES[g]);
  }
  return out.filter(Boolean).join(' ');
}

function ordinal(words) {
  const parts = words.split(/([ -])/);
  let last = parts.pop();
  if (ORD[last]) last = ORD[last];
  else if (last.endsWith('y')) last = last.slice(0, -1) + 'ieth';
  else last += 'th';
  return parts.join('') + last;
}

function year(n, british) {
  if (n % 100 === 0) return cardinal(String(n / 100), british) + ' hundred';
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  return cardinal(String(hi), british) + ' ' + (lo < 10 ? 'oh ' + ONES[lo] : cardinal(String(lo), british));
}

const digitsOf = (s) => [...s].map((d) => (d === '0' ? 'oh' : ONES[+d])).join(' ');

// '42' -> 'forty-two', '21st' -> 'twenty-first', '1990s' -> 'nineteen nineties', '3.14' -> 'three point one four'
export function numberWords(text, british) {
  const m = /^(\d[\d,]*)(?:\.(\d+))?(st|nd|rd|th|s|'s)?$/i.exec(text);
  if (!m) return [...text].filter((c) => /\d/.test(c)).map((d) => ONES[+d]).join(' ');
  const int = m[1].replace(/,/g, '');
  const suffix = (m[3] || '').toLowerCase();
  let words;
  if (m[2] !== undefined) words = cardinal(int, british) + ' point ' + [...m[2]].map((d) => ONES[+d]).join(' ');
  else if (int.length > 1 && int[0] === '0') words = digitsOf(int);
  else if (int.length > 15) words = [...int].map((d) => ONES[+d]).join(' ');
  else if (int.length === 4 && !m[1].includes(',') && suffix !== 'st' && suffix !== 'nd' && suffix !== 'rd' && suffix !== 'th' && +int >= 1100 && (+int < 2000 || +int >= 2010)) words = year(+int, british);
  else words = cardinal(int, british);
  if (suffix === 'st' || suffix === 'nd' || suffix === 'rd' || suffix === 'th') return ordinal(words);
  if (suffix === 's' || suffix === "'s") return words.endsWith('y') ? words.slice(0, -1) + 'ies' : words + (/(?:x|s|ch|sh)$/.test(words) ? 'es' : 's');
  return words;
}
