// Text in an unknown encoding: BOMs, UTF-16 without a BOM, UTF-8, Windows-1252, and the
// mixtures and double-encodings real files contain.

import { latin1 } from './util.js';

// Windows-1252 0x80-0x9F (the rest of the high half is Latin-1). '' marks the five unused codes.
const CP1252 = '€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ';

function cp1252Char(b) {
  if (b < 0x80 || b >= 0xa0) return String.fromCharCode(b);
  const c = CP1252[b - 0x80];
  return c === '\u0000' ? '' : c;
}

export function bomEncoding(u8) {
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return 'utf-8';
  if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xfe && u8[2] === 0 && u8[3] === 0) return 'utf-32le';
  if (u8.length >= 4 && u8[0] === 0 && u8[1] === 0 && u8[2] === 0xfe && u8[3] === 0xff) return 'utf-32be';
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return 'utf-16le';
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return 'utf-16be';
  return null;
}

// UTF-16 without a BOM: mostly-ASCII text has a zero in every other byte.
export function guessUtf16(u8) {
  const n = Math.min(u8.length, 8192) & ~1;
  if (n < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i++) if (u8[i] === 0) (i & 1 ? odd++ : even++);
  const half = n / 2;
  if (odd > half * 0.3 && even < half * 0.05) return 'utf-16le';
  if (even > half * 0.3 && odd < half * 0.05) return 'utf-16be';
  return null;
}

// Binary data (images, executables, archives) rather than text in some encoding.
export function looksBinary(u8) {
  if (bomEncoding(u8) || guessUtf16(u8)) return false;
  const n = Math.min(u8.length, 8192);
  if (!n) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = u8[i];
    if (b === 0) bad += 4;
    else if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) bad++;
  }
  return bad > n * 0.02;
}

// The charset a markup file declares in its first bytes (<?xml encoding>, <meta charset>).
export function declaredCharset(u8) {
  const head = latin1(u8, 0, Math.min(u8.length, 2048));
  const xml = /^\s*<\?xml[^>]{0,200}?encoding\s*=\s*["']([\w.:-]{1,40})["']/i.exec(head);
  if (xml) return xml[1].toLowerCase();
  const meta = /<meta[^>]{0,300}?charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(head);
  return meta ? meta[1].toLowerCase() : null;
}

function utf8Run(u8, i) {
  const b = u8[i];
  const len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
  if (!len || i + len > u8.length) return 0;
  for (let k = 1; k < len; k++) if ((u8[i + k] & 0xc0) !== 0x80) return 0;
  const c = u8[i + 1];
  if ((b === 0xe0 && c < 0xa0) || (b === 0xed && c > 0x9f) || (b === 0xf0 && c < 0x90) || (b === 0xf4 && c > 0x8f)) return 0;
  return len;
}

// Counts well-formed multi-byte UTF-8 sequences and stray high bytes.
function utf8Stats(u8) {
  let good = 0;
  let bad = 0;
  for (let i = 0; i < u8.length; ) {
    if (u8[i] < 0x80) {
      i++;
      continue;
    }
    const len = utf8Run(u8, i);
    if (len) {
      good++;
      i += len;
    } else {
      bad++;
      i++;
    }
  }
  return { good, bad };
}

// Valid UTF-8 sequences stay UTF-8; stray bytes are read as Windows-1252. Files joined
// from two sources (or edited in two editors) are often like this.
export function decodeMixed(u8) {
  const dec = new TextDecoder('utf-8');
  const out = [];
  let start = 0;
  for (let i = 0; i < u8.length; ) {
    if (u8[i] < 0x80) {
      i++;
      continue;
    }
    const len = utf8Run(u8, i);
    if (len) {
      i += len;
      continue;
    }
    if (i > start) out.push(dec.decode(u8.subarray(start, i)));
    out.push(cp1252Char(u8[i]));
    i++;
    start = i;
  }
  if (start < u8.length) out.push(dec.decode(u8.subarray(start)));
  return out.join('');
}

function decodeUtf32(u8, le) {
  const out = [];
  for (let i = 4; i + 3 < u8.length; i += 4) {
    const c = le ? u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24) : (u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3];
    if (c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff)) out.push(String.fromCodePoint(c));
  }
  return out.join('');
}

