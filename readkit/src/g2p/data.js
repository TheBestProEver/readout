// Loads g2p data files from config.data + 'g2p/': fetch in the browser, fs in Node.
// Each file is read once per URL and shared by every createG2P() call.

import { config } from '../config.js';

const cache = new Map();

async function readText(url) {
  if (url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return fs.readFile(url, 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url.pathname.split('/').pop()} (${res.status})`);
  return res.text();
}

export function loadData(name, parse = JSON.parse) {
  const url = new URL('g2p/' + name, config.data);
  const key = url.href;
  if (!cache.has(key)) {
    const p = readText(url).then(parse);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}
