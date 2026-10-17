// Holds the correction model (word list, delete index, bigrams) off the main
// thread. Closed by the corrector's dispose(), which frees it all at once.
import { configure } from '../config.js';
import { loadWords } from './words.js';
import { loadBigrams } from './bigrams.js';
import { makeModel, correctWords, correctText } from './corrector.js';

let model = null;

self.onmessage = async ({ data }) => {
  const { id, op, args } = data;
  try {
    let result;
    if (op === 'init') {
      configure(args.config);
      const [words, bigrams] = await Promise.all([loadWords(), loadBigrams()]);
      model = makeModel({ words, bigrams, dialect: args.dialect });
      result = true;
    } else if (op === 'words') {
      const out = correctWords(model, args.words, args.options);
      result = { words: out.words.map((w) => [w.text, w.conf, w.changed, w.dropped, !!w.merged]), dropped: out.dropped };
    } else if (op === 'text') {
      result = correctText(model, args.text, args.options);
    } else throw new Error('unknown op ' + op);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || String(e) });
  }
};
