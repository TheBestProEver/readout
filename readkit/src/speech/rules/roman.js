// Roman numerals, only where something says they are numerals.
//   Henry VIII -> 'Henry the Eighth', Pope John Paul II, King Zog I, Elizabeth I ruled
//   Chapter IV / CHAPTER VII / Book II / chapter iii / World War I -> cardinals
//   (ii), (iv) in running text -> 'two', 'four'

import { CUES, CUE_PHRASES, REGNAL_NAMES, REGNAL_TITLES } from '../../../data/speech/roman.js';
import { cardinal, ordinal, romanValue } from '../numbers.js';
import { alternation, capitalize } from './util.js';

const NAMES = alternation(REGNAL_NAMES);
const TITLE_ALT = alternation(REGNAL_TITLES);
const ROMAN = '([IVXLC]+)';
const AFTER = "(?=['’]s\\b|[^\\p{L}\\p{N}'’-]|$)";
// 'Henry VIII', 'King Zog I', 'Pope Pius XII'; the name may be two words ('John Paul').
const REGNAL = new RegExp(`(?<![\\p{L}\\p{N}])(?:((?:${TITLE_ALT})\\s+\\p{Lu}[\\p{Ll}'’-]+(?:\\s\\p{Lu}[\\p{Ll}]+)?)|(${NAMES}))\\s+${ROMAN}${AFTER}`, 'gu');
const CUE_WORDS = [...CUES, ...CUE_PHRASES].flatMap((w) => [w, w.toUpperCase(), w.toLowerCase()]);
// Numerals with D or M, and a lone C or L, are letters here ('Part D', 'Type C').
const CUE = new RegExp(`(?<![\\p{L}\\p{N}])((?:${alternation(CUE_WORDS)})\\.?)\\s+([IVXLC]{2,}|[IVX]|[ivxlc]{2,}|[ivx])${AFTER}`, 'gu');
// After a regnal 'I', these mean it is the pronoun: 'when Peter I think...'
const PRONOUN_NEXT = /^\s+(?:am|'m|’m|'ve|’ve|'ll|’ll|'d|’d|think|thought|know|knew|guess|believe|mean|meant|hope|feel|felt|want|wanted|need|needed|love|like|said|say|told|asked|have|do|did|don't|don’t|can|can't|can’t|cannot|will|would|could|should|must|may|might|shall|wish|see|saw|agree|suppose|reckon|promise|bet|swear|wonder|remember|forgot|got|went|came|really|just|also|never|always|still|only)\b/i;

// A numbered heading: 'II. RELATED WORK', 'IV. Results'
const HEADING_NUM = /(?<=^|\n)([ \t]*)([IVXLC]{1,7})\.(?=[ \t]+\p{Lu})/gu;

export function romanRules(t) {
  const s0 = t.s;
  if (!/[IVXLCDM]|\b[ivx]+\b/.test(s0)) return t;
  t.replace(HEADING_NUM, (m, s) => {
    const n = romanValue(m[2]);
    if (!n) return null;
    if (m[2].length === 1) {
      // 'I. Introduction' is a heading; 'I. Then I left.' is not
      const end = s.indexOf('\n', m.index);
      const rest = s.slice(m.index + m[0].length, end < 0 ? s.length : end);
      if (rest.length > 80 || /[.!?]["'”’)]*\s*$/.test(rest) || PRONOUN_NEXT.test(rest)) return null;
    }
    return [[m[1], 0, m[1].length], [capitalize(cardinal(n)) + '.', m[1].length, m[0].length]];
  });
  t.replace(REGNAL, (m, s) => {
    const n = romanValue(m[3]);
    if (!n || n > 39) return null;
    const end = m.index + m[0].length;
    if (m[3] === 'I' && PRONOUN_NEXT.test(s.slice(end, end + 12))) return null;
    const name = m[1] || m[2];
    return [[name, 0, name.length], ' ', ['the ' + capitalize(ordinal(n)), m[0].length - m[3].length, m[0].length]];
  });
  t.replace(CUE, (m, s) => {
    const r = m[2];
    const cue = m[1];
    // lowercase numerals only after a lowercase or capitalised cue ('chapter iv', 'Act II, scene iii')
    if (r !== r.toUpperCase() && cue === cue.toUpperCase()) return null;
    // 'the year I was born', 'the book I read': a lowercase cue never takes a lone 'I'
    // ('chapter I.', 'book V,' from 'ch. I.', 'b. V,' are numerals: punctuation follows)
    const end = m.index + m[0].length;
    const closed = /^\s*(?:[.,;:)\]]|$)/.test(s.slice(end, end + 3));
    if (r === 'I') {
      if ((cue === cue.toLowerCase() && !closed) || PRONOUN_NEXT.test(s.slice(end, end + 12))) return null;
    } else if (r.length === 1 && r === r.toUpperCase() && cue === cue.toLowerCase() && !closed) return null;
    const n = romanValue(r);
    if (!n || n > 200) return null;
    return [[cue, 0, cue.length], ' ', [cardinal(n), m[0].length - r.length, m[0].length]];
  });
  // (i), (ii), (iv) enumerations; single letters only when a longer numeral is near
  if (/\((?:ii|iii|iv|vi|vii|viii|ix)\)/i.test(t.s)) {
    t.replace(/(?<=^|\s)\(([ivx]{1,5})\)(?=\s|$)/g, (m) => {
      const n = romanValue(m[1]);
      return n ? [[cardinal(n), 1, m[0].length - 1]] : null;
    });
  } else {
    t.replace(/(?<=^|\s)\((ii|iii|iv|vi|vii|viii|ix|xi|xii)\)(?=\s|$)/g, (m) => [[cardinal(romanValue(m[1])), 1, m[0].length - 1]]);
  }
  return t;
}

// A heading that is only a numeral: 'III.' -> 'Three.'
export function romanHeading(text) {
  const m = /^\s*([IVXLC]{1,7})\s*([.:]?)\s*$/.exec(text);
  if (!m) return null;
  const n = romanValue(m[1]);
  return n ? capitalize(cardinal(n)) + '.' : null;
}
