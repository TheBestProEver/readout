// Maths and symbols.
//   mathRules (after units, before numbers): x^2 -> 'x squared', 10^8 -> '10 to the power of 8',
//   f(x) -> 'f of x'
//   symbolRules (after numbers): & + = < > ≤ ≥ ± × ÷ √ π ° % § # ~ / and Greek letters -> words;
//   C++ / C# / R&D / AT&T; footnote daggers, emoji, pipes and stray braces are dropped.

import { GREEK, OPERATORS, SYMBOLS } from '../../../data/speech/symbols.js';
import { alternation, spellLetters } from './util.js';

const MATH_CUE = /[=<>≤≥+−×÷∫∑]|\b(?:if|then|let|where|function|derivative|integral|probability|value)\b/i;

export function mathRules(t) {
  const s0 = t.s;
  if (s0.includes('^')) {
    // variables multiplied together: 'mc^2' -> 'm c squared'
    t.replace(/(?<![\p{L}\p{N}])[b-df-hj-np-tv-z]{2,3}(?=\^)/gu, (m) => [...m[0]].map((c, k) => [(k ? ' ' : '') + c, k, k + 1]));
    t.replace(/\^\(?([-−]?\d+(?:\.\d+)?|[A-Za-z])\)?(?![\w]|\.\d)/g, (m) => {
      const e = m[1];
      if (e === '2') return ' squared';
      if (e === '3') return ' cubed';
      return [' to the power of ', [e, m[0].indexOf(e), m[0].indexOf(e) + e.length]];
    });
    t.replace(/\^/g, ' to the power of ');
  }
  // f(x), g(2), P(A), f(x, y); 'a(n)' in prose is left alone unless there is maths nearby
  if (s0.includes('(') && MATH_CUE.test(s0)) {
    t.replace(/(?<![\p{L}\p{N}'’.])([A-Za-z])\(([A-Za-z0-9]{1,3}(?:,\s?[A-Za-z0-9]{1,3}){0,3})\)(?![\p{L}\p{N}])/gu, (m) => [[m[1], 0, 1], ' of ', [m[2].replace(/,\s?/g, ' and '), 2, m[0].length - 1]]);
  }
  return t;
}

const ASCII_OPS = { '<=': 'less than or equal to', '>=': 'greater than or equal to', '!=': 'not equal to', '==': 'equals', '=>': 'implies', '->': 'to', '<-': 'from' };
const OPS = new RegExp(`(?<=\\s|\\w)(<=|>=|!=|==|=>|->|<-)(?=\\s|\\w)|(${alternation(Object.keys(OPERATORS))})|([${Object.keys(GREEK).join('')}])`, 'gu');
const SINGLE = /§§|[&@+=<>*~§¶%°#/†‡|\\_{}^`•·▪◦‣⁃●○■□►▸➢➤−]/g;
const BULLETS = '•·▪◦‣⁃●○■□►▸➢➤';
const WORDISH = /[\p{L}\p{N}_]/u;

// The character next to i, looking past one space: '3 * 4', 'x < 5'.
function near(s, i, dir) {
  const c = s[i + dir];
  return c === ' ' ? s[i + 2 * dir] || '' : c || '';
}

function single(m, s, ctx) {
  const c = m[0];
  const i = m.index;
  const prev = s[i - 1] || '';
  const next = s[i + c.length] || '';
  switch (c) {
    case '§§':
      return ' sections ';
    case '§':
    case '¶':
      return ' ' + SYMBOLS[c] + ' ';
    case '−': // the minus sign
      return i && /\S/.test(near(s, i, 1)) ? ' minus ' : ' ';
    case '&':
      return ' and ';
    case '@':
      return ' at ';
    case '+':
      return ' plus ';
    case '=':
      return /[\s\w)]/.test(prev || ' ') && /[\s\w(]/.test(next || ' ') ? ' equals ' : ' ';
    case '<':
    case '>': {
      const ok = /[\w)]/.test(near(s, i, -1)) && /[\w(]/.test(near(s, i, 1));
      return ok ? (c === '<' ? ' less than ' : ' greater than ') : ' ';
    }
    case '*': // between numbers it multiplies; 'A*' is a grade; otherwise emphasis or a footnote mark
      if (prev === 'A' && !/\p{L}/u.test(s[i - 2] || '')) return ' star';
      return /\w/.test(near(s, i, -1)) && /\d/.test(near(s, i, 1)) ? ' times ' : '';
    case '~':
      return /\d/.test(near(s, i, 1)) ? 'approximately ' : ' ';
    case '%':
      return ctx.uk ? ' per cent' : ' percent';
    case '°':
      return ' degrees';
    case '#': // '#hashtag', '# of people'
      if (WORDISH.test(prev) || prev === '&') return ' ';
      if (/[A-Za-z]/.test(next)) return 'hashtag ';
      return /\s/.test(next) ? 'number' : ' ';
    case '/': {
      // word/word -> 'word or word'; TCP/IP, AC/DC -> letters
      if (/\p{L}/u.test(prev) && /\p{L}/u.test(next)) {
        const before = /\p{L}+$/u.exec(s.slice(Math.max(0, i - 12), i))[0];
        const after = /^\p{L}+/u.exec(s.slice(i + 1, i + 13))[0];
        return /^[A-Z]{1,5}$/.test(before) && /^[A-Z]{1,5}$/.test(after) ? ' ' : ' or ';
      }
      // 'High 75°F / Low 58°F': a spaced slash separates, like a comma
      return prev === ' ' && next === ' ' ? ',' : ' ';
    }
    case '|': // 'Jane Doe | VP, Finance', table cells
      return prev === ' ' || next === ' ' ? ', ' : ' ';
    default:
      return BULLETS.includes(c) ? ', ' : ' ';
  }
}

export function symbolRules(t, ctx) {
  // a spaced hyphen in an equation is a minus
  if (/[=<>≤≥]/.test(t.s)) t.replace(/(?<=[\w)])\s-\s(?=[\w(])/g, ' minus ');
  // <=, ->, Unicode operators, Greek letters
  // eslint-disable-next-line no-control-regex
  if (/[<>=!-][=>]|[^\x00-\x7f]/.test(t.s)) t.replace(OPS, (m) => ' ' + (m[1] ? ASCII_OPS[m[1]] : m[2] ? OPERATORS[m[2]] : GREEK[m[3]]) + ' ');
  // C++, C#, F#
  if (/[A-Za-z](?:\+\+|#)/.test(t.s)) t.replace(/(?<![\w+#])([A-Za-z])(\+\+|#)(?![\w+#])/g, (m) => [[m[1], 0, 1], [m[2] === '#' ? ' sharp' : ' plus plus', 1, m[0].length]]);
  // R&D, Q&A, AT&T, P&O
  if (t.s.includes('&')) t.replace(/(?<![\w&])([A-Z]{1,3})&([A-Z]{1,3})(?![\w&])/g, (m) => spellLetters(m[1]) + ' and ' + spellLetters(m[2]));
  t.replace(SINGLE, (m, s) => single(m, s, ctx));
  // eslint-disable-next-line no-misleading-character-class
  t.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '');
  return t;
}
