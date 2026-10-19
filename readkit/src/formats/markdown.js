// Markdown -> blocks: ATX and setext headings, paragraphs, nested lists (numbers kept), block
// quotes, fenced and indented code (kept, marked skippable), pipe tables (cell by cell),
// footnotes (moved to the end), YAML front matter (its title used). Inline markup is removed
// with a single linear scan, so links read as their text and emphasis markers vanish.

import { makeBlock } from '../doc.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function entity(s, i) {
  const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/.exec(s.slice(i, i + 12));
  if (!m) return null;
  const e = m[1];
  if (e[0] === '#') {
    const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return { text: c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : '', len: m[0].length };
  }
  return ENTITIES[e] !== undefined ? { text: ENTITIES[e], len: m[0].length } : null;
}

// For every '[' (or '('), the index of its matching ']' (or ')'), found in one pass with a
// stack. Parentheses don't match across a line break (link destinations can't contain one).
function matchPairs(s, open, close) {
  const match = new Map();
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === open) stack.push(i);
    else if (c === close) {
      if (stack.length) match.set(stack.pop(), i);
    } else if (c === '\n' && open === '(') stack.length = 0;
  }
  return match;
}

const AUTOLINK = /<(?:(https?:\/\/[^\s<>]{1,2000})|(mailto:[^\s<>]{1,200})|([a-zA-Z][\w.+-]{0,63}@[\w.-]{1,253}))>/y;
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]{0,20})(?:\s[^<>]{0,500})?\/?>/y;
// Raw HTML in Markdown (a README's <table>, <div align>, <details>): a block element's edges
// break the line ('<td>Mon</td><td>Gym</td>' is not 'MonGym'); what a script, a style sheet or a
// template holds is never text.
const HTML_BREAK = /^(?:address|article|aside|blockquote|caption|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/i;
const HTML_DROP = /^(?:script|style|template|noscript)$/i;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;

// Inline Markdown -> plain text in one pass. Emphasis delimiters are matched with a bounded
// stack (so no quadratic backtracking on long lines of asterisks).
export function inlineText(src, depth = 0) {
  const s = String(src);
  if (!/[\\`*_~[\]!<&]/.test(s)) return s;
  const brackets = s.includes('[') ? matchPairs(s, '[', ']') : new Map();
  const parens = brackets.size && s.includes('(') ? matchPairs(s, '(', ')') : new Map();
  const closeBracket = (s2, at) => (brackets.has(at) ? brackets.get(at) : -1);
  const closeParen = (s2, at) => (parens.has(at) ? parens.get(at) : -1);
  const label = (a, b) => (depth < 3 ? inlineText(s.slice(a, b), depth + 1) : s.slice(a, b));
  const lead = s.search(/\S/);
  let commentEnd = -2;
  let lower = null; // s in lower case, made when first needed
  const out = [];
  const delims = []; // { idx in out, ch, len, canOpen, canClose }
  // Next code-span closer of each length, found by scanning backtick runs once.
  const runs = new Map();
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '`') continue;
    let j = i;
    while (j < s.length && s[j] === '`') j++;
    const len = j - i;
    if (!runs.has(len)) runs.set(len, []);
    runs.get(len).push(i);
    i = j - 1;
  }
  const runPos = new Map();
  const nextRun = (len, after) => {
    const list = runs.get(len);
    if (!list) return -1;
    let k = runPos.get(len) || 0;
    while (k < list.length && list[k] <= after) k++;
    runPos.set(len, k);
    return k < list.length ? list[k] : -1;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      out.push(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      out.push('\n');
      i += 2;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const len = j - i;
      const close = nextRun(len, i);
      if (close > 0) {
        out.push(s.slice(j, close).replace(/\n/g, ' ').trim());
        i = close + len;
        continue;
      }
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    if (c === '[' && s[i + 1] === '[') {
      // Wiki links (Obsidian, Logseq): [[Page]], [[Page#Part|shown text]]; ![[embed]] is a picture or a whole note.
      const e = s.slice(i + 2, i + 302).indexOf(']]');
      const inner = e > 0 ? s.slice(i + 2, i + 2 + e) : '';
      if (inner && !/[[\]\n]/.test(inner)) {
        const bar = inner.lastIndexOf('|');
        if (i === 0 || s[i - 1] !== '!') out.push((bar >= 0 ? inner.slice(bar + 1) : inner.replace(/#.*$/, '')).trim());
        else out.pop();
        i += e + 4;
        continue;
      }
    }
    if (c === '!' && s[i + 1] === '[') {
      if (s[i + 2] === '[') {
        // ![[embed]]: dropped by the wiki-link branch on the next character
        out.push('!');
        i++;
        continue;
      }
      // Images: the alt text is a description of a picture; leave it out.
      const cb = closeBracket(s, i + 1);
      if (cb > 0 && s[cb + 1] === '(') {
        const cp = closeParen(s, cb + 1);
        if (cp > 0) {
          i = cp + 1;
          continue;
        }
      }
      if (cb > 0 && s[cb + 1] === '[') {
        const cb2 = closeBracket(s, cb + 1);
        if (cb2 > 0) {
          i = cb2 + 1;
          continue;
        }
      }
    }
    if (c === '[') {
      if (s[i + 1] === '^') {
        // footnote reference [^1]: the note itself is read at the end
        const cb = closeBracket(s, i);
        if (cb > 0 && cb - i < 40 && !/\s/.test(s.slice(i + 2, cb))) {
          i = cb + 1;
          continue;
        }
      }
      const cb = closeBracket(s, i);
      if (cb > 0) {
        if (s[cb + 1] === '(') {
          const cp = closeParen(s, cb + 1);
          if (cp > 0) {
            out.push(label(i + 1, cb));
            i = cp + 1;
            continue;
          }
        } else if (s[cb + 1] === '[') {
          const cb2 = closeBracket(s, cb + 1);
          if (cb2 > 0) {
            out.push(label(i + 1, cb));
            i = cb2 + 1;
            continue;
          }
        } else if (cb === i + 2 && /[ xX]/.test(s[i + 1]) && i === lead) {
          // task list box "[ ]" / "[x]"
          i = cb + 1;
          while (s[i] === ' ') i++;
          continue;
        }
      }
    }
    if (c === '<') {
      // autolinks <https://x>, inline HTML tags, <br>
      AUTOLINK.lastIndex = i;
      const m = AUTOLINK.exec(s);
      if (m) {
        out.push(m[1] || (m[2] || '').slice(7) || m[3]);
        i += m[0].length;
        continue;
      }
      TAG.lastIndex = i;
      const t = TAG.exec(s);
      if (t) {
        if (HTML_DROP.test(t[1]) && t[0][1] !== '/') {
          // to the end of the element (never closed: only the tag, the words after it may be prose)
          if (lower === null) lower = s.toLowerCase();
          const end = lower.indexOf('</' + t[1].toLowerCase(), i + t[0].length);
          const gt = end < 0 ? -1 : s.indexOf('>', end);
          i = gt < 0 ? i + t[0].length : gt + 1;
          continue;
        }
        if (/^br$/i.test(t[1]) || HTML_BREAK.test(t[1])) out.push('\n');
        i += t[0].length;
        continue;
      }
      if (s.startsWith('<!--', i) && commentEnd !== -1) {
        if (commentEnd < i + 4) commentEnd = s.indexOf('-->', i + 4);
        if (commentEnd >= 0) {
          i = commentEnd + 3;
          continue;
        }
      }
    }
    if (c === '&') {
      const e = entity(s, i);
      if (e) {
        out.push(e.text);
        i += e.len;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < s.length && s[j] === c) j++;
      const len = j - i;
      const before = i > 0 ? s[i - 1] : ' ';
      const after = j < s.length ? s[j] : ' ';
      const leftFlank = !/\s/.test(after) && (!PUNCT_OR_SPACE.test(after) || PUNCT_OR_SPACE.test(before));
      const rightFlank = !/\s/.test(before) && (!PUNCT_OR_SPACE.test(before) || PUNCT_OR_SPACE.test(after));
      // snake_case_words: an underscore inside a word is not emphasis
      const canOpen = c === '_' ? leftFlank && (!rightFlank || PUNCT_OR_SPACE.test(before)) : leftFlank;
      const canClose = c === '_' ? rightFlank && (!leftFlank || PUNCT_OR_SPACE.test(after)) : rightFlank;
      if (c === '~' && len !== 2 && len !== 1) {
        out.push(s.slice(i, j));
        i = j;
        continue;
      }
      if (canClose) {
        // Match the nearest opener of the same character (look back a bounded distance).
        let k = delims.length - 1;
        while (k >= 0 && delims.length - k <= 16 && delims[k].ch !== c) k--;
        if (k >= 0 && delims[k].ch === c && delims.length - k <= 16) {
          out[delims[k].idx] = '';
          delims.length = k;
          i = j;
          continue;
        }
      }
      if (canOpen) delims.push({ idx: out.length, ch: c });
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    // Plain run up to the next special character.
    let j = i + 1;
    while (j < s.length && !'\\`*_~[!<&'.includes(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out.join('');
}

/* ---------- blocks ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
// The |---|:--:| row under a table header.
function isTableRule(line) {
  let t = line.trim();
  if (!t.includes('-') || (!t.includes('|') && !/^:?-+:?$/.test(t))) return false;
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').every((c) => /^:?-+:?$/.test(c.trim()));
}
const FOOTDEF = /^ {0,3}\[\^([^\]\s]{1,30})\]:[ \t]*/;
const REFDEF = /^ {0,3}\[[^\]]{1,200}\]:[ \t]*\S/;

function atxText(line) {
  const m = ATX.exec(line);
  let t = line.slice(m[0].length).trimEnd();
  let k = t.length;
  while (k > 0 && t[k - 1] === '#') k--;
  if (k < t.length && (k === 0 || t[k - 1] === ' ' || t[k - 1] === '\t')) t = t.slice(0, k).trimEnd();
  return { level: m[1].length, text: t };
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

// md -> { title, blocks }. ctx: { pause, source }
export async function readMarkdown(md, ctx) {
  const pause = ctx && ctx.pause;
  let text = String(md).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  let title = '';
  // YAML (---) or TOML (+++) front matter
  const fm = /^(---|\+\+\+)[ \t]*\n/.exec(text);
  if (fm) {
    const end = text.indexOf('\n' + fm[1], fm[0].length - 1);
    if (end > 0) {
      const head = text.slice(fm[0].length, end);
      const t = /^title[ \t]*[:=][ \t]*(.+)$/m.exec(head);
      if (t) title = t[1].trim().replace(/^(["'])(.*)\1$/, '$2');
      const after = text.indexOf('\n', end + 1);
      text = after < 0 ? '' : text.slice(after + 1);
    }
  }
  // HTML comments can span lines.
  if (text.includes('<!--')) {
    let out = '';
    let i = 0;
    for (;;) {
      const s = text.indexOf('<!--', i);
      if (s < 0) break;
      const e = text.indexOf('-->', s + 4);
      if (e < 0) break;
      out += text.slice(i, s);
      i = e + 3;
    }
    text = out + text.slice(i);
  }

  const lines = text.split('\n');
  const blocks = [];
  let tables = 0;
  const notes = [];
  const counters = []; // ordered-list numbers by indent depth
  let para = null; // { type, lines }
  let quote = false;
  let fence = null; // { mark, lines }
  let code = null; // indented code lines

  const flush = () => {
    if (!para) return;
    // Hard breaks: two trailing spaces or a backslash keep the line break.
    let t = '';
    para.lines.forEach((l, k) => {
      const trimmed = l.trimEnd();
      const hard = l.length - trimmed.length >= 2 || trimmed.endsWith('\\');
      const line = trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed;
      t += k === 0 ? line.trimStart() : (/\n$/.test(t) ? '' : ' ') + line.trimStart();
      if (hard && k < para.lines.length - 1) t += '\n';
    });
    const out = inlineText(t);
    if (out.trim()) (para.note ? notes : blocks).push(makeBlock(para.type, (para.prefix || '') + out, { source: 'markup' }));
    para = null;
  };
  const flushCode = () => {
    if (code && code.some((l) => l.trim())) blocks.push(makeBlock('code', code.join('\n'), { skip: 'code' }));
    code = null;
  };

  for (let n = 0; n < lines.length; n++) {
    if (pause && n % 2000 === 0) await pause();
    let line = lines[n];
    if (fence) {
      const t = line.trim();
      if (/^ {0,3}[`~]/.test(line) && t.length >= fence.mark.length && t === fence.mark[0].repeat(t.length)) {
        blocks.push(makeBlock('code', fence.lines.join('\n'), { skip: 'code' }));
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    // Block quotes: strip the markers and remember we are inside one.
    let inQuote = false;
    const q = /^ {0,3}>[ \t]?/.exec(line);
    if (q) {
      inQuote = true;
      line = line.slice(q[0].length);
      line = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    }
    if (inQuote !== quote) {
      flush();
      quote = inQuote;
    }
    if (!line.trim()) {
      flush();
      if (code) code.push('');
      continue;
    }
    if (code && /^(?: {4}|\t)/.test(line)) {
      code.push(line.replace(/^(?: {4}|\t)/, ''));
      continue;
    }
    flushCode();
    // a <script>, <style>, <template> or <noscript> block, blank lines and all, up to its end tag
    const hb = /^ {0,3}<(script|style|template|noscript)(?=[\s>]|$)/i.exec(line);
    if (hb) {
      const close = '</' + hb[1].toLowerCase();
      let end = n;
      while (end < lines.length && !lines[end].toLowerCase().includes(close, end === n ? hb[0].length : 0)) end++;
      if (end < lines.length) {
        flush();
        n = end;
        continue;
      }
    }
    const f = FENCE.exec(line);
    if (f && !(f[1][0] === '`' && line.slice(f[0].length).includes('`'))) {
      flush();
      fence = { mark: f[1], lines: [] };
      continue;
    }
    if (ATX.test(line)) {
      flush();
      const h = atxText(line);
      if (h.text) blocks.push(makeBlock(quote ? 'quote' : 'h' + h.level, inlineText(h.text)));
      continue;
    }
    if (para && para.type === 'p' && !para.note && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      // setext heading underline
      const t = inlineText(para.lines.join(' ').trim());
      para = null;
      if (t) blocks.push(makeBlock(/=/.test(line) ? 'h1' : 'h2', t));
      continue;
    }
    if (HR.test(line)) {
      flush();
      continue;
    }
    const fd = FOOTDEF.exec(line);
    if (fd) {
      flush();
      para = { type: 'note', lines: [line.slice(fd[0].length)], note: true, prefix: '' };
      continue;
    }
    if (REFDEF.test(line) && (!para || para.note)) {
      flush(); // link reference definitions are not read
      continue;
    }
    // Pipe table: a header row followed by a delimiter row.
    if (line.includes('|') && n + 1 < lines.length && isTableRule(lines[n + 1])) {
      flush();
      const table = tables++;
      let row = 0;
      splitRow(line).forEach((cell, col) => cell && blocks.push(makeBlock('cell', inlineText(cell), { cell: { table, row, col } })));
      n++;
      while (n + 1 < lines.length && lines[n + 1].includes('|') && lines[n + 1].trim()) {
        n++;
        row++;
        splitRow(lines[n]).forEach((cell, col) => cell && blocks.push(makeBlock('cell', inlineText(cell), { cell: { table, row, col } })));
      }
      continue;
    }
    const li = LIST.exec(line);
    if (li && !(para && para.type === 'p' && /^\d/.test(li[2]) && li[2] !== '1.' && li[2] !== '1)')) {
      flush();
      const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2);
      counters.length = depth + 1;
      let prefix = '';
      if (/^\d/.test(li[2])) {
        const num = parseInt(li[2], 10);
        counters[depth] = counters[depth] != null ? counters[depth] + 1 : num;
        prefix = counters[depth] + li[2].slice(-1) + ' ';
      } else counters[depth] = undefined;
      para = { type: quote ? 'quote' : 'li', lines: [line.slice(li[0].length)], prefix };
      continue;
    }
    if (!para && !quote && /^(?: {4}|\t)/.test(line) && !(blocks.length && blocks[blocks.length - 1].type === 'li')) {
      code = [line.replace(/^(?: {4}|\t)/, '')];
      continue;
    }
    if (para) {
      para.lines.push(line);
      continue;
    }
    counters.length = 0;
    para = { type: quote ? 'quote' : 'p', lines: [line] };
  }
  flush();
  flushCode();
  if (fence && fence.lines.length) blocks.push(makeBlock('code', fence.lines.join('\n'), { skip: 'code' }));
  if (notes.length) {
    blocks.push(makeBlock('h2', 'Notes'));
    notes.forEach((b, k) => blocks.push(makeBlock('note', k + 1 + '. ' + b.text)));
  }
  const src = (ctx && ctx.source) || 'markup';
  for (const b of blocks) b.source = src;
  return { title, blocks, warnings: [] };
}

// Does plain text look like Markdown? (used when a file has no telling name)
export function looksLikeMarkdown(text) {
  const s = String(text).slice(0, 20000);
  let score = 0;
  if (/^ {0,3}#{1,6} \S/m.test(s)) score++;
  if (/\[[^\]\n]{1,200}\]\([^)\s]{1,500}\)/.test(s)) score++;
  if (/^ {0,3}(?:```|~~~)/m.test(s)) score++;
  if (/(?:^|\s)\*\*[^*\n]{1,100}\*\*(?=\s|[.,;:!?]|$)/m.test(s)) score++;
  if (/^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|/m.test(s)) score++;
  if (/^ {0,3}(?:[-*+]|\d{1,3}\.) \S/m.test(s) && /^ {0,3}#{1,6} \S/m.test(s)) score++;
  return score >= 2;
}
