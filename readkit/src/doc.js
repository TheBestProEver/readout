// Doc and Block: the one shape every input becomes (see DESIGN.md, "Data types").
// Also turns plain text into blocks, and blocks back into plain text.

const TYPES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'quote', 'cell', 'caption', 'note', 'code']);

/* ---------- text cleanup for display ---------- */

const BREAKS = /\r\n?|[\v\f\u0085\u2028\u2029]/g;
// Soft hyphens, zero-width spaces, word joiners, BOMs and bidi controls are invisible in print
// but break words apart for a voice.
const INVISIBLE = /[\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;
const PRIVATE = /[\ue000-\uf8ff]/g; // symbol-font leftovers with no meaning outside the font
const SPACES = /[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

// Single spaces, no blank lines inside a block. A lone '\n' survives: it marks a real
// line break (an address, a poem, <br>), never a hard wrap.
export function cleanText(text) {
  let s = text == null ? '' : String(text);
  if (!s) return '';
  s = s.replace(BREAKS, '\n').replace(INVISIBLE, '').replace(CONTROL, '').replace(PRIVATE, '').replace(SPACES, ' ');
  s = s.replace(/ {2,}/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(s)) s = s.normalize('NFC');
  return s;
}

// Code keeps its line structure and indentation.
function cleanCode(text) {
  let s = text == null ? '' : String(text);
  s = s.replace(BREAKS, '\n').replace(INVISIBLE, '').replace(CONTROL, '').replace(PRIVATE, '').replace(/\t/g, '  ').replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  s = s.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n');
  return s.replace(/^\n+/, '').trimEnd();
}

// Words: a letter or digit, then letters, digits, marks, apostrophes, dots and hyphens ("3.5",
// "well-known", "don't" are one word each). A scan rather than a regex match: a novel is counted
// in a few milliseconds.
const WORDISH = /[\p{L}\p{N}]/u;
const JOINER = /[\p{M}'’.-]/u;
export function countWords(text, max) {
  const s = String(text || '');
  const limit = max || Infinity;
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // second half of a pair, judged with the first
    let word;
    if (c < 128) word = (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122);
    else word = WORDISH.test(s[i]) || (c >= 0xd800 && c <= 0xdbff && WORDISH.test(s.slice(i, i + 2)));
    if (word) {
      if (!inWord) {
        if (++n >= limit) return n;
        inWord = true;
      }
    } else if (!inWord || !(c === 39 || c === 46 || c === 45 || (c >= 128 && JOINER.test(s[i])))) inWord = false;
  }
  return n;
}

/* ---------- Block and Doc ---------- */

// makeBlock(type, text, { page, source, conf, skip }) or makeBlock({ type, text, ... })
export function makeBlock(type, text, extra) {
  if (type && typeof type === 'object') return makeBlock(type.type, type.text, type);
  let t = TYPES.has(type) ? type : 'p';
  if (!TYPES.has(type) && /^h\d$/.test(type || '')) t = 'h6';
  const b = { type: t, text: t === 'code' ? cleanCode(text) : cleanText(text), source: (extra && extra.source) || 'markup' };
  if (extra) {
    if (extra.page > 0) b.page = extra.page;
    if (typeof extra.conf === 'number') b.conf = extra.conf;
    if (extra.skip) b.skip = extra.skip;
    if (extra.cell && t === 'cell') b.cell = { table: extra.cell.table, row: extra.cell.row, col: extra.cell.col };
  }
  return b;
}

export function makeDoc(fields) {
  const f = fields || {};
  const blocks = f.blocks || [];
  const stats = Object.assign({ pages: 0, ocrPages: 0, words: 0, lowConfidenceWords: 0, droppedTokens: 0 }, f.stats);
  if (!(f.stats && typeof f.stats.words === 'number')) stats.words = blocks.reduce((n, b) => n + (b.skip ? 0 : countWords(b.text)), 0);
  return { id: f.id || '', title: f.title || '', kind: f.kind || 'text', blocks, warnings: f.warnings || [], stats };
}

// List items already numbered in the source ("3. Stir", "b) Bake") keep their own marker.
const OWN_MARKER = /^(?:\d{1,4}(?:\.\d{1,3})*|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,7})[.)]\s/;

