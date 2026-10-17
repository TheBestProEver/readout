// Capitals: initialisms, acronyms and shouting.
//   U.S. / a.m. -> 'U S' / 'A M'; FBI, PDFs, CEO's -> 'F B I', 'P D Fs', 'C E O's'
//   NASA, COVID, IKEA stay words; unknown ALL-CAPS words are words when pronounceable
//   ('SAVE', 'THERE'), letters otherwise ('ONS', 'UNHCR')
//   lines mostly in capitals ('OF THE RIVER TRADE AND ITS MILLS') -> sentence case

import { WORD, SPELL, MIXED_SPELL, SHORT_WORDS } from '../../../data/speech/acronyms.js';
import { cardinal, romanValue } from '../numbers.js';
import { capitalize, endDot, spellLetters } from './util.js';

// Common short words that are words, not initialisms, when written in capitals.
const CAPS_WORDS = new Set(`THE AND FOR BUT NOT ALL ONE TWO SIX TEN OUR YOU ARE WAS HAS HAD CAN MAY NEW OLD ANY OFF OUT
WHO WHY HOW NOW YES GET GOT SEE SAW SAY SAID USE ITS HIS HER HIM SHE THEY THEM THAN THAT THIS WITH FROM HAVE WILL
YOUR WHAT WHEN SOME MORE MOST VERY JUST ONLY ALSO INTO OVER SUCH EACH BOTH BEEN WERE DOES DID DONE MADE MAKE TAKE
ARE AGE ART BAD BIG BOX BOY BUY CAR CAT CUT DAY DOG EAR EAT END EYE FAR FEW FIT FLY FUN GAS GOD GUN GUY HAT HOT
ICE JOB KEY KID LAW LAY LEG LET LIE LOT LOW MAN MEN MOM DAD NOR ODD OIL OWN PAY PEN PET PUT RAN RED RUN SAD SAT
SEA SET SIT SKY SON SUN TAX TEA TOP TOY TRY USE WAR WAY WET WIN WON YET ZOO NEVER ALWAYS STOP WARNING NOTE CAUTION
DANGER FREE SALE NEWS`.split(/\s+/));
// Ambiguous initialisms that are ordinary words in a line of capitals ('TELL US', 'WHO AM I').
const LINE_WORDS = new Set(['US', 'IT', 'WHO', 'AM', 'PM', 'ID', 'OR', 'ME', 'NO', 'OK', 'AD', 'CAT', 'SEC', 'ACT', 'AIM', 'ART']);

const ONSETS = new Set(['BL', 'BR', 'CH', 'CL', 'CR', 'DR', 'DW', 'FL', 'FR', 'GL', 'GR', 'GN', 'KL', 'KN', 'KR', 'PH', 'PL', 'PR', 'PS', 'QU', 'SC', 'SH', 'SK', 'SL', 'SM', 'SN', 'SP', 'ST', 'SW', 'TH', 'TR', 'TW', 'WH', 'WR', 'SCH', 'SCR', 'SHR', 'SPL', 'SPR', 'SQU', 'STR', 'THR']);

// Could this run of capitals be read as a word? 'SAVE', 'THERE', 'NATO' yes; 'UNHCR', 'NHS' no.
export function pronounceable(w) {
  const s = w.toUpperCase();
  if (s.length < 4 || !/[AEIOUY]/.test(s)) return false;
  const onset = /^[^AEIOUY]*/.exec(s)[0];
  if (onset.length > 1 && !ONSETS.has(onset)) return false;
  // digraphs count as one consonant: 'WEALTH', 'STRENGTH', 'LENGTHS' ('TH', 'NG' -> 'C')
  const d = s.slice(onset.length).replace(/TH|CH|SH|PH|GH|CK|NG/g, 'C');
  if (/[^AEIOUY]{4}/.test(d) || /[AEIOU]{3}/.test(d.replace(/EAU|IOU|UEUE/g, 'A'))) return false;
  const coda = /[^AEIOUY]*$/.exec(d)[0];
  if (coda.length > 2 && !/^(?:[^AEIOUY]{2}S|NTS|NDS|RST|NST|RLD|MPT|LCT|NCT|RCT|XCS?|CCS?)$/.test(coda)) return false;
  // inner clusters of three need an s or a liquid: 'MONSTER', 'ANGLE'
  for (const c of d.match(/[^AEIOUY]{3}/g) || []) if (!/[SLRHNC]/.test(c)) return false;
  return true;
}

