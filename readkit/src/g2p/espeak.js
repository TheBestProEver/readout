// espeak-ng for words the lexicon doesn't know, and for Piper's IPA.
//
// espeak-ng is GPL-3.0, so it is never copied into readkit: phonemizer 1.2.1 (espeak-ng
// compiled to WASM, ~0.7 MB brotli) loads at runtime from config.phonemizer.
//
// phonemizer's only export, phonemize(), is async, but the WASM worker behind it is
// synchronous once it has started. g2p.kokoro() and g2p.ipa() are synchronous, so we
// load the same file with one extra line that exports that worker. If a different
// build doesn't match the pattern, we fall back to the async API (loadEspeak() then
// returns { sync: false } and callers must use phonemizeAsync).

import { config } from '../config.js';

const loading = new Map();

async function readSource(url) {
  if (url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return fs.readFile(url, 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load espeak-ng (${res.status})`);
  return res.text();
}

const IS_NODE = typeof process === 'object' && !!(process.versions && process.versions.node);

async function importSource(src) {
  // Node can't import blob: URLs; a data: URL works without touching the file system.
  if (IS_NODE) return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function open(href) {
  const url = new URL(href);
  const src = await readSource(url);
  // const ne=new Promise((e=>{A.calledRun?e(new A.eSpeakNGWorker):...
  const m = /\bconst ([\w$]+)=new Promise\(\(?[\w$]+\)?=>\{[\w$]+\.calledRun\?[\w$]+\(new [\w$]+\.eSpeakNGWorker\)/.exec(src);
  if (m) {
    const mod = await importSource(src + `\nexport const __readkitWorker = ${m[1]};\n`);
    const worker = await mod.__readkitWorker;
    let voice = '';
    return {
      sync: true,
      // One line per clause, punctuation dropped (espeak's own output).
      phonemize(text, lang) {
        if (lang !== voice) {
          worker.set_voice(lang);
          voice = lang;
        }
        const r = worker.synthesize_ipa(text);
        return r.code === 0 ? r.ipa.split('\n').filter((l) => l.length > 0) : [];
      },
    };
  }
  const mod = await import(url.href);
  return { sync: false, phonemizeAsync: (text, lang) => mod.phonemize(text, lang) };
}

export function loadEspeak(href = config.phonemizer) {
  if (!loading.has(href)) {
    const p = open(href);
    p.catch(() => loading.delete(href));
    loading.set(href, p);
  }
  return loading.get(href);
}
