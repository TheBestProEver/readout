// RTF -> blocks with a small tokenizer (no library). Handles destinations to skip (font and
// colour tables, pictures, field instructions, headers), \'hh bytes in the document or font
// code page, \uN with its \ucN fallback, hidden text (\v), headings from the style sheet or
// \outlinelevel, list items, table cells, and footnotes (moved to the end).

import { makeBlock } from '../doc.js';
import { latin1, symbolChar, wingdingsChar } from './util.js';

const SKIP = new Set([
  'colortbl', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'xmlnstbl',
  'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl',
  'revtbl', 'pgdsctbl', 'fldinst', 'bkmkstart', 'bkmkend', 'mmathPr', 'pnseclvl', 'nonshppict', 'shppict', 'shpinst', 'userprops', 'docvar',
  'wgrffmtfilter', 'fchars', 'lchars', 'mhtmltag', 'xe', 'tc', 'tcn', 'annotation', 'atnid', 'atnauthor', 'atndate', 'atnref', 'atrfstart',
  'atrfend', 'atnparent', 'atnicn', 'atntime', 'formfield', 'datafield', 'background', 'docinfo', 'passwordhash', 'protusertbl',
  'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc', 'aftncn', 'blipuid', 'panose', 'falt', 'objdata', 'objclass', 'objname', 'oleclsid',
  'printim', 'buptim', 'creatim', 'revtim', 'company', 'operator', 'author', 'subject', 'keywords', 'comment', 'doccomm', 'hlinkbase',
  'category', 'manager', 'ud', 'sp', 'sn', 'sv', 'svb', 'template', 'nextfile', 'ebcstart', 'ebcend', 'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops', 'pn',
]);

// Control words that stand for a character. \par, \cell and friends are handled in the loop.
const SYM = {
  line: '\n', column: '\n', tab: ' ', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•',
  emspace: ' ', enspace: ' ', qmspace: ' ', zwj: '\u200d', zwnj: '\u200c',
};
const SYM1 = { '~': ' ', '-': '', _: '-', ':': '', '|': '' };

// \fcharsetN -> code page
const CHARSET = { 0: 1252, 1: 1252, 2: 'symbol', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };

const decoders = new Map();
function decoderFor(cp) {
  const label = typeof cp === 'number' ? (cp === 65001 ? 'utf-8' : cp === 10000 ? 'macintosh' : 'windows-' + cp) : cp;
  if (!decoders.has(label)) {
    let d = null;
    try {
      d = new TextDecoder(label);
    } catch (e) {
      d = new TextDecoder('windows-1252');
    }
    decoders.set(label, d);
  }
  return decoders.get(label);
}

function makeFont(name, charset) {
  const nm = String(name || '').replace(/;\s*$/, '').trim();
  let kind = '';
  if (/^symbol$/i.test(nm) || charset === 2) kind = 'symbol';
  else if (/^(?:wingdings|webdings)/i.test(nm)) kind = 'wingdings';
  let cp = null;
  if (typeof charset === 'string' && /^cp\d+$/.test(charset)) cp = +charset.slice(2);
  else if (charset != null && CHARSET[charset] && CHARSET[charset] !== 'symbol') cp = CHARSET[charset];
  return { kind, cp };
}

