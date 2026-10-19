// extract(input, opts) -> Doc. Any input (File, Blob, bytes or a plain string) becomes the
// same Doc: an id (sha256 of the bytes), a title, blocks, warnings and stats (DESIGN.md).
// The type comes from the bytes (sniff.js), never from the name alone. PDFs go to src/pdf,
// pictures to src/ocr, everything else to the readers in src/formats, which load on demand.
//
// Files that can't be read on purpose (old .doc/.ppt, Pages/Keynote, DRM books, spreadsheets,
// archives, empty files) give a Doc with no blocks and a warning saying why and what to do.
// Damaged files and unexpected failures throw an Error whose .user is a sentence for the app
// to show. Aborting (opts.signal) throws the signal's reason (an AbortError).

import { makeDoc, textToBlocksAsync, countWords, markReferences } from './doc.js';
import { sniff, zipKind, textKind } from './sniff.js';
import { makePause, throwIfAborted, userError, toBytes, baseName, extOf } from './formats/util.js';
import { sha256Hex } from './formats/sha256.js';

const HEAD = 65536;
const SUBTLE_MAX = 256 * 1024 * 1024; // larger Blobs are hashed in slices (slowly, in JS) rather than loaded whole
const IMAGE_OCR_MAX = 60; // pictures OCR'd in a document that has no text of its own
const READABLE_IMAGE = /\.(?:png|jpe?g|jfif|gif|bmp|webp|avif)$/i;
const INNER_DOC = /\.(?:pdf|docx|docm|epub|odt|odp|pptx|rtf|txt|text|md|markdown|html?|xhtml|mhtml?)$/i;

const READERS = {
  docx: () => import('./formats/docx.js'),
  pptx: () => import('./formats/pptx.js'),
  odf: () => import('./formats/odf.js'),
  epub: () => import('./formats/epub.js'),
  rtf: () => import('./formats/rtf.js'),
  markdown: () => import('./formats/markdown.js'),
  html: () => import('./formats/html.js'),
  zip: () => import('./formats/zip.js'),
  text: () => import('./formats/text.js'),
};
const LOADERS = {
  pdf: () => import('./pdf/pdf.js'),
  ocr: () => import('./ocr/ocr.js'),
  words: () => import('./lang/words.js'),
};

const EXPORT_HINT = 'save it as PDF or Word (.docx) and open that';
const REFUSE = {
  doc: `This is an old Word document (.doc), which can’t be read here. Open it in Word, Google Docs or LibreOffice, ${EXPORT_HINT}.`,
  ppt: 'This is an old PowerPoint file (.ppt), which can’t be read here. Open it in PowerPoint, Google Slides or LibreOffice, save it as PDF or .pptx and open that.',
  xls: 'Spreadsheets can’t be read aloud here. Save the sheet as PDF to listen to it.',
  xlsx: 'Spreadsheets can’t be read aloud here. Save the sheet as PDF to listen to it.',
  ods: 'Spreadsheets can’t be read aloud here. Save the sheet as PDF to listen to it.',
  numbers: 'Spreadsheets can’t be read aloud here. In Numbers, choose File > Export To > PDF and open that.',
  pages: 'This is an Apple Pages document, which can’t be read here. In Pages, choose File > Export To > PDF or Word, then open that file.',
  keynote: 'This is an Apple Keynote presentation, which can’t be read here. In Keynote, choose File > Export To > PDF or PowerPoint, then open that file.',
  encrypted: 'This file is password-protected, so it can’t be read. Remove the password (in Word: File > Info > Protect Document) and try again.',
  mobi: 'Kindle books (.mobi, .azw) can’t be read here. A DRM-free EPUB or PDF copy will work.',
  xps: 'XPS documents can’t be read here. Print the document to PDF and open that.',
  djvu: 'DjVu files can’t be read here. Convert the file to PDF and open that.',
  ps: 'PostScript files can’t be read here. Convert the file to PDF and open that.',
  archive: 'This is a compressed archive. Unpack it and open the document inside.',
  audio: 'This is an audio file, not a document.',
  video: 'This is a video file, not a document.',
  binary: 'This kind of file can’t be read. Readable files are PDF, Word (.docx), EPUB, PowerPoint (.pptx), OpenDocument, RTF, web pages, Markdown, plain text and pictures.',
  empty: 'This file is empty.',
};

