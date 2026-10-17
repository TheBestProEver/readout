// Splits speech text into words and punctuation, the way misaki's spaCy tokenization
// does for already-verbalized text. Each character is looked at a bounded number of
// times, so the cost is linear in the input.
//
// Token = { text, ws, kind: 'word' | 'punct', parts?, ps? }
//   ws: ' ' when whitespace followed it in the input
//   parts: a word's pieces, e.g. 'well-known' -> ['well', '-', 'known']
//   ps: the symbol a punctuation mark becomes for Kokoro ('' = silent)

const SPACE = /\s/;
const LETTER = /[\p{L}\p{M}]/u;
const DIGIT = /\p{Nd}/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const APOS = "'’‘ʼ";
const HYPHEN = '-‐‑_';
const DASH = '—–―';
const OPEN = '([{';
const CLOSE = ')]}';
const OPEN_Q = '“„«‹‘';
const CLOSE_Q = '”»›’';
const HARD = ',;:!?…' + DASH + OPEN + CLOSE + '"“”„«»‹›';
// Apostrophe-initial words: 'em, 'tis, 'cause, '90s.
const LEAD_APOS = /^['’‘ʼ](?:em|tis|twas|cause|cos|til|till|bout|round|n|s|nuff|ere|im|er|ave|ow|appen|\d\ds?)$/i;
const DOTTED = /^(?:\p{L}{1,2}\.)+\p{L}{0,2}$/u;
const isWordChar = (c) => c !== undefined && (LETTER.test(c) || DIGIT.test(c));

function punct(c, prev) {
  if (',;:!?.'.includes(c)) return c;
  if (c === '…') return '…';
  if (DASH.includes(c) || HYPHEN.includes(c)) return '—';
  if (OPEN.includes(c)) return '(';
  if (CLOSE.includes(c)) return ')';
  if (OPEN_Q.includes(c)) return '“';
  if (CLOSE_Q.includes(c)) return '”';
  if (c === '"' || APOS.includes(c)) return !prev || SPACE.test(prev) || OPEN.includes(prev) || OPEN_Q.includes(prev) ? '“' : '”';
  return '';
}

// Pieces of a word: letter runs (with inner apostrophes), numbers (with inner , and .
// and an ordinal or plural suffix), hyphen runs, and single symbols.
function parts(core) {
  if (DOTTED.test(core)) return [core];
  const out = [];
  let i = 0;
  while (i < core.length) {
    const c = core[i];
    let j = i + 1;
    if (LETTER.test(c) || (APOS.includes(c) && i === 0 && isWordChar(core[1]))) {
      // misaki splits camelCase: 'iPhone' -> i Phone, 'JavaScript' -> Java Script, 'AWord' -> A Word
      if (UPPER.test(c) && UPPER.test(core[j] || '') && LOWER.test(core[j + 1] || '')) {
        out.push(c);
        i = j;
        continue;
      }
      while (j < core.length && (LETTER.test(core[j]) || (APOS.includes(core[j]) && (LETTER.test(core[j + 1] || '') || j === core.length - 1)))) {
        if (UPPER.test(core[j]) && LOWER.test(core[j - 1])) break;
        j++;
      }
    } else if (DIGIT.test(c)) {
      while (j < core.length && (DIGIT.test(core[j]) || ((core[j] === ',' || core[j] === '.') && DIGIT.test(core[j + 1] || '')))) j++;
      let k = j;
      while (k < core.length && k - j < 3 && LOWER.test(core[k])) k++;
      if (k - j <= 2 && !LETTER.test(core[k] || '')) j = k; // 21st, 1990s
    } else if (HYPHEN.includes(c)) {
      while (j < core.length && HYPHEN.includes(core[j])) j++;
    }
    out.push(core.slice(i, j));
    i = j;
  }
  return out;
}

export function tokenize(text) {
  const tokens = [];
  const s = String(text == null ? '' : text).replace(/[­​-‍⁠﻿]/g, '');
  let end = s.length;
  while (end > 0 && SPACE.test(s[end - 1])) end--;

  const pushPunct = (c, prev) => {
    const ps = punct(c, prev);
    const last = tokens[tokens.length - 1];
    if (ps === '—' && last && last.kind === 'punct' && last.ps === '—' && !last.ws) last.text += c; // '--'
    else tokens.push({ text: c, ws: '', kind: 'punct', ps });
  };

  const chunk = (a, b) => {
    // leading punctuation
    while (a < b) {
      const c = s[a];
      if (isWordChar(c)) break;
      if (APOS.includes(c) && isWordChar(s[a + 1])) {
        let k = a + 1;
        while (k < b && k - a < 8 && isWordChar(s[k])) k++;
        if (!isWordChar(s[k]) && LEAD_APOS.test(s.slice(a, k))) break;
      }
      if ('&%+@'.includes(c) && a + 1 === b) break;
      if ('$£€¥'.includes(c) && DIGIT.test(s[a + 1] || '')) break;
      pushPunct(c, s[a - 1]);
      a++;
    }
    // trailing punctuation, collected right to left
    const tail = [];
    while (b > a) {
      const c = s[b - 1];
      if (isWordChar(c)) break;
      if (c === '%' && DIGIT.test(s[b - 2] || '')) break;
      if ('&+@'.includes(c) && b - 1 === a) break;
      if (APOS.includes(c) && b - a > 2 && (s[b - 2] === 's' || (s[b - 2] === 'n' && s[b - 3] === 'i'))) break; // students', goin'
      if (c === '.' && LETTER.test(s[b - 2] || '') && DOTTED.test(s.slice(a, b - 1))) {
        if (b >= end) tail.push('.'); // U.S. at the very end also ends the sentence
        break;
      }
      tail.push(c);
      b--;
    }
    // the core, split again at hard punctuation inside it (word,word or word—word)
    const dotted = DOTTED.test(s.slice(a, b).replace(/\.$/, ''));
    let start = a;
    for (let k = a; k <= b; k++) {
      const c = s[k];
      const split = k === b || HARD.includes(c) || (c === '.' && !dotted && k + 1 < b && UPPER.test(s[k + 1]) && LETTER.test(s[k - 1] || ''));
      if (!split) continue;
      if (k > start) {
        const core = s.slice(start, k);
        tokens.push({ text: core, ws: '', kind: 'word', parts: parts(core.replace(/\.$/, '')) });
      }
      if (k < b) pushPunct(c, s[k - 1]);
      start = k + 1;
    }
    for (let k = tail.length - 1; k >= 0; k--) pushPunct(tail[k], k === tail.length - 1 ? s[b - 1] : tail[k + 1]);
  };

  let i = 0;
  while (i < end) {
    if (SPACE.test(s[i])) {
      if (tokens.length) tokens[tokens.length - 1].ws = ' ';
      i++;
      continue;
    }
    let j = i;
    while (j < end && !SPACE.test(s[j])) j++;
    chunk(i, j);
    i = j;
  }
  return tokens;
}
