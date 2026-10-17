// Token shapes shared by OCR result scoring and post-OCR correction: what counts
// as a real word, a number, a code like B12 or COVID-19, or junk.

// The frequency lists contain almost every pair of letters ("rn", "ll", "tb"), so
// one- and two-letter tokens are only words when they are on this list.
const SHORT = new Set(
  (
    'a i of to in is on by it as or be at he an we us if my do no up so am me go oh ok ah ha hi ho lo ma pa ' +
    'uh um ye yo ax ex id ad eh hm mm ow oy re mr ms dr st vs pm co uk tv pc cd dj dc la ny eu un ai vr ' +
    'ip hr ft km kg cm ml mg lb oz mb gb kb tb hz ph pp ed jr sr nd rd th'
  ).split(' ')
);
// Two-letter abbreviations only accepted in capitals (as in 'IT department').
const SHORT_CAPS = new Set('IT AI US UK EU UN TV PC CD DJ DC LA NY ID IQ GP MP MD PA BA MA BC AD OK PR HR VR AR TB DR UV EV AM PM NB PS'.split(' '));

export const isShortWord = (w) => SHORT.has(w.toLowerCase()) || SHORT_CAPS.has(w);
// Short words a misread may be corrected to (no abbreviations: 'sl' must not become 'st').
const TARGETS = new Set('a i of to in is on by it as or be at he an we us if my do no up so am me go oh ok'.split(' '));
export const isShortTarget = (w) => TARGETS.has(w);

// Strip punctuation around a token: '"Hello,' -> { pre: '"', w: 'Hello', post: ',' }.
export function core(token) {
  const t = String(token);
  let a = 0;
  let b = t.length;
  while (a < b && !isAlnum(t.charCodeAt(a), t[a])) a++;
  while (b > a && !isAlnum(t.charCodeAt(b - 1), t[b - 1])) b--;
  return { pre: t.slice(0, a), w: t.slice(a, b), post: t.slice(b) };
}
const ALNUM = /[\p{L}\p{N}]/u;
function isAlnum(code, ch) {
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return ALNUM.test(ch);
}

// Numbers, times, money, percentages, ordinals, years: '1,250', '7:42', '£15',
// '4.2%', '1990s', '3s', '6d', '14th', '10am', '5km', '1080p'.
const NUMBER = /^[£$€#]?[+-]?\d[\d.,:/%-]*(?:st|nd|rd|th|s|d|am|pm|k|m|bn|x|p|kb|mb|gb|tb|km|kg|cm|mm|ml|mg|lb|lbs|oz|hz|khz|mhz|ghz|fps|mph|kph|px|ft|in|v|w)?%?$/i;
export const isNumberish = (w) => NUMBER.test(w) && /\d/.test(w);

// Codes and product names that must never be "corrected" or dropped as junk.
const CODES = [
  /^[A-Z]{1,6}\d{1,4}[A-Z]{0,2}$/, // B12 CO2 MP3 A4 H2O F16
  /^[A-Z]{1,8}-\d{1,4}[A-Za-z]?$/, // COVID-19 F-35
  /^[a-z]\d{2,4}$/, // x86 x64
  /^\d{1,4}[A-Z]{1,3}$/, // 4K 3D 5G 2FA
  /^[A-Z]\d-[A-Z]\d$/, // R2-D2
  /^[ie][A-Z][a-z]{2,}(?:[A-Z][a-z]+)?$/, // iPhone eBay iTunes eBook ('tHe' is a misread)
  /^[a-z][A-Z]{2,5}s?$/, // iOS mRNA eSIM
  /^(?:Mc|Mac|O')[A-Z][a-z]+$/, // McDonald MacArthur
  /^[A-Z][a-z]+[A-Z][a-z]+$/, // YouTube PowerPoint GitHub
];
// 'I1', 'O0', 'l1' are misread letters, not codes.
export const isCode = (w) => !/^[IOl|][0-9]$/.test(w) && CODES.some((re) => re.test(w));

// All capitals, like NASA, BBC, URLs.
export const isAcronym = (w) => /^[A-Z]{2,7}s?$/.test(w) && w.length <= 8;

const VOWEL = /[aeiouyAEIOUY]/;
// Shapes that real words almost never have: aBc, no vowels, digits between
// letters, three repeats, long consonant runs, stray symbols inside.
export function isWeird(w) {
  if (isCode(w) || isNumberish(w)) return false;
  if (/[a-z][A-Z]/.test(w)) return true;
  if (/\p{L}\p{N}|\p{N}\p{L}/u.test(w)) return true;
  if (!VOWEL.test(w) && !isShortWord(w) && !isAcronym(w)) return true;
  if (/(.)\1\1/.test(w)) return true;
  if (/[bcdfghjklmnpqrstvwxz]{6}/i.test(w)) return true;
  if (/[^\p{L}\p{N}'’.\-&]/u.test(w)) return true;
  return false;
}

// Is `w` (no surrounding punctuation) an English word in `words` (loadWords())?
// Accepts possessives, contractions and hyphenated compounds of known parts.
export function isKnown(words, w) {
  if (!w) return false;
  if (w.length <= 2) return isShortWord(w);
  const l = w.toLowerCase().replace(/[’‘]/g, "'");
  if (words.has(l)) return true;
  const base = l.replace(/'(?:s|d|ll|re|ve|m)$|n't$|s'$/, '');
  if (base !== l && base.length > 1 && (words.has(base) || (base.length <= 2 && SHORT.has(base)))) return true;
  if (l.includes('-')) {
    const parts = l.split('-');
    return parts.length <= 4 && parts.every((p) => p && (isNumberish(p) || (p.length <= 2 ? SHORT.has(p) : words.has(p))));
  }
  return false;
}
