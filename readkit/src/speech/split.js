// Sentence splitting that knows abbreviations, initials, decimals and list numbers.
//   'Dr. Patel arrived at 5 p.m. The talk began.' -> two sentences
//   'See Fig. 3 and pp. 12-14.' / 'J. K. Rowling wrote it.' / 'Patel et al. found' -> one
// splitSentences(text) -> [{ start, end }] with surrounding spaces left out. A blank line
// always ends a sentence; a single line break doesn't (hard-wrapped text).

import { TITLES, STREETS, POST_NAME, BEFORE_NUMBER, GENERAL, SENTENCE_END } from '../../data/speech/abbreviations.js';
import { romanValue } from './numbers.js';
import { STARTERS } from './rules/util.js';

// Never end a sentence: titles before a name, 'e.g.', 'cf.', 'vs.'.
const NEVER = new Set(['e.g', 'eg', 'i.e', 'ie', 'cf', 'Cf', 'viz', 'vs', 'Vs', 'v', 'approx', 'Approx', 'ca', 'c', 'circa', 'esp', 'incl', 'excl', 'seq', 'ff', 'sc', 'q.v', 'op', 'loc', 'cit', 'b', 'd', 'fl', 'r', 'est', 'Est', 'n.b', 'N.B', 'a.k.a',
  // kings in statute references: '30 Geo. III. c. 4'
  'Geo', 'Edw', 'Hen', 'Car', 'Jac', 'Ric', 'Wm', 'Vict']);
