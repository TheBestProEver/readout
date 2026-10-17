// What kind of file is this? Decided by its bytes (magic numbers, then content), never by
// the file name alone; the name only breaks ties (Markdown vs plain text, a .doc vs a .xls).
//
// sniff(bytes, name) -> { kind, mime }
//   bytes: Uint8Array | ArrayBuffer, the whole file or at least its first 64 KB (with only
//   the start of a ZIP, the inner type comes from its first entries and the name).
//
// Readable kinds: 'pdf' 'image' 'docx' 'odt' 'pptx' 'odp' 'epub' 'rtf' 'html' 'mhtml' 'eml'
//   'markdown' 'text'
// Refused kinds: 'doc' 'ppt' 'xls' 'xlsx' 'ods' 'odg' 'pages' 'keynote' 'numbers' 'encrypted'
//   'mobi' 'xps' 'djvu' 'ps' 'archive' 'audio' 'video' 'binary' 'empty'

import { zipListing } from './formats/zip.js';
import { looksBinary, bomEncoding, guessUtf16, decodeText } from './formats/text.js';
import { looksLikeMarkdown } from './formats/markdown.js';
import { mimeKind } from './formats/mime.js';
import { extOf, latin1, toBytes } from './formats/util.js';

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odg: 'application/vnd.oasis.opendocument.graphics',
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  html: 'text/html',
  mhtml: 'multipart/related',
  eml: 'message/rfc822',
  markdown: 'text/markdown',
  text: 'text/plain',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
  xls: 'application/vnd.ms-excel',
  encrypted: 'application/x-ole-storage',
  pages: 'application/vnd.apple.pages',
  keynote: 'application/vnd.apple.keynote',
  numbers: 'application/vnd.apple.numbers',
  mobi: 'application/x-mobipocket-ebook',
  xps: 'application/oxps',
  djvu: 'image/vnd.djvu',
  ps: 'application/postscript',
  archive: 'application/zip',
  binary: 'application/octet-stream',
  empty: 'application/octet-stream',
};

const out = (kind, mime) => ({ kind, mime: mime || MIME[kind] || 'application/octet-stream' });

