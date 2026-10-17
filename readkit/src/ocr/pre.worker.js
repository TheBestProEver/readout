// Image preprocessing off the main thread (needs OffscreenCanvas). Protocol:
//   { id, op: 'open', source: ImageBitmap | Blob, kind } -> { width, height, pieces }
//   { id, op: 'prep', piece, mode }                      -> { pgm, text (both transferred), w, h, scale, y0, info }
//   { id, op: 'close' }
import { createPrep } from './prep.js';

const prep = createPrep();

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    if (op === 'open') self.postMessage({ id, result: await prep.open(data.source, { kind: data.kind, owned: true }) });
    else if (op === 'prep') {
      const r = prep.prep(data.piece, data.mode);
      self.postMessage({ id, result: r }, [r.pgm.buffer, r.text.buffer]);
    } else if (op === 'close') {
      prep.close();
      self.postMessage({ id, result: true });
    } else throw new Error('unknown op ' + op);
  } catch (e) {
    self.postMessage({ id, error: (e && e.message) || String(e) });
  }
};
