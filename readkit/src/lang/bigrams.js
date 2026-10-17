// English word-pair counts for OCR correction context (data/lang/bigrams-en.txt,
// from SymSpell's 242k bigram list). Only the corrector loads this (2.2 MB).

import { config } from '../config.js';

const BASE = 6400000;

async function readList() {
  const url = new URL('lang/bigrams-en.txt', config.data);
  if (url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return fs.readFile(url, 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the word pairs (${res.status})`);
  return res.text();
}

export function parseBigrams(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.split(' ');
    const a = p[0];
    for (let i = 1; i + 1 < p.length; i += 2) map.set(a + ' ' + p[i], Math.round(BASE * Math.exp(Number(p[i + 1]) / 4)));
  }
  return { size: map.size, get: (a, b) => map.get(a + ' ' + b) || 0 };
}

let loading = null;
export function loadBigrams() {
  if (!loading) {
    loading = readList()
      .then(parseBigrams)
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}
