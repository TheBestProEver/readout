// Loads pdf.js (legacy build: it also runs on older Chrome) from config.pdfjs, once
// per base URL. The worker is a module worker; pdf.js wraps a cross-origin workerSrc
// in a same-origin blob itself.

import { config } from '../config.js';

const loaded = new Map();

export function loadPdfjs(base = config.pdfjs) {
  if (!loaded.has(base)) {
    const p = import(base + 'legacy/build/pdf.min.mjs')
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = base + 'legacy/build/pdf.worker.min.mjs';
        return lib;
      })
      .catch((e) => {
        loaded.delete(base);
        throw new Error(`Couldn't load the PDF reader (${(e && e.message) || e})`);
      });
    loaded.set(base, p);
  }
  return loaded.get(base);
}

// getDocument options. The wasm decoders (JPEG 2000, JBIG2, colour profiles), packed
// CMaps and standard fonts make scanned and CJK-font pages render correctly; they do
// not fix garbage text (that needs OCR).
export function documentOptions(base = config.pdfjs) {
  return {
    wasmUrl: base + 'wasm/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    iccUrl: base + 'iccs/',
    isEvalSupported: false,
    verbosity: 0,
  };
}
