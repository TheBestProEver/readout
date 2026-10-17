// Small helpers shared by the format readers: yielding, errors, numbering, paths.

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function yieldNow() {
  if (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function') return globalThis.scheduler.yield();
  if (typeof setImmediate === 'function') return new Promise((r) => setImmediate(r));
  if (typeof MessageChannel === 'function') {
    return new Promise((r) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => {
        c.port1.close();
        r();
      };
      c.port2.postMessage(0);
    });
  }
  return new Promise((r) => setTimeout(r, 0));
}

export function abortError() {
  return typeof DOMException === 'function' ? new DOMException('The operation was aborted.', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw signal.reason || abortError();
}

// Long loops call pause() often. It only gives the page back when the current task
// has run for `budget` ms, so big files never freeze the page and small ones stay fast.
export function makePause(signal, budget = 10) {
  let last = now();
  const pause = async () => {
    throwIfAborted(signal);
    if (now() - last < budget) return;
    await yieldNow();
    last = now();
    throwIfAborted(signal);
  };
  pause.now = async () => {
    await yieldNow();
    last = now();
    throwIfAborted(signal);
  };
  pause.signal = signal;
  return pause;
}

// Errors meant for the person using the app carry the message in .user (Readout shows it as is).
export function userError(message, code, cause) {
  const e = new Error(message);
  e.user = message;
  if (code) e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/* ---------- notes that are source citations ---------- */

// Signs that a note is a source citation rather than prose: two or more of them, or a note
// that opens with "Ibid." or "Op. cit.". "1. J. Patel, River Towns (London, 1998), p. 12." is a
// citation; "2. The mill closed in the spring." is a note worth hearing.
const CITE_SIGNS = [
  /\bRetrieved\b/, /\bArchived\b/, /\bWayback Machine\b/, /\bISBN\b/, /\bISSN\b/, /\bdoi\b/i, /\bPMID\b/, /\barXiv\b/, /\bBibcode\b/,
  /\bpp?\. ?\d/, /\bet al\./, /\bPress\b/, /\bJournal\b/, /\(\d{4}[a-z]?\)/, /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/, /\bvol\. ?\d/i,
  /https?:\/\//, /\bUniversity\b/, /\bProceedings\b/, /\bUS \d{6,}/,
  /\(\p{Lu}[^()]{0,60}\b(?:1[5-9]|20)\d{2}\)/u, // (London, 1998), (New York: Penguin, 2004)
  /\b(?:eds?|trans|repr|rev)\. /, /\bch\. ?\d/i, /\bfol\. ?\d/i,
  /^\s*(?:\d{1,4}[.)]?\s+)?\p{Lu}\p{Ll}+(?: (?:and|&) \p{Lu}\p{Ll}+)?,? (?:1[5-9]|20)\d{2}[a-z]?\b/u, // Patel 1998, ...
];
const CITE_OPENING = /^\s*(?:\d{1,4}[.)]?\s+)?(?:ibid|ibidem|op\. ?cit|loc\. ?cit)\b/i;
// A note that is nothing but an author and year: "5. Patel 1998, 45.", "Jones et al. 2004: 3-9"
const AUTHOR_YEAR = /^\s*(?:\d{1,4}[.)]?\s+)?(?:[Ss]ee |[Cc]f\. )?\p{Lu}\p{Ll}+(?: (?:and|&) \p{Lu}\p{Ll}+| et al\.)?,? (?:1[5-9]|20)\d{2}[a-z]?(?:[,:] ?(?:pp?\. ?)?\d+(?:[-–]\d+)?)?\.?\s*$/u;

export function citeSigns(text) {
  const t = String(text || '').slice(0, 2000);
  let n = 0;
  for (const re of CITE_SIGNS) if (re.test(t)) n++;
  return n;
}

export function isCitation(text) {
  const t = String(text || '');
  return CITE_OPENING.test(t) || (t.length < 120 && AUTHOR_YEAR.test(t)) || citeSigns(t) >= 2;
}

/* ---------- list numbers ---------- */

export function roman(n) {
  if (!(n > 0 && n < 4000)) return String(n);
  const v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const s = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let out = '';
  for (let i = 0; i < v.length; i++) {
    while (n >= v[i]) {
      out += s[i];
      n -= v[i];
    }
  }
  return out;
}

// 1 -> a, 26 -> z, 27 -> aa (bijective base 26, as browsers number lower-alpha lists)
export function alpha(n) {
  if (!(n > 0)) return String(n);
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

// fmt: Word's w:numFmt values, ODF/HTML one-letter styles ('1', 'a', 'A', 'i', 'I'), or PowerPoint autonumber prefixes.
export function formatNumber(n, fmt) {
  switch (fmt) {
    case 'a':
    case 'lowerLetter':
    case 'alphaLc':
      return alpha(n);
    case 'A':
    case 'upperLetter':
    case 'alphaUc':
      return alpha(n).toUpperCase();
    case 'i':
    case 'lowerRoman':
    case 'romanLc':
      return roman(n).toLowerCase();
    case 'I':
    case 'upperRoman':
    case 'romanUc':
      return roman(n);
    case 'decimalZero':
      return n < 10 ? '0' + n : String(n);
    default:
      return String(n);
  }
}

/* ---------- Symbol font ---------- */

// Word and RTF files store Greek letters, maths signs and bullets as codes in the Symbol
// font (often in the private-use range F020-F0FF). Map them to real characters.
const SYMBOL_HIGH = {
  0xa0: '€', 0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔',
  0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•',
  0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘', 0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅',
  0xc7: '∩', 0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉', 0xd0: '∠', 0xd1: '∇', 0xd2: '®',
  0xd3: '©', 0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒',
  0xdf: '⇓', 0xe0: '◊', 0xe1: '〈', 0xe2: '®', 0xe3: '©', 0xe4: '™', 0xe5: '∑', 0xf1: '〉', 0xf2: '∫',
};
const SYMBOL_LOW = '∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_ αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼';

export function symbolChar(code) {
  const c = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  if (c === 0x20) return ' ';
  if (c === 0x21) return '!';
  if (c >= 0x22 && c <= 0x7e) {
    const ch = SYMBOL_LOW[c - 0x22];
    return ch === ' ' ? '' : ch; // 0x60 is a radical extender: nothing to read
  }
  return SYMBOL_HIGH[c] || '';
}

// Wingdings: keep the few marks that carry meaning, drop decoration.
export function wingdingsChar(code) {
  const c = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  return { 0xfc: '✓', 0xfb: '✗', 0xfe: '☑', 0xfd: '☒', 0xa8: '☐', 0x6f: '☐', 0x71: '☐' }[c] || '';
}

/* ---------- bytes and paths ---------- */

// Bytes -> a string with one char per byte (for parsing ASCII-framed formats like RTF and MIME).
export function latin1(u8, start = 0, end = u8.length) {
  let s = '';
  for (let i = start; i < end; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(end, i + 0x8000)));
  return s;
}

export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

export function safeDecodeURI(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

// Resolves a relative reference against the path of the part that contains it.
export function resolvePath(base, rel) {
  rel = String(rel || '').replace(/\\/g, '/');
  const cut = rel.search(/[?#]/);
  if (cut >= 0) rel = rel.slice(0, cut);
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return null; // external (http:, mailto:)
  const parts = rel.startsWith('/') ? [] : String(base || '').split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(safeDecodeURI(seg));
  }
  return parts.join('/');
}

export function baseName(name) {
  return String(name || '').replace(/\\/g, '/').split('/').pop();
}

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(baseName(name));
  return m ? m[1].toLowerCase() : '';
}
