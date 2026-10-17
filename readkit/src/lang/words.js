// The shared English word list: about 95,000 words with corpus frequencies, covering
// both American and British spellings. Used to score PDF text layers, to check
// de-hyphenation, and by the OCR corrector.

import { config } from '../config.js';

let loading = null;

async function readList() {
  const url = new URL('lang/words-en.txt', config.data);
  if (url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return fs.readFile(url, 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the word list (${res.status})`);
  return res.text();
}

// Parsed in slices of about 6 ms, giving the thread back in between: in one go it was a
// 30-55 ms task on the main thread (pdf/ and formats/ load the list there), long enough to
// make a page stutter.
const SLICE_MS = 6;
const yieldNow = () =>
  typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function' ? scheduler.yield() : new Promise((r) => setTimeout(r, 0));

async function parse(text) {
  const freq = new Map();
  const n = text.length;
  let i = 0;
  let t0 = performance.now();
  while (i < n) {
    // a few hundred lines between clock reads
    for (let k = 0; k < 512 && i < n; k++) {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      const sp = text.indexOf(' ', i);
      if (sp > i && sp < e) freq.set(text.slice(i, sp), Number(text.slice(sp + 1, e)) || 1);
      i = e + 1;
    }
    if (i < n && performance.now() - t0 > SLICE_MS) {
      await yieldNow();
      t0 = performance.now();
    }
  }
  return freq;
}

// Words are matched lowercase, with curly apostrophes treated as straight ones.
export function wordKey(word) {
  return String(word).toLowerCase().replace(/[’‘]/g, "'");
}

export function loadWords() {
  if (!loading) {
    loading = readList()
      .then(parse)
      .then((freq) => {
        return {
          size: freq.size,
          has: (w) => freq.has(wordKey(w)),
          freq: (w) => freq.get(wordKey(w)) || 0,
          entries: () => freq.entries(),
        };
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}