/* ---------- small helpers ---------- */

function isBlob(x) {
  return typeof Blob !== 'undefined' && x instanceof Blob;
}

async function readHead(src) {
  if (!isBlob(src)) return src.subarray(0, Math.min(src.length, HEAD));
  return new Uint8Array(await src.slice(0, HEAD).arrayBuffer());
}

// The whole input as bytes, read at most once (the id and the PDF reader share them).
function bytesOnce(src) {
  let p = null;
  return () => p || (p = isBlob(src) ? src.arrayBuffer().then((b) => new Uint8Array(b)) : Promise.resolve(src));
}

async function hashOf(src, getBytes, pause) {
  try {
    if (!isBlob(src) || src.size <= SUBTLE_MAX) return await sha256Hex(await getBytes(), pause);
    return await sha256Hex(src, pause);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return '';
  }
}

// "my_trip-notes.v2.docx" -> "my trip-notes.v2"
function titleFromName(name) {
  let t = baseName(name).replace(/\.[a-z0-9]{1,8}$/i, '');
  if (!/\s/.test(t) && /[_]/.test(t)) t = t.replace(/_+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 150 ? t.slice(0, 150).trim() : t;
}

function firstWords(text, n) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  let t = words.slice(0, n).join(' ');
  if (words.length > n) t = t.replace(/[,;:.!?-]+$/, '') + '…';
  return t.replace(/[,;:]+$/, '');
}

// Phone scanning apps name every file after themselves: "Adobe Scan Oct 16, 2026", "CamScanner 10-16-2026 09.30".
const SCAN_APP = /^(?:camscanner|adobe scan|genius scan|office lens|microsoft lens|tiny ?scanner|scanbot|swiftscan|clear ?scan|simple ?scan|notes scan)\b/i;

// Names cameras, phones and scanners make up: "IMG_20261016_093012.jpg", "Screenshot_2026...", "scan0001.pdf".
export function autoName(name) {
  const t = baseName(name).replace(/\.[a-z0-9]{1,8}$/i, '');
  if (SCAN_APP.test(t)) return true;
  return !t || /^(?:img|image|pxl|dsc[nf]?|dcim|photo|picture|screenshot|screen shot|scan|scanned|cam|mvimg|wp|whatsapp image|signal|document|doc|file|download|untitled|unknown)[-_ ]*(?:\d|\(|$)/i.test(t) || /^[\d_ .:()-]{6,}$/.test(t) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t);
}

// The title: metadata, else the first heading near the start, else the file name, else the opening words.
function chooseTitle(meta, blocks, name) {
  let m = String(meta || '').replace(/\s+/g, ' ').trim();
  if (m && autoName(m)) m = ''; // a scanner's "scan0001" or "CamScanner 10-16-2026" in the metadata
  if (!/\s/.test(m) && /_/.test(m)) m = m.replace(/_+/g, ' ').trim(); // "What_is_The_Plan"
  if (m) return m;
  // Not the "Notes" heading readers put before the notes, nor a bare "Slide 3".
  const start = blocks.slice(0, 12);
  const h = start.find((b, i) => !b.skip && /^h[1-3]$/.test(b.type) && b.text.length <= 150 && !/^slide \d+$/i.test(b.text) && !(blocks[i + 1] && blocks[i + 1].type === 'note'));
  if (h) return h.text.replace(/^slide \d+: /i, '').replace(/\n/g, ' ');
  const fromName = autoName(name) ? '' : titleFromName(name);
  if (fromName) return fromName;
  const first = blocks.find((b) => !b.skip && b.text);
  return first ? firstWords(first.text.split('\n')[0], 8) : '';
}

function warning(type, text, page) {
  return { type, page: page > 0 ? page : null, text };
}

function normalizeWarnings(list) {
  return (list || []).filter(Boolean).map((w) => ({ type: w.type || 'unsupported', page: w.page > 0 ? w.page : null, text: String(w.text || '') }));
}

// A reader's failure becomes an error the app can show. Our own user-facing errors and aborts pass through.
function failure(e, name) {
  if (e && (e.user || e.name === 'AbortError')) return e;
  const label = name ? `“${baseName(name)}”` : 'this file';
  const err = userError(`Couldn’t read ${label}. The file may be damaged or incomplete.`, 'corrupt', e);
  return err;
}

