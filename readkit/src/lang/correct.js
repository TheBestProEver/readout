// createCorrector({ dialect }): post-OCR correction in a worker. The model takes
// about 0.7 s to build and holds tens of MB, so make one per document and call
// dispose() when the OCR is done. Without module workers (Node, old browsers) the
// same code runs in-process.

import { config } from '../config.js';
import { loadWords } from './words.js';
import { loadBigrams } from './bigrams.js';
import { makeModel, correctWords, correctText } from './corrector.js';
import { moduleWorker } from '../worker.js';

const pick = (o) => (o && typeof o === 'object' ? { ...o } : undefined);

function inline(dialect) {
  let model = Promise.all([loadWords(), loadBigrams()]).then(([words, bigrams]) => makeModel({ words, bigrams, dialect }));
  const need = async () => {
    if (!model) throw new Error('The corrector was disposed');
    return model;
  };
  return model.then(() => ({
    async correctWords(words, options) {
      return correctWords(await need(), words, options);
    },
    async correctText(text, options) {
      return correctText(await need(), text, options);
    },
    dispose() {
      model = null;
    },
  }));
}

function inWorker(dialect) {
  const worker = moduleWorker(new URL('./correct.worker.js', import.meta.url));
  const pending = new Map();
  let seq = 0;
  let dead = null;
  const fail = (err) => {
    if (dead) return;
    dead = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker.terminate();
  };
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result);
  };
  worker.onerror = (ev) => {
    ev.preventDefault();
    fail(new Error('The corrector failed to load' + (ev.message ? ': ' + ev.message : '')));
  };
  const call = (op, args) =>
    dead
      ? Promise.reject(dead)
      : new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, op, args });
        });
  // Workers have their own copy of config, so send ours (tests and self-hosting change it).
  const cfg = JSON.parse(JSON.stringify(config));
  return call('init', { config: cfg, dialect }).then(() => ({
    async correctWords(words, options) {
      const slim = words.map((w) => ({ text: w.text, conf: w.conf, line: w.line }));
      const r = await call('words', { words: slim, options: pick(options) });
      return {
        words: words.map((w, i) => {
          const [text, conf, changed, dropped, merged] = r.words[i];
          const out = { ...w, text, conf, changed, dropped };
          if (merged) out.merged = true;
          return out;
        }),
        dropped: r.dropped,
      };
    },
    correctText(text, options) {
      return call('text', { text: String(text == null ? '' : text), options: pick(options) });
    },
    dispose() {
      fail(new Error('The corrector was disposed'));
    },
  }));
}

export async function createCorrector({ dialect = 'en-US', worker = true } = {}) {
  if (worker && typeof Worker !== 'undefined') {
    try {
      return await inWorker(dialect);
    } catch (e) {
      // A worker that can't load (blocked module workers, CSP) falls back to in-process.
      console.warn('readkit: correcting OCR on the main thread', e);
    }
  }
  return inline(dialect);
}