const PREV_CAP = /\p{Lu}[\p{Ll}'’-]+\s+$/u;

function lowerWord(w, first) {
  const low = w.toLowerCase();
  return first ? capitalize(low) : low;
}

// One run of capitals (with an optional plural 's' or possessive) in mixed text.
function sayCaps(word, line, atStart, prevCap) {
  const m = /^([A-Z]+)(s|['’]s|['’])?$/.exec(word);
  if (!m) return null;
  const [, base, tail = ''] = m;
  if (base.length < 2) return null;
  // the lexicon knows these in capitals
  if (WORD.has(base) || WORD.has(word)) return null;
  if (line && (LINE_WORDS.has(base) || CAPS_WORDS.has(base) || SHORT_WORDS.has(base))) return lowerWord(word, atStart);
  // 'Rocky II', 'Phase VII': a numeral after a capitalised word
  if (/^(?:I{2,3}|VI{1,3}|IX|XI{1,3}|XI?V|XVI{1,3}|XIX)$/.test(base) && !tail && prevCap) return cardinal(romanValue(base));
  if (SPELL.has(base) || SPELL.has(word)) return spellLetters(base) + tail;
  if (!line && SHORT_WORDS.has(base) && !tail) return lowerWord(word, atStart);
  if (CAPS_WORDS.has(base)) return lowerWord(word, atStart);
  if (pronounceable(base)) return lowerWord(word, atStart);
  return spellLetters(base) + tail;
}

// Most words in capitals: a heading or a shouted line.
function capsLine(s) {
  const words = s.match(/[\p{L}][\p{L}'’-]*/gu) || [];
  const long = words.filter((w) => w.length > 1);
  if (long.length < 2) return long.length === 1 && words.length === 1 && long[0].length > 3 && long[0] === long[0].toUpperCase();
  const caps = long.filter((w) => w === w.toUpperCase() && /\p{Lu}/u.test(w)).length;
  return caps >= 2 && caps / long.length >= 0.7;
}

export function capsRules(t, ctx) {
  const s0 = t.s;
  if (!/[A-Z]/.test(s0)) return t;
  // dotted initialisms: U.S., U.K., a.m., B.B.C. (the full stop stays when the sentence ends)
  if (/[A-Za-z]\.[A-Za-z]\./.test(s0)) {
    t.replace(/(?<![\p{L}\p{N}.])((?:\p{L}\.){2,})(?![\p{L}\p{N}])/gu, (m, s) => spellLetters(m[1]) + endDot(s, m.index + m[0].length));
  }
  // mixed-case initialisms: PhD, MSc, GmbH
  t.replace(/(?<![\p{L}\p{N}])[A-Z][A-Za-z]{1,4}(?:s|['’]s)?(?![\p{L}\p{N}])/gu, (m) => {
    const tail = /(?:s|['’]s)$/.exec(m[0]);
    const base = tail && !MIXED_SPELL.has(m[0]) ? m[0].slice(0, -tail[0].length) : m[0];
    if (!MIXED_SPELL.has(base) || base === base.toUpperCase()) return null;
    return spellLetters(base) + (base === m[0] ? '' : tail[0]);
  });
  const line = capsLine(t.s);
  const first = t.s.search(/[^\s"'“‘(]/);
  t.replace(/(?<![\p{L}\p{N}'’])[A-Z]{1,12}(?:s|['’]s|['’])?(?![\p{L}\p{N}])/gu, (m, s) => {
    const before = s.slice(Math.max(0, m.index - 30), m.index);
    const atStart = m.index <= first || /[.!?:]\s*["'“‘(]*$/.test(before);
    return sayCaps(m[0], line, atStart, PREV_CAP.test(before));
  });
  if (line) {
    // what is left in capitals in a heading: hyphenated parts, single letters at the start
    t.replace(/(?<![\p{L}])\p{Lu}{2,}(?=[-'’])/gu, (m) => (WORD.has(m[0]) || SPELL.has(m[0]) ? null : m[0].toLowerCase()));
  }
  // British English says 'zed' for the letter Z ('Gen Z', 'A to Z', 'Z S L')
  if (ctx && ctx.uk && t.s.includes('Z')) t.replace(/(?<![\p{L}\p{N}'’.])Z(?![\p{L}\p{N}'’])/gu, 'zed');
  return t;
}