// Labels for single-byte Western encodings: browsers decode all of these as Windows-1252.
const LATIN = /^(?:iso[-_]?8859[-_]?1|latin-?1|l1|us-ascii|ascii|cp1252|windows-1252|x-cp1252|cp819|ibm819|iso-ir-100)$/;

function tryDecoder(label) {
  try {
    return new TextDecoder(label);
  } catch (e) {
    return null;
  }
}

// bytes -> { text, encoding }. charset: a declared charset (HTTP/MIME/meta), used unless the
// bytes clearly say otherwise.
export function decodeText(input, opts) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bom = bomEncoding(u8);
  if (bom === 'utf-32le' || bom === 'utf-32be') return { text: decodeUtf32(u8, bom === 'utf-32le'), encoding: bom };
  if (bom) return { text: new TextDecoder(bom).decode(u8), encoding: bom };
  const u16 = guessUtf16(u8);
  if (u16) return { text: new TextDecoder(u16).decode(u8), encoding: u16 };

  const declared = opts && opts.charset ? String(opts.charset).trim().toLowerCase() : '';
  if (declared && !/^utf-?8$|^unicode-1-1-utf-8$/.test(declared)) {
    const latinish = LATIN.test(declared);
    // A page that says Latin-1 but is valid UTF-8 with accented letters is really UTF-8.
    if (latinish) {
      const st = utf8Stats(u8);
      if (st.good > 0 && st.bad === 0) return { text: fixMojibake(new TextDecoder('utf-8').decode(u8)), encoding: 'utf-8' };
    }
    const dec = tryDecoder(latinish ? 'windows-1252' : declared);
    if (dec && !/^utf-?16/.test(dec.encoding)) return { text: dec.decode(u8), encoding: dec.encoding };
  }

  try {
    return { text: fixMojibake(new TextDecoder('utf-8', { fatal: true }).decode(u8)), encoding: 'utf-8' };
  } catch (e) {
    /* not clean UTF-8 */
  }
  const st = utf8Stats(u8);
  if (st.good > 0 && st.bad <= Math.max(2, st.good * 0.1)) return { text: decodeMixed(u8), encoding: 'utf-8' };
  return { text: new TextDecoder('windows-1252').decode(u8), encoding: 'windows-1252' };
}

/* ---------- mojibake: UTF-8 that was decoded as Windows-1252 and saved again ---------- */

// Characters a byte 0x80-0xBF turns into under Windows-1252 (UTF-8 continuation bytes).
const CONT = '[\\u0080-\\u00bf€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]';
const MOJIBAKE = new RegExp(`[\\u00c2-\\u00df]${CONT}|[\\u00e0-\\u00ef]${CONT}{2}|[\\u00f0-\\u00f4]${CONT}{3}`, 'g');
const REVERSE = new Map();
for (let b = 0x80; b < 0xa0; b++) {
  const c = CP1252[b - 0x80];
  REVERSE.set(c === '\u0000' ? String.fromCharCode(b) : c, b);
}

function cp1252Byte(ch) {
  const c = ch.charCodeAt(0);
  if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
  const b = REVERSE.get(ch);
  return b === undefined ? -1 : b;
}


// "donâ€™t" -> "don’t", "cafÃ©" -> "café". Only applied when the pattern shows up more than
// once, or as the unmistakable "â€" sequence, so real text in other languages is left alone.
export function fixMojibake(text) {
  // eslint-disable-next-line no-control-regex
  if (!/[Â-ô]/.test(text)) return text;
  const hits = text.match(MOJIBAKE);
  if (!hits || (hits.length < 2 && !/â€/.test(text))) return text;
  // Decoded by hand: a TextDecoder call per match is slow when a file is full of them.
  return text.replace(MOJIBAKE, (m) => {
    const b0 = cp1252Byte(m[0]);
    let cp = b0 >= 0xf0 ? b0 & 0x07 : b0 >= 0xe0 ? b0 & 0x0f : b0 & 0x1f;
    for (let i = 1; i < m.length; i++) {
      const b = cp1252Byte(m[i]);
      if (b < 0x80 || b > 0xbf) return m;
      cp = (cp << 6) | (b & 0x3f);
    }
    // overlong forms, surrogates and out-of-range values are not real UTF-8
    const min = m.length === 2 ? 0x80 : m.length === 3 ? 0x800 : 0x10000;
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
    return String.fromCodePoint(cp);
  });
}