/* ---------- pictures inside documents that have no text ---------- */

// A Word or OpenDocument file that is only a scan pasted in: read the pictures with OCR.
async function ocrPictures(zip, images, ctx) {
  const { opts, load, warnings, pause } = ctx;
  const all = images.filter((p) => READABLE_IMAGE.test(p.path) && zip.has(p.path));
  const usable = all.slice(0, IMAGE_OCR_MAX);
  if (all.length > usable.length) warnings.push(warning('truncated', `Only the first ${usable.length} of the ${all.length} pictures were read.`));
  if (!usable.length) {
    if (images.length) warnings.push(warning('unsupported', 'This document only contains pictures, in a format that can’t be read here. Save it as PDF and open that.'));
    return null;
  }
  if (opts.ocr === 'never') {
    warnings.push(warning('ocr-unavailable', 'This document only contains pictures of text, and reading pictures is turned off.'));
    return null;
  }
  if (opts.allowOcr) {
    const mod = await load.ocr();
    const ok = await opts.allowOcr({ pages: usable.length, bytes: mod.OCR_BYTES || 7e6 });
    if (!ok) {
      warnings.push(warning('ocr-unavailable', 'This document only contains pictures of text, and reading pictures was declined.'));
      return null;
    }
  }
  const { ocrImage, createOcr } = await load.ocr();
  // One OCR engine for every picture; ocrImage would otherwise start and stop one each time.
  let shared = null;
  const make = opts.createOcr || createOcr;
  const engine = async (o) => {
    if (!shared) shared = await make(o);
    return { recognize: (img, ro) => shared.recognize(img, ro), terminate: () => {} };
  };
  const blocks = [];
  const stats = { ocrPages: 0, lowConfidenceWords: 0, droppedTokens: 0 };
  try {
    for (let k = 0; k < usable.length; k++) {
      throwIfAborted(opts.signal);
      if (opts.onProgress) opts.onProgress({ stage: 'ocr', done: k, total: usable.length, message: `Reading picture ${k + 1} of ${usable.length}` });
      const bytes = await zip.bytes(usable[k].path);
      if (!bytes || !bytes.length) continue;
      const blob = new Blob([bytes], { type: mimeOfImage(usable[k].path) });
      const r = await ocrImage(blob, { dialect: opts.dialect, signal: opts.signal, createOcr: engine, createCorrector: opts.createCorrector, name: 'picture' });
      const page = usable[k].page || k + 1;
      for (const b of r.blocks || []) {
        b.page = page;
        blocks.push(b);
      }
      for (const w of r.warnings || []) if (w.type !== 'ocr-low-confidence' || (r.blocks || []).length) warnings.push(warning(w.type, w.text, page));
      if (r.stats) {
        stats.ocrPages += r.stats.ocrPages || 0;
        stats.lowConfidenceWords += r.stats.lowConfidenceWords || 0;
        stats.droppedTokens += r.stats.droppedTokens || 0;
      }
      await pause();
    }
  } finally {
    if (shared) shared.terminate();
  }
  if (!blocks.length) warnings.push(warning('ocr-low-confidence', 'No text was found in this document’s pictures.'));
  return { blocks, stats };
}

function mimeOfImage(path) {
  const e = extOf(path);
  if (e === 'jpg' || e === 'jpeg' || e === 'jfif') return 'image/jpeg';
  return 'image/' + e;
}

/* ---------- SVG drawings ---------- */

// The text elements of an SVG, one per line, in document order ('' without a DOM).
function svgText(xml) {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length) return '';
  const lines = [];
  for (const t of doc.getElementsByTagName('text')) {
    const s = t.textContent.replace(/\s+/g, ' ').trim();
    if (s) lines.push(s);
  }
  return lines.join('\n');
}