// For apps that store plain text: a blank line between blocks, list items prefixed with
// '• ', skipped blocks (headers, captions, code...) left out unless keepSkipped.
export function docToText(doc, opts) {
  const keep = !!(opts && opts.keepSkipped);
  const blocks = Array.isArray(doc) ? doc : (doc && doc.blocks) || [];
  const out = [];
  for (const b of blocks) {
    if (!b || !b.text || (b.skip && !keep)) continue;
    out.push(b.type === 'li' && !OWN_MARKER.test(b.text) ? '• ' + b.text : b.text);
  }
  return out.join('\n\n');
}

// Sections of sources rather than prose ("References", "Bibliography", "Further reading"...):
// the heading and everything under it, up to the next heading of the same or a higher level,
// are marked skip: 'citation'. A voice reading 120 references aloud is never what anyone wants.
const REFERENCE_HEADING = /^(?:\d{1,2}(?:\.\d{1,2})*\.?\s+)?(?:references|reference list|bibliography|select bibliography|works cited|literature cited|sources|citations|further reading|external links|notes and references|references and notes|sources and further reading)[\s.:]*$/i;
export function markReferences(blocks) {
  let level = 0;
  for (const b of blocks) {
    const h = /^h([1-6])$/.exec(b.type);
    if (h) {
      if (level && +h[1] <= level) level = 0;
      if (!level && REFERENCE_HEADING.test(b.text)) level = +h[1];
    }
    if (level && !b.skip) b.skip = 'citation';
  }
  return blocks;
}

/* ---------- plain text -> blocks ---------- */