function startsWith(u8, sig, at = 0) {
  if (u8.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (sig[i] !== null && u8[at + i] !== sig[i]) return false;
  return true;
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// Byte position of a UTF-16LE name (OLE2 directory entries), or -1.
function findUtf16(u8, name) {
  const first = name.charCodeAt(0);
  for (let i = u8.indexOf(first); i >= 0 && i + name.length * 2 <= u8.length; i = u8.indexOf(first, i + 1)) {
    let ok = u8[i + 1] === 0;
    for (let k = 1; ok && k < name.length; k++) ok = u8[i + 2 * k] === name.charCodeAt(k) && u8[i + 2 * k + 1] === 0;
    if (ok) return i;
  }
  return -1;
}

function oleKind(u8, ext) {
  // Password-protected Word/PowerPoint files are OLE containers holding an EncryptedPackage.
  if (findUtf16(u8, 'EncryptedPackage') >= 0) return out('encrypted');
  if (findUtf16(u8, 'WordDocument') >= 0) return out('doc');
  if (findUtf16(u8, 'PowerPoint Document') >= 0) return out('ppt');
  if (findUtf16(u8, 'Workbook') >= 0 || findUtf16(u8, 'Book') >= 0) return out('xls');
  if (/^(?:doc|dot|wps)$/.test(ext)) return out('doc');
  if (/^(?:ppt|pps|pot)$/.test(ext)) return out('ppt');
  if (/^(?:xls|xlt)$/.test(ext)) return out('xls');
  return out('binary', 'application/x-ole-storage');
}

// Inner type of a ZIP container from its entry names and its stored 'mimetype' entry.
export function zipKind(names, mimetype, name) {
  const ext = extOf(name);
  const has = (n) => names.includes(n);
  const prefix = (p) => names.some((n) => n.startsWith(p));
  const mt = String(mimetype || '').trim();
  if (mt === 'application/epub+zip') return out('epub');
  if (mt.startsWith('application/vnd.oasis.opendocument.')) {
    const sub = mt.slice(35);
    if (/^text/.test(sub)) return out('odt', mt);
    if (/^presentation/.test(sub)) return out('odp', mt);
    if (/^spreadsheet/.test(sub)) return out('ods', mt);
    return out('odg', mt);
  }
  if (prefix('word/')) return out('docx');
  if (prefix('ppt/')) return out('pptx');
  if (prefix('xl/')) return out('xlsx');
  if (has('META-INF/container.xml') || names.some((n) => /\.opf$/i.test(n))) return out('epub');
  if (names.some((n) => /^Index\/.*\.iwa$/.test(n)) || has('Index.zip') || has('index.apxl') || has('index.xml') || has('Metadata/DocumentIdentifier')) {
    if (ext === 'key' || names.some((n) => /^Index\/Slide/.test(n)) || has('index.apxl')) return out('keynote');
    if (ext === 'numbers' || names.some((n) => /^Index\/(?:Tables|CalculationEngine)/.test(n))) return out('numbers');
    return out('pages');
  }
  if (names.some((n) => /^(?:FixedDocSeq|FixedDocumentSequence)\.fdseq$/i.test(n) || /^Documents\/\d+\/FixedDoc(?:ument)?\.fdoc$/i.test(n))) return out('xps');
  if (has('content.xml') && has('META-INF/manifest.xml')) return out(ext === 'odp' ? 'odp' : 'odt');
  // Only the start of the archive was given: trust a document extension.
  if (/^(?:docx|docm|dotx|dotm)$/.test(ext)) return out('docx');
  if (/^(?:pptx|pptm|ppsx|potx)$/.test(ext)) return out('pptx');
  if (ext === 'epub') return out('epub');
  if (/^(?:odt|ott)$/.test(ext)) return out('odt');
  if (/^(?:odp|otp)$/.test(ext)) return out('odp');
  if (ext === 'xlsx') return out('xlsx');
  if (/^(?:pages|key|numbers)$/.test(ext)) return out(ext === 'key' ? 'keynote' : ext);
  return out('archive');
}

function ftypKind(u8) {
  if (!startsWith(u8, ascii('ftyp'), 4)) return null;
  const size = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
  const brands = [];
  for (let i = 8; i + 4 <= Math.min(u8.length, Math.max(16, size)); i += 4) if (i !== 12) brands.push(latin1(u8, i, i + 4));
  const b = brands.join(' ');
  if (/\bavi[fs]\b/.test(b)) return out('image', 'image/avif');
  if (/\b(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs)\b/.test(b)) return out('image', 'image/heic');
  if (/\b(?:mif1|msf1)\b/.test(b)) return out('image', 'image/heif');
  if (/\b(?:M4A |M4B |M4P |F4A )/.test(b)) return out('audio', 'audio/mp4');
  return out('video', 'video/mp4');
}

export function sniff(bytes, name) {
  const u8 = toBytes(bytes) || new Uint8Array(0);
  const ext = extOf(name);
  if (!u8.length) return out('empty');

  // ZIP containers (documents, books, archives)
  if (startsWith(u8, [0x50, 0x4b, 0x03, 0x04]) || startsWith(u8, [0x50, 0x4b, 0x05, 0x06]) || startsWith(u8, [0x50, 0x4b, 0x30, 0x30])) {
    const z = zipListing(u8);
    return zipKind(z.names, z.mimetype, name);
  }
  if (startsWith(u8, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return oleKind(u8, ext);

  // PDF: "%PDF-" may follow some junk; readers allow it within the first KB.
  const head = latin1(u8, 0, Math.min(u8.length, 1024));
  if (head.indexOf('%PDF-') >= 0 && head.indexOf('%PDF-') < 1024) return out('pdf');

  // Images
  if (startsWith(u8, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return out('image', 'image/png');
  if (startsWith(u8, [0xff, 0xd8, 0xff])) return out('image', 'image/jpeg');
  if (startsWith(u8, ascii('GIF87a')) || startsWith(u8, ascii('GIF89a'))) return out('image', 'image/gif');
  if (startsWith(u8, ascii('RIFF')) && startsWith(u8, ascii('WEBP'), 8)) return out('image', 'image/webp');
  if (startsWith(u8, ascii('BM')) && u8.length >= 26) {
    const dib = u8[14] | (u8[15] << 8) | (u8[16] << 16) | (u8[17] << 24);
    const reserved = u8[6] | u8[7] | u8[8] | u8[9];
    if (!reserved && [12, 16, 40, 52, 56, 64, 108, 124].includes(dib)) return out('image', 'image/bmp');
  }
  if (startsWith(u8, [0x49, 0x49, 0x2a, 0x00]) || startsWith(u8, [0x4d, 0x4d, 0x00, 0x2a])) return out('image', 'image/tiff');
  if (startsWith(u8, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]) || startsWith(u8, [0xff, 0x4f, 0xff, 0x51])) return out('image', 'image/jp2');
  if (startsWith(u8, [0xff, 0x0a]) || startsWith(u8, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return out('image', 'image/jxl');
  const ftyp = ftypKind(u8);
  if (ftyp) return ftyp;

  // RTF ("{\rtf", possibly after a BOM or whitespace)
  if (/^(?:\xef\xbb\xbf)?\s*\{\\rtf/.test(head)) return out('rtf');

  // Other binary formats worth a clear refusal
  if (startsWith(u8, ascii('BOOKMOBI'), 60) || startsWith(u8, ascii('TEXtREAd'), 60) || startsWith(u8, ascii('TPZ'))) return out('mobi');
  if (startsWith(u8, ascii('AT&TFORM'))) return out('djvu');
  if (startsWith(u8, ascii('%!PS'))) return out('ps');
  if (startsWith(u8, [0x1f, 0x8b]) || startsWith(u8, ascii('Rar!')) || startsWith(u8, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(u8, ascii('BZh')) || startsWith(u8, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return out('archive', 'application/octet-stream');
  if (startsWith(u8, ascii('ID3')) || startsWith(u8, ascii('OggS')) || startsWith(u8, ascii('fLaC')) || (startsWith(u8, ascii('RIFF')) && startsWith(u8, ascii('WAVE'), 8))) return out('audio', 'audio/*');
  if (startsWith(u8, [0x1a, 0x45, 0xdf, 0xa3]) || (startsWith(u8, ascii('RIFF')) && startsWith(u8, ascii('AVI '), 8))) return out('video', 'video/*');
  if (startsWith(u8, ascii('MZ')) || startsWith(u8, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(u8, ascii('SQLite format 3'))) return out('binary');

  // Text of some kind
  if (looksBinary(u8)) return out('binary');
  const textHead = bomEncoding(u8) || guessUtf16(u8) ? decodeText(u8.subarray(0, Math.min(u8.length, 65536))).text : latin1(u8, 0, Math.min(u8.length, 65536));
  return textKind(textHead, ext);
}

// Text content: markup, a MIME message, Markdown or plain text.
export function textKind(text, ext) {
  let s = String(text).replace(/^\ufeff/, '');
  // Skip leading whitespace and comments (saved pages start with "<!-- saved from url=...")
  let i = 0;
  for (let guard = 0; guard < 50; guard++) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4);
      if (e < 0) break;
      i = e + 3;
    } else break;
  }
  const lead = s.slice(i, i + 2000);
  if (/^<\?xml\b/i.test(lead)) {
    const root = /<(?!\?|!)([A-Za-z_][\w.:-]{0,60})/.exec(lead.slice(5));
    const r = root ? root[1].toLowerCase() : '';
    if (r === 'html' || /<!doctype\s+html/i.test(lead)) return out('html', 'application/xhtml+xml');
    if (r === 'office:document') {
      const mt = /office:mimetype\s*=\s*["']([^"']{1,80})["']/.exec(s.slice(i, i + 4000));
      return mt && /presentation/.test(mt[1]) ? out('odp', mt[1]) : out('odt', mt ? mt[1] : MIME.odt);
    }
    if (r === 'svg') return out('image', 'image/svg+xml');
    return out('html', 'application/xml');
  }
  if (/^<(?:!doctype\s+svg\b|svg\b)/i.test(lead)) return out('image', 'image/svg+xml');
  if (/^<(?:!doctype\s+html|html|head|body|meta|title|link|base)\b/i.test(lead)) return out('html');
  if (/^(?:htm|html|xhtml|xht|shtml)$/.test(ext) && lead[0] === '<') return out('html');
  if (/^(?:mht|mhtml)$/.test(ext) || /^(?:[A-Za-z][A-Za-z0-9-]{0,60}:)/.test(lead)) {
    const mk = mimeKind(s.slice(i, i + 8192));
    if (mk) return out(mk);
  }
  if (/^(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|rmd)$/.test(ext)) return out('markdown');
  // An HTML fragment without <html> (clipboard exports, some apps): closing tags give it away.
  if (lead[0] === '<' && /<\/(?:p|div|span|h[1-6]|li|table|a|b|i|strong|em)>/i.test(s.slice(i, i + 8192)) && ext !== 'txt') return out('html');
  if (ext !== 'txt' && looksLikeMarkdown(s)) return out('markdown');
  return out('text');
}