// Renders an SVG to a PNG for OCR (main thread only; null when that isn't possible).
async function svgToPng(blob) {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1600;
    const h = img.naturalHeight || 1200;
    const scale = Math.min(4, Math.max(1, 2000 / Math.max(w, h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob(r, 'image/png'));
  } catch (e) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- the readers ---------- */

async function readZipDoc(kind, zip, ctx) {
  const { opts, pause } = ctx;
  const rctx = { pause, onProgress: opts.onProgress, images: [] };
  let r;
  if (kind === 'docx') r = await (await READERS.docx()).readDocx(zip, rctx);
  else if (kind === 'pptx') r = await (await READERS.pptx()).readPptx(zip, rctx);
  else if (kind === 'odt' || kind === 'odp' || kind === 'odg') r = await (await READERS.odf()).readOdf(zip, rctx);
  else if (kind === 'epub') {
    rctx.onBlocks = (blocks) => ctx.stream(blocks);
    r = await (await READERS.epub()).readEpub(zip, rctx);
  }
  r.images = r.images || rctx.images;
  if (zip.truncated || zip.recovered) ctx.warnings.push(warning('truncated', 'This file seems to be incomplete, so the end of it may be missing.'));
  return r;
}

async function readTextDoc(kind, bytes, ctx) {
  const { opts, pause } = ctx;
  const { decodeText, declaredCharset } = await READERS.text();
  if (kind === 'rtf') return (await READERS.rtf()).readRtf(bytes, { pause });
  if (kind === 'mhtml' || kind === 'eml') return (await READERS.html()).readMimeDoc(bytes, { pause, url: opts.url });
  if (kind === 'html') {
    const text = decodeText(bytes, { charset: declaredCharset(bytes) }).text;
    return (await READERS.html()).readHtml(text, { pause, url: opts.url, layout: !!opts.layout });
  }
  if (kind === 'odt' || kind === 'odp') {
    // Flat OpenDocument XML (.fodt, .fodp)
    const text = decodeText(bytes, { charset: declaredCharset(bytes) }).text;
    return (await READERS.odf()).readOdf(text, { pause });
  }
  const text = decodeText(bytes).text;
  if (kind === 'markdown') return (await READERS.markdown()).readMarkdown(text, { pause });
  return readPlain(text, ctx);
}

// Words hyphenated at a line wrap are rejoined only when the dictionary knows the whole word.
async function readPlain(text, ctx) {
  let words = null;
  if (/\p{L}-[ \t]*\r?\n[ \t]*\p{Ll}/u.test(text)) {
    try {
      words = await (await ctx.load.words()).loadWords();
    } catch (e) {
      words = null;
    }
  }
  return { title: '', blocks: await textToBlocksAsync(text, { words, source: 'text' }, ctx.pause), warnings: [], plain: text };
}

/* ---------- extract ---------- */

/**
 * input: File | Blob | ArrayBuffer | Uint8Array | string (plain text; Markdown and HTML are
 * recognised). opts: { name, ocr: 'auto'|'always'|'never', dialect, allowOcr, signal,
 * onProgress, onBlock, url (for saved web pages), layout (also give doc.layout: lines with
 * their boxes, rows, tables and label/value pairs; see src/layout/layout.js) }.
 */
export async function extract(input, opts) {
  const o = Object.assign({ ocr: 'auto', dialect: 'en-US' }, opts);
  const signal = o.signal || null;
  throwIfAborted(signal);
  const pause = makePause(signal, 8);
  const load = Object.assign({}, LOADERS, o.load);
  const warnings = [];
  const blocks = [];
  let streamed = 0;
  // Blocks reach onBlock in order, exactly as they end up in doc.blocks.
  const stream = (list) => {
    for (const b of list) {
      blocks.push(b);
      streamed++;
      if (o.onBlock) {
        try {
          o.onBlock(b);
        } catch (e) {
          /* the app's callback must not break extraction */
        }
      }
    }
  };
  const ctx = { opts: o, load, pause, warnings, stream };
  // what the layout is built from: { pages } (PDFs, pictures), { text } (plain text), else the blocks
  let layoutSrc = {};
  const progress = (stage, done, total, message) => {
    if (o.onProgress) o.onProgress({ stage, done, total, message });
  };

  let src;
  let name = o.name || '';
  let plain = null;
  if (typeof input === 'string') {
    plain = input;
    src = new TextEncoder().encode(input);
  } else if (isBlob(input)) {
    src = input;
    if (!name && input.name) name = input.name;
  } else {
    src = toBytes(input);
    if (!src) throw new TypeError('extract() needs a File, Blob, ArrayBuffer, Uint8Array or string');
  }
  const size = isBlob(src) ? src.size : src.length;
  const getBytes = bytesOnce(src);
  const idP = hashOf(src, getBytes, pause);
  idP.catch(() => {});

  const finish = async (fields) => {
    const stats = Object.assign({}, fields.stats);
    if (typeof stats.words !== 'number') {
      // counted in slices, so a long book never holds the page
      stats.words = 0;
      for (let i = 0; i < blocks.length; i++) {
        if (!blocks[i].skip) stats.words += countWords(blocks[i].text);
        if (i % 500 === 499) await pause();
      }
    }
    const id = await idP;
    throwIfAborted(signal);
    const doc = makeDoc({ id, kind: fields.kind, title: chooseTitle(fields.title, blocks, name), blocks, warnings: normalizeWarnings(warnings), stats });
    if (o.layout) {
      const { layoutOf } = await import('./layout/layout.js');
      doc.layout = layoutOf(doc, layoutSrc);
    }
    progress('done', 1, 1, '');
    return doc;
  };
  const refuse = (kind, text, type = 'unsupported') => {
    warnings.push(warning(type, text));
    return finish({ kind, title: '', stats: { pages: 0 } });
  };

  progress('read', 0, 1, 'Opening the file');
  try {
    if (!size) return await refuse('text', REFUSE.empty);

    // Plain strings: text, or Markdown/HTML when they clearly are.
    if (plain != null) {
      let kind = textKind(plain.slice(0, HEAD), extOf(name)).kind;
      if (kind !== 'html' && kind !== 'markdown') kind = 'text';
      const r = await readTextDoc(kind, src, ctx);
      stream(markReferences(r.blocks));
      warnings.push(...(r.warnings || []));
      if (kind === 'text') layoutSrc = { text: plain };
      // (a web page's dates and addresses the article left out: as for a file)
      if (r.layoutBlocks) layoutSrc = { blocks: r.layoutBlocks };
      if (r.layoutHtml != null) layoutSrc.html = r.layoutHtml;
      return await finish({ kind, title: r.title, stats: { pages: 0 } });
    }

    const head = await readHead(src);
    throwIfAborted(signal);
    let { kind } = sniff(head, name);
    let zip = null;
    if (head[0] === 0x50 && head[1] === 0x4b) {
      // A ZIP: its whole directory says what is inside (sniff only saw the first entries).
      const { openZip } = await READERS.zip();
      zip = await openZip(src);
      let mimetype = '';
      if (zip.has('mimetype')) {
        try {
          mimetype = String((await zip.text('mimetype')) || '').slice(0, 200);
        } catch (e) {
          mimetype = '';
        }
      }
      kind = zipKind(zip.names, mimetype, name).kind;
    }
    throwIfAborted(signal);

    if (kind === 'pdf') {
      const bytes = await getBytes();
      const { extractPdf } = await load.pdf();
      const r = await extractPdf(bytes, {
        ocr: o.ocr,
        dialect: o.dialect,
        allowOcr: o.allowOcr,
        signal,
        onProgress: o.onProgress,
        createOcr: o.createOcr,
        createCorrector: o.createCorrector,
        onBlock: (b) => stream([b]),
        layout: !!o.layout,
      });
      if (r.layout) layoutSrc = { pages: r.layout.pages };
      // A PDF that pdf.js can't open at all is damaged, like a broken ZIP: an error, not an
      // empty Doc. (Password-protected PDFs come back as a Doc with a 'drm' warning.)
      if (!(r.blocks || []).length && !(r.stats && r.stats.pages) && (r.warnings || []).some((w) => w.type === 'unsupported')) throw failure(null, name);
      // extractPdf streams its blocks; any it returned without streaming follow.
      stream((r.blocks || []).slice(streamed));
      warnings.push(...(r.warnings || []));
      return await finish({ kind: 'pdf', title: r.title, stats: r.stats });
    }

    if (kind === 'image') {
      const mime = sniff(head, name).mime;
      if (mime === 'image/svg+xml') {
        // A drawing with real text in it is read directly; one without is rendered and OCR'd.
        const t = svgText(new TextDecoder().decode(await getBytes()));
        if (countWords(t, 3) >= 3) {
          stream(await textToBlocksAsync(t, { source: 'markup' }, pause));
          return await finish({ kind: 'image', title: '', stats: { pages: 1 } });
        }
      }
      if (o.ocr === 'never') return await refuse('image', 'This is a picture. Reading text in pictures is turned off.', 'ocr-unavailable');
      let blob = isBlob(src) ? src : new Blob([src], { type: mime });
      if (mime === 'image/svg+xml') blob = (await svgToPng(blob)) || blob;
      const { ocrImage } = await load.ocr();
      // ocrImage titles a picture by the name it is given; a camera's "IMG_2041" is no title.
      const meaningful = name && !autoName(name) ? name : '';
      const r = await ocrImage(blob, { dialect: o.dialect, allowOcr: o.allowOcr, signal, onProgress: o.onProgress, name: meaningful, createOcr: o.createOcr, createCorrector: o.createCorrector, layout: !!o.layout });
      if (r.layout) layoutSrc = { pages: r.layout.pages };
      stream(r.blocks || []);
      warnings.push(...(r.warnings || []));
      // A meaningful file name beats the opening words of the OCR'd text, which beat "Picture".
      const title = meaningful ? titleFromName(meaningful) : blocks.length ? '' : r.title || 'Picture';
      return await finish({ kind: 'image', title, stats: r.stats });
    }

    if (zip && /^(?:docx|pptx|odt|odp|odg|epub)$/.test(kind)) {
      progress('parse', 0, 1, 'Reading the document');
      const r = await readZipDoc(kind, zip, ctx);
      warnings.push(...(r.warnings || []));
      if (r.refused) return await finish({ kind, title: r.title, stats: { pages: 0 } });
      // The EPUB reader streamed chapter by chapter; the others hand over everything at the end.
      if (kind !== 'epub') stream(kind === 'pptx' || kind === 'odp' ? r.blocks : markReferences(r.blocks));
      const stats = { pages: r.pages || 0 };
      const docKind = kind === 'odg' ? 'odp' : r.kind || kind;
      let few = 0;
      for (let i = 0; i < blocks.length && few < 5; i++) few += countWords(blocks[i].text, 5 - few);
      if (r.images && r.images.length && few < 5) {
        const got = await ocrPictures(zip, r.images, ctx);
        if (got) {
          stream(got.blocks);
          Object.assign(stats, got.stats);
        }
      }
      if (!blocks.length && !warnings.length) warnings.push(warning('unsupported', 'No text was found in this document.'));
      return await finish({ kind: docKind, title: r.title, stats });
    }

    if (zip && kind === 'archive' && !o.nested) {
      // A .zip holding one document (Google Docs' zipped web page, a mailed attachment): read that.
      const docs = zip.names.filter((n) => !/(?:^|\/)(?:__MACOSX|\.)/.test(n) && INNER_DOC.test(n));
      if (docs.length === 1) {
        const bytes = await zip.bytes(docs[0]);
        const inner = await extract(bytes, Object.assign({}, o, { name: baseName(docs[0]), nested: true, onBlock: (b) => stream([b]) }));
        warnings.push(...inner.warnings);
        const id = await idP;
        return Object.assign(inner, { id, blocks, warnings: normalizeWarnings(warnings) });
      }
    }
    if (REFUSE[kind]) return await refuse(kind, REFUSE[kind]);
    if (zip) return await refuse('archive', REFUSE.archive);

    if (/^(?:rtf|html|mhtml|eml|markdown|text|odt|odp)$/.test(kind)) {
      progress('parse', 0, 1, 'Reading the document');
      const bytes = await getBytes();
      const r = await readTextDoc(kind, bytes, ctx);
      stream(markReferences(r.blocks));
      warnings.push(...(r.warnings || []));
      if (r.plain != null) layoutSrc = { text: r.plain };
      if (r.layoutBlocks) layoutSrc = { blocks: r.layoutBlocks };
      if (r.layoutHtml != null) layoutSrc.html = r.layoutHtml;
      const docKind = kind === 'mhtml' || kind === 'eml' ? r.kind || 'html' : kind;
      if (!blocks.length && !warnings.length) warnings.push(warning('unsupported', 'No text was found in this file.'));
      return await finish({ kind: docKind, title: r.title, stats: { pages: r.pages || 0 } });
    }
    return await refuse(kind, REFUSE.binary);
  } catch (e) {
    throw failure(e, name);
  }
}