for (const k of Object.keys(TITLES)) if (!STREETS[k]) NEVER.add(k);
// End a sentence only when a typical sentence opener follows: 'etc. The', 'U.S. It', '5 p.m. Then'.
const MAYBE = new Set(['etc', '&c', 'al', 'Inc', 'Ltd', 'Co', 'Corp', 'Bros', 'Jr', 'Sr', 'Jnr', 'Snr', 'Esq', 'Mfg', 'Intl', 'Assn', 'dept', 'Dept', 'govt', 'misc', 'univ', 'Univ', 'bldg', 'Bldg', 'ibid', 'Ibid', 'resp', 'Ph.D', 'p.a', 'p.w']);
for (const k of [...Object.keys(STREETS), ...Object.keys(POST_NAME)]) MAYBE.add(k);
for (const [k] of [...GENERAL, ...SENTENCE_END]) {
  const key = k.replace(/\.$/, '');
  if (k.endsWith('.') && !NEVER.has(key)) MAYBE.add(key);
}
// Months and weekdays: 'Jan. 5' carries on, 'in Jan. The' ends.
for (const k of ['Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'Mon', 'Tue', 'Tues', 'Wed', 'Thu', 'Thur', 'Thurs', 'Fri', 'Sat', 'Sun']) MAYBE.add(k);

const CAP_ENDS = new Set(['etc', '&c', 'a.m', 'p.m', 'A.M', 'P.M']);
const AFTER_TIME = /^(?:Eastern|Pacific|Central|Mountain|Atlantic|Greenwich|British|GMT|BST|UTC|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|IST|AEST|ET|PT|CT|MT|Z)$/;

const CANDIDATE = /[.!?…‽]+|\n[ \t]*\n/g;
const CLOSERS = /["'”’)\]»›]*/y;
const SPACE = /\s+/y;
const NEXT_WORD = /["'“‘(\[«]*([\p{L}\p{N}][\p{L}\p{N}'’]*)/uy;
const TOKEN_BEFORE = /([\p{L}\p{N}&](?:[\p{L}\p{N}.'’&]*[\p{L}\p{N}])?)$/u;

function isBoundary(text, i, punct, after) {
  // what follows
  SPACE.lastIndex = after;
  const sp = SPACE.exec(text);
  if (!sp) return after >= text.length;
  const at = after + sp[0].length;
  if (at >= text.length) return true;
  if (/\n[ \t]*\n/.test(sp[0])) return true;
  NEXT_WORD.lastIndex = at;
  const nw = NEXT_WORD.exec(text);
  const next = nw ? nw[1] : '';
  const c = next[0] || text[at];
  const lower = /\p{Ll}/u.test(c);
  const upper = /\p{Lu}/u.test(c);
  const digit = /\p{N}/u.test(c);
  if (punct !== '.') {
    // '?', '!' and '…' end a sentence unless the next word is lowercase ('Yahoo! is', 'Wait… what')
    return !lower;
  }
  if (lower) return false;
  // '&c. &c.' never starts a sentence
  if (text[at] === '&') return false;
  const tm = TOKEN_BEFORE.exec(text.slice(Math.max(0, i - 24), i));
  const tok = tm ? tm[1] : '';
  // a list number at the start of a line: '1. Mix the flour'
  if (/^\d{1,3}$/.test(tok) || /^[a-zA-Z]$/.test(tok)) {
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    if (!text.slice(lineStart, i - tok.length).trim()) return false;
  }
  if (!tok) return upper || digit || !nw;
  // 'p. 12', 'A.D. 1776', 'sect. 2' carry on before a number, and so do old amounts: '3l. 10s. 6d.'
  if (digit && /^\d[\d,]*[ls]$/.test(tok)) return false;
  if (digit) return !BEFORE_NUMBER[tok] && !NEVER.has(tok) && !MAYBE.has(tok) && !/^\p{L}$/u.test(tok) && !/^(?:\p{L}\.)+\p{L}$/u.test(tok);
  const starter = STARTERS.has(next);
  if (NEVER.has(tok)) return false;
  // 'etc. Bring...', '5 p.m. Then...': any capital starts a new sentence, bar a time zone
  if (CAP_ENDS.has(tok)) return !AFTER_TIME.test(next);
  // 'Dr. Will Patel' is one sentence; 'Mulholland Dr. The road' is two
  if (TITLES[tok] && STREETS[tok]) {
    const prev = /(\S+)\s+$/.exec(text.slice(Math.max(0, i - tok.length - 30), i - tok.length));
    return starter && !!prev && /^(?:\p{Lu}[\p{L}'’-]*|\d+(?:st|nd|rd|th)?)$/u.test(prev[1]);
  }
  // 'ch. III', 'Vol. IV'
  if ((BEFORE_NUMBER[tok] || BEFORE_NUMBER[tok[0] + tok.slice(1).toLowerCase()]) && /^[IVXLC]+$|^[ivxlc]+$/.test(next) && romanValue(next)) return false;
  if (MAYBE.has(tok)) return starter;
  // initials ('J. K. Rowling') and dotted initialisms ('U.S.', 'a.m.'); 'plan B. Then' ends
  if (/^\p{L}$/u.test(tok) || /^(?:\p{L}\.)+\p{L}$/u.test(tok)) return starter;
  return upper || digit || !nw;
}

export function splitSentences(text) {
  const s = String(text ?? '');
  const out = [];
  let start = 0;
  const push = (a, b) => {
    while (a < b && /\s/.test(s[a])) a++;
    while (b > a && /\s/.test(s[b - 1])) b--;
    if (b > a) out.push({ start: a, end: b });
  };
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(s); m; m = CANDIDATE.exec(s)) {
    const i = m.index;
    if (m[0][0] === '\n') {
      push(start, i);
      start = i + m[0].length;
      continue;
    }
    // decimals and dotted words inside a token: '3.14', 'node.js', 'U.S.A' mid-word
    const end = i + m[0].length;
    if (/[\p{L}\p{N}]/u.test(s[end] || '') && m[0] === '.') continue;
    CLOSERS.lastIndex = end;
    const after = end + CLOSERS.exec(s)[0].length;
    const punct = /[?!‽]/.test(m[0]) ? '?' : m[0].includes('…') || m[0].length > 1 ? '…' : '.';
    if (isBoundary(s, i, punct, after)) {
      push(start, after);
      start = after;
    }
  }
  push(start, s.length);
  return out;
}
