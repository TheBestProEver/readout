// Pinned versions of everything readkit loads at runtime. Pinning keeps behaviour
// stable and lets service workers cache by URL. configure() overrides any of these:
// tests point them at local copies, and apps can self-host. tools/vendor.mjs copies the
// files an app needs into it (a Chrome extension may load no remote code) and writes a module
// that points these at the copies; a null URL marks a library as not there (its loader fails
// instead of reaching the network). See docs/chrome-extension.md.

const JSD = 'https://cdn.jsdelivr.net/npm/';
const HF = 'https://huggingface.co/';

export const config = {
  // pdf.js: legacy/build/pdf.min.mjs + pdf.worker.min.mjs, plus wasm/, cmaps/, standard_fonts/, iccs/
  pdfjs: JSD + 'pdfjs-dist@5.6.205/',
  tesseract: {
    script: JSD + 'tesseract.js@7.0.0/dist/tesseract.min.js',
    worker: JSD + 'tesseract.js@7.0.0/dist/worker.min.js',
    core: JSD + 'tesseract.js-core@7.0.0', // a directory: Tesseract picks the simd/relaxedsimd LSTM build
    lang: JSD + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  },
  // onnxruntime-web: ort.webgpu.min.mjs (Kokoro), ort.wasm.min.mjs (Piper), ort-wasm-simd-threaded*.wasm
  ort: JSD + 'onnxruntime-web@1.30.0/dist/',
  // espeak-ng builds (GPL-3.0): loaded at runtime only, never copied into this repo
  phonemizer: JSD + 'phonemizer@1.2.1/dist/phonemizer.js',
  piperPhonemize: JSD + '@diffusionstudio/piper-wasm@1.0.0/build/',
  defuddle: JSD + 'defuddle@0.19.5/dist/index.js',
  readability: JSD + '@mozilla/readability@0.6.0/Readability.js',
  // Subresource Integrity for the classic scripts readkit adds to the page (Defuddle,
  // Readability), by URL: the sha256 in tools/vendor-lock.json. A file changed on the CDN or on
  // the way is refused, not run with the app's origin (and its tokens). pdf.js, Tesseract and
  // the voice engines load as modules or inside workers, which this cannot cover: an app that
  // keeps secrets should self-host them (tools/vendor.mjs checks each file's sha256).
  integrity: {
    [JSD + 'defuddle@0.19.5/dist/index.js']: 'sha256-kRH1GiunKJwFhtALBCNK9G+yPatdt607g3thXtjS+SI=',
    [JSD + '@mozilla/readability@0.6.0/Readability.js']: 'sha256-NNyrPQgy0AGfApkO7WthJOAp6MMrnwxvJVBUT/jf8XQ=',
  },
  kokoro: {
    // The timestamped export adds a durations output, which gives word timings.
    base: HF + 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/',
    model: 'onnx/model.onnx',
    voices: 'voices/',
  },
  piper: HF + 'rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/',
  // How module workers start: 'auto' | 'blob' | 'url' (see src/worker.js)
  workerBootstrap: 'auto',
  // readkit's own data files (word lists, lexicons, rule tables)
  data: new URL('../data/', import.meta.url).href,
};

function merge(into, from) {
  for (const k of Object.keys(from)) {
    const v = from[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v);
    else into[k] = v;
  }
  return into;
}

export function configure(overrides) {
  return merge(config, overrides || {});
}