// input: bytes or a string with one char per byte. ctx: { pause }
export async function readRtf(input, ctx) {
  const pause = ctx && ctx.pause;
  const src = typeof input === 'string' ? input : latin1(input instanceof Uint8Array ? input : new Uint8Array(input));
  const n = src.length;
  let docCp = 1252;
  const head = src.slice(0, 4096);
  const ansi = /\\ansicpg(\d{3,5})/.exec(head);
  if (ansi) docCp = +ansi[1];
  else if (/\\mac\b/.test(head.slice(0, 200))) docCp = 10000;

  const fonts = new Map(); // number -> { cp, kind }
  const styles = new Map(); // number -> { name, outline }
  let defFont = null;
  const blocks = [];
  const notes = [];
  let title = '';

  // Group state (copied on '{', restored on '}').
  let st = { dest: 'body', uc: 1, hidden: false, font: null, first: true, pstyle: null, outline: null, list: false, intbl: false };
  const stack = [];
  let ucSkip = 0;
  let bytes = [];
  let para = ''; // text of the paragraph being read
  let marker = ''; // \listtext / \pntext: the rendered list label
  let note = '';
  let fontName = '';
  let fontNum = null;
  let fontCharset = null;
  let styleName = '';
  let styleNum = null;
  let styleOutline = null;
  let titleText = '';

  const saveFont = () => {
    if (fontNum != null) fonts.set(fontNum, makeFont(fontName, fontCharset));
    fontNum = null;
    fontName = '';
    fontCharset = null;
  };
  const fontInfo = () => fonts.get(st.font != null ? st.font : defFont);
  const append = (s) => {
    if (!s) return;
    switch (st.dest) {
      case 'body':
        para += s;
        break;
      case 'note':
        note += s;
        break;
      case 'marker':
        marker += s;
        break;
      case 'font':
        fontName += s;
        break;
      case 'style':
        styleName += s;
        break;
      case 'title':
        titleText += s;
        break;
      default:
    }
  };
  const flushBytes = () => {
    if (!bytes.length) return;
    const fi = fontInfo();
    const arr = new Uint8Array(bytes);
    bytes = [];
    if (fi && (fi.kind === 'symbol' || fi.kind === 'wingdings')) {
      let s = '';
      for (const b of arr) s += fi.kind === 'symbol' ? symbolChar(b) : wingdingsChar(b);
      append(s);
    } else append(decoderFor(fi && fi.cp ? fi.cp : docCp).decode(arr));
  };
  const emit = (s) => {
    if (st.hidden && st.dest !== 'font' && st.dest !== 'style') return;
    flushBytes();
    append(s);
  };
  const endPara = (cell) => {
    flushBytes();
    if (st.dest === 'note') {
      note += '\n';
      return;
    }
    if (st.dest !== 'body') return;
    let text = para;
    para = '';
    const mark = marker.trim();
    marker = '';
    const sty = st.pstyle != null ? styles.get(st.pstyle) : null;
    const name = sty ? sty.name : '';
    const outline = st.outline != null ? st.outline : sty && sty.outline != null ? sty.outline : null;
    const h = /^heading\s*([1-9])$/.exec(name);
    let type = h ? 'h' + Math.min(6, +h[1]) : name === 'title' ? 'h1' : name === 'subtitle' ? 'h2' : outline != null && outline < 9 ? 'h' + Math.min(6, outline + 1) : null;
    if (type && text.length > 250) type = null;
    if (!type) type = /quote/.test(name) ? 'quote' : st.list || mark ? 'li' : cell || st.intbl ? 'cell' : 'p';
    // Keep a numbered label ("1.", "a)"); bullets are added back by docToText.
    if (mark && /[\p{L}\p{N}]/u.test(mark)) text = mark + ' ' + text;
    if (text.trim()) blocks.push(makeBlock(type, text));
  };

  let i = 0;
  let lastPause = 0;
  while (i < n) {
    if (pause && i - lastPause > 65536) {
      lastPause = i;
      await pause();
    }
    const ch = src.charCodeAt(i);
    if (ch === 123) {
      // '{'
      flushBytes();
      stack.push(st);
      st = Object.assign({}, st, { first: true });
      ucSkip = 0;
      i++;
      continue;
    }
    if (ch === 125) {
      // '}'
      flushBytes();
      const prev = st;
      st = stack.pop() || st;
      ucSkip = 0;
      if (prev.dest === 'font') saveFont();
      if (prev.dest === 'style' && styleNum != null) {
        styles.set(styleNum, { name: styleName.replace(/;\s*$/, '').trim().toLowerCase(), outline: styleOutline });
        styleNum = null;
        styleName = '';
        styleOutline = null;
      }
      if (prev.dest === 'note' && st.dest !== 'note') {
        if (note.trim()) notes.push(note.trim());
        note = '';
      }
      if (prev.dest === 'title' && st.dest !== 'title') title = title || titleText.trim();
      i++;
      continue;
    }
    if (ch === 92) {
      // '\'
      const nx = src.charCodeAt(i + 1);
      if (nx === 92 || nx === 123 || nx === 125) {
        if (ucSkip) ucSkip--;
        else emit(src[i + 1]);
        st.first = false;
        i += 2;
        continue;
      }
      if (nx === 39) {
        // \'hh
        const b = parseInt(src.substr(i + 2, 2), 16);
        i += 4;
        if (ucSkip) {
          ucSkip--;
          continue;
        }
        if (!st.hidden && !Number.isNaN(b)) bytes.push(b);
        st.first = false;
        continue;
      }
      if (nx === 42) {
        // \* : an optional destination, skipped unless we read it
        i += 2;
        const m = /\\([a-zA-Z]{1,32})/y;
        m.lastIndex = i;
        const w = m.exec(src);
        const word = w ? w[1] : '';
        if (word !== 'footnote' && word !== 'listtext' && word !== 'pntext') st.dest = 'skip';
        continue;
      }
      if (nx === 10 || nx === 13) {
        endPara(false);
        i += 2;
        continue;
      }
      // control word: \word or \word-123, with one optional space delimiter
      let j = i + 1;
      while (j < n && j - i <= 33) {
        const c = src.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) j++;
        else break;
      }
      if (j === i + 1) {
        // control symbol
        const sym = SYM1[src[i + 1]];
        if (sym !== undefined) emit(sym);
        i += 2;
        continue;
      }
      const word = src.slice(i + 1, j);
      let k = j;
      if (src.charCodeAt(k) === 45) k++;
      while (k < n && k - j < 11 && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57) k++;
      const hasArg = k > j && !(k === j + 1 && src.charCodeAt(j) === 45);
      if (!hasArg) k = j;
      const arg = hasArg ? parseInt(src.slice(j, k), 10) : null;
      if (src.charCodeAt(k) === 32) k++;
      i = k;
      const first = st.first;
      st.first = false;

      if (word === 'bin') {
        i += arg > 0 ? arg : 0;
        continue;
      }
      if (st.dest === 'skip') continue;
      if (first) {
        if (SKIP.has(word)) {
          st.dest = 'skip';
          continue;
        }
        if (word === 'fonttbl') {
          st.dest = 'font';
          continue;
        }
        if (word === 'stylesheet') {
          st.dest = 'style';
          continue;
        }
        if (word === 'info') {
          st.dest = 'info';
          continue;
        }
        if (word === 'title' && st.dest === 'info') {
          st.dest = 'title';
          continue;
        }
        if (word === 'footnote') {
          st.dest = 'note';
          st.hidden = false;
          continue;
        }
        if (word === 'listtext' || word === 'pntext') {
          st.dest = 'marker';
          continue;
        }
      }
      if (st.dest === 'info') continue;
      if (st.dest === 'font') {
        if (word === 'f') {
          saveFont(); // old-style tables list fonts without a group each
          fontNum = arg;
        } else if (word === 'fcharset') fontCharset = arg;
        else if (word === 'cpg' && fontNum != null) fontCharset = 'cp' + arg;
        continue;
      }
      if (st.dest === 'style') {
        if (word === 's') styleNum = arg;
        else if (word === 'outlinelevel') styleOutline = arg;
        else if (word === 'cs' || word === 'ds' || word === 'ts') styleNum = null; // character, section, table styles
        continue;
      }
      switch (word) {
        case 'uc':
          st.uc = arg != null ? arg : 1;
          break;
        case 'u': {
          let c = arg;
          if (c < 0) c += 65536;
          const fi = fontInfo();
          if (fi && (fi.kind === 'symbol' || fi.kind === 'wingdings') && c >= 0xf000 && c <= 0xf0ff) emit(fi.kind === 'symbol' ? symbolChar(c) : wingdingsChar(c));
          else if (c >= 0) emit(String.fromCharCode(c));
          ucSkip = st.uc;
          break;
        }
        case 'deff':
          defFont = arg;
          break;
        case 'f':
          flushBytes();
          st.font = arg;
          break;
        case 'v':
          flushBytes();
          st.hidden = arg !== 0;
          break;
        case 'plain':
          flushBytes();
          st.hidden = false;
          st.font = null;
          break;
        case 'pard':
          st.pstyle = null;
          st.outline = null;
          st.list = false;
          st.intbl = false;
          break;
        case 's':
          st.pstyle = arg;
          break;
        case 'outlinelevel':
          st.outline = arg;
          break;
        case 'ls':
        case 'ilvl':
        case 'pnlvlblt':
        case 'pnlvlbody':
          st.list = true;
          break;
        case 'intbl':
          st.intbl = true;
          break;
        case 'cell':
        case 'nestcell':
          endPara(true);
          break;
        case 'par':
        case 'sect':
        case 'page':
          endPara(false);
          break;
        default: {
          const sym = SYM[word];
          if (sym !== undefined) emit(sym);
        }
      }
      continue;
    }
    if (ch === 13 || ch === 10) {
      i++;
      continue;
    }
    if (ucSkip) {
      ucSkip--;
      i++;
      continue;
    }
    st.first = false;
    if (st.dest === 'skip' || st.dest === 'info') {
      // Skipped groups can be huge (pictures in hex): jump to the next control character.
      i++;
      while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 92 || c === 123 || c === 125) break;
        i++;
      }
      continue;
    }
    // Plain text: bytes over 0x7F are in the code page, so collect them with the \'hh bytes.
    if (ch >= 0x80) {
      if (!st.hidden) bytes.push(ch);
      i++;
      continue;
    }
    if (st.dest === 'font' && ch === 59) {
      saveFont(); // ';' ends a font entry
      i++;
      continue;
    }
    // Copy a run of ordinary characters at once.
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 || c === 123 || c === 125 || c === 13 || c === 10 || c >= 0x80 || c === 59) break;
      j++;
    }
    emit(src.slice(i, j));
    i = j;
  }
  flushBytes();
  saveFont();
  if (para.trim()) endPara(false);
  if (notes.length) {
    blocks.push(makeBlock('h2', 'Notes'));
    notes.forEach((t, k) => blocks.push(makeBlock('note', k + 1 + '. ' + t)));
  }
  return { title: title.replace(/\s+/g, ' ').trim(), blocks, warnings: [] };
}