const BULLET = /^[ \t]*[-*+•◦▪▫‣⁃●○■□►▸➢➤–—][ \t]+(?=\S)/;
const ORDINAL = /^[ \t]*\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{2,6})[.)][ \t]+(?=\S)/;
const SECTION = /^(\d{1,3}(?:\.\d{1,3}){1,4})\.?[ \t]+(?=\S)/;
const RULE = /^[ \t]*(?:[-*_=~#•·.][ \t]*){3,}$/;
// "Chapter 3", "CHAPTER IV.", "Part Two: The Return", "Letter 1"
const CHAPTER_NUM = /^(?:chapter|part|book|section|act|scene|volume|canto|letter|stave)[ \t]+(?:\d{1,4}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[a-z]{3,6}teen|twenty|thirty|forty|fifty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\b/i;
// Front and back matter that stands as a heading on its own: "PREFACE.", "Contents"
const MATTER = /^(?:prologue|epilogue|preface|foreword|introduction|afterword|appendix|contents|table of contents|acknowledg(?:e)?ments|glossary|bibliography|references|notes|dedication)[ \t.:]*$/i;
const TERMINAL = /[.!?…:;,]["'”’)\]]*$/;
const GUTENBERG_START = /^\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG/i;
const GUTENBERG_END = /^\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i;

function isAllCaps(s) {
  return /\p{Lu}.*\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
}

// "# Title" and "## Title ##" (Markdown habits are common in plain notes)
function atx(line) {
  const m = /^[ \t]{0,3}(#{1,6})[ \t]+(?=\S)/.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trimEnd();
  let k = text.length;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k < text.length && (k === 0 || text[k - 1] === ' ' || text[k - 1] === '\t')) text = text.slice(0, k).trimEnd();
  return text ? { level: m[1].length, text } : null;
}

// Heading level for a line standing alone between blank lines, or 0 if it reads like a sentence.
function headingLevel(line, first) {
  const s = line.trim();
  if (s.length > 90 || !/\p{L}/u.test(s) || /^\p{Ll}/u.test(s)) return 0;
  if (s.split(/\s+/).length > 12) return 0;
  const sec = SECTION.exec(s);
  if (sec && !TERMINAL.test(s)) return Math.min(6, sec[1].split('.').length + 1);
  if ((CHAPTER_NUM.test(s) && s.length <= 70) || MATTER.test(s)) return first ? 1 : 2;
  if (isAllCaps(s) && s.length <= 70 && !/[,;]$/.test(s)) return first ? 1 : 2;
  if (TERMINAL.test(s) && !/\?["'”’)]*$/.test(s)) return 0;
  return first ? 1 : 2;
}

// Is the newline between two lines of one paragraph a hard wrap (so a space) or meant (kept)?
function softBreak(prev, next, width) {
  if (/^["'“‘(]?\p{Ll}/u.test(next)) return true;
  if (TERMINAL.test(prev)) return width >= 50 && prev.length >= width * 0.75;
  return prev.length >= Math.max(40, width * 0.7);
}

// Appends a wrapped line. A word hyphenated across the wrap is rejoined when the dictionary
// says so, otherwise the hyphen stays ("well-known").
function joinWrapped(text, prevLine, next, words) {
  if (prevLine.endsWith('-') && /^\p{Ll}/u.test(next)) {
    let k = prevLine.length - 1;
    while (k > 0 && /\p{L}/u.test(prevLine[k - 1])) k--;
    const head = prevLine.slice(k, -1);
    const tail = /^\p{L}+/u.exec(next)[0];
    if (head && words && words.has(head + tail)) {
      // "every-/one" -> "everyone", but "re-/sign" stays: when both halves are words too, the
      // joined word must be common enough to be the likelier reading.
      const halves = words.has(head) && words.has(tail);
      const common = halves && typeof words.freq === 'function' && words.freq(head + tail) * 50 >= Math.min(words.freq(head), words.freq(tail));
      if (!halves || common) return text.slice(0, -1) + next;
    }
    return text + next;
  }
  return text + ' ' + next;
}

function listMarker(line) {
  const b = BULLET.exec(line);
  if (b) return { bullet: true, len: b[0].length };
  const o = ORDINAL.exec(line);
  if (o) return { bullet: false, len: o[0].length };
  return null;
}

// Splits one group of lines (no blank line between them) into blocks.
function groupBlocks(lines, opts, first, nextIsBody) {
  const out = [];
  const width = lines.reduce((w, l) => Math.max(w, l.trim().length), 0);
  const words = opts.words;

  // Setext heading: a line underlined with === or ---
  if (lines.length === 2 && /^[ \t]*(?:={2,}|-{2,})[ \t]*$/.test(lines[1]) && lines[0].trim() && !listMarker(lines[0])) {
    return [{ type: /=/.test(lines[1]) ? 'h1' : 'h2', text: lines[0] }];
  }
  if (lines.length === 1) {
    const s = lines[0];
    if (RULE.test(s)) return out;
    const h = atx(s);
    if (h) return [{ type: 'h' + h.level, text: h.text }];
    const lvl = nextIsBody || first ? headingLevel(s, first) : 0;
    const t = s.trim();
    if (lvl && (!listMarker(s) || SECTION.test(t) || CHAPTER_NUM.test(t))) return [{ type: 'h' + lvl, text: s }];
  }

  let cur = null;
  const push = () => {
    if (cur && cur.text.trim()) out.push(cur);
    cur = null;
  };
  // Ordinal markers ("a.", "2)") only make list items when the group has more than one.
  const ordinals = lines.filter((l) => !BULLET.test(l) && ORDINAL.test(l)).length;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (RULE.test(raw)) {
      push();
      continue;
    }
    const h = atx(raw);
    if (h) {
      push();
      out.push({ type: 'h' + h.level, text: h.text });
      continue;
    }
    if (line[0] === '>') {
      const text = line.replace(/^(?:>[ \t]?)+/, '');
      if (cur && cur.type === 'quote') {
        if (text) cur.text = cur.text ? joinWrapped(cur.text, cur.last, text, words) : text;
        cur.last = text;
      } else {
        push();
        cur = { type: 'quote', text, last: text };
      }
      continue;
    }
    const mark = listMarker(raw);
    if (mark && (mark.bullet || ordinals > 1 || (cur && cur.type === 'li'))) {
      push();
      // Bullets are dropped (docToText adds its own); numbers and letters are part of the text.
      const text = mark.bullet ? raw.slice(mark.len).trim() : line;
      cur = { type: 'li', text, last: text };
      continue;
    }
    if (!cur || cur.type === 'quote') {
      push();
      cur = { type: 'p', text: line, last: line };
      continue;
    }
    const prev = cur.last;
    // In hard-wrapped prose, a short line ending a sentence, then a capital, closes the paragraph.
    const shortEnd = width >= 50 && lines.length >= 3 && prev.length < width * 0.6 && TERMINAL.test(prev) && /^["'“‘(]?\p{Lu}/u.test(line);
    // Paragraphs marked by indenting their first line instead of a blank line.
    const indented = /^(?: {2,}|\t)\S/.test(raw) && TERMINAL.test(prev) && !/^(?: {2,}|\t)/.test(lines[0]);
    if (cur.type === 'p' && (shortEnd || indented)) {
      push();
      cur = { type: 'p', text: line, last: line };
      continue;
    }
    cur.text = cur.type === 'li' || softBreak(prev, line, width) ? joinWrapped(cur.text, prev, line, words) : cur.text + '\n' + line;
    cur.last = line;
  }
  push();
  return out;
}

// Blocks for each blank-line-separated group of lines, in order.
function* textGroups(text, o) {
  const lines = String(text == null ? '' : text)
    .replace(/^\ufeff/, '')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/\f/g, '\n\n')
    .split('\n');
  // Group lines into runs separated by blank lines.
  const groups = [];
  let g = [];
  for (const l of lines) {
    const t = l.trimEnd();
    if (!t.trim()) {
      if (g.length) groups.push(g);
      g = [];
    } else g.push(t);
  }
  if (g.length) groups.push(g);

  // Project Gutenberg's licence header and footer are kept but marked skippable.
  let start = -1;
  let end = -1;
  for (let i = 0; i < groups.length; i++) {
    const s = groups[i][0].trim();
    if (start < 0 && GUTENBERG_START.test(s)) start = i;
    else if (start >= 0 && GUTENBERG_END.test(s)) {
      end = i;
      break;
    }
  }

  const isBody = (grp) => !!grp && (grp.length > 1 || grp[0].trim().length > 80) && !RULE.test(grp[0]) && !atx(grp[0]);
  let first = true;
  for (let i = 0; i < groups.length; i++) {
    const skip = start >= 0 && i <= start ? 'header' : end >= 0 && i >= end ? 'footer' : undefined;
    const out = [];
    for (const b of groupBlocks(groups[i], o, first && !skip, isBody(groups[i + 1]))) {
      const block = makeBlock(b.type, b.text, { source: o.source, page: o.page, skip });
      if (!block.text) continue;
      out.push(block);
      if (!skip) first = false;
    }
    yield out;
  }
}

// Plain text -> blocks: headings, list items and paragraphs, with hard wraps undone.
// opts: { source = 'text', page, words (from loadWords(), to check words hyphenated at a wrap) }
export function textToBlocks(text, opts) {
  const blocks = [];
  for (const list of textGroups(text, Object.assign({ source: 'text' }, opts))) for (const b of list) blocks.push(b);
  return blocks;
}

// The same, giving the page back now and then (pause from formats/util.js makePause) for big files.
export async function textToBlocksAsync(text, opts, pause) {
  const blocks = [];
  let n = 0;
  for (const list of textGroups(text, Object.assign({ source: 'text' }, opts))) {
    for (const b of list) blocks.push(b);
    if (pause && ++n % 32 === 0) await pause();
  }
  return blocks;
}
