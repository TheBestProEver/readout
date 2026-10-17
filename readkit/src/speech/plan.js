// plan(): text or a Doc -> the segments a voice reads, in order.
//
// Segment = { index, start, end, spoken, kind, pauseAfterMs, align }
//   start/end   the segment's characters in the source text (display = text.slice(start, end));
//               for a Doc the source text is docToText(doc, { keepSkipped })
//   spoken      what the voice says ('Dr. Patel paid $5' -> 'Doctor Patel paid five dollars.')
//   kind        'sentence' | 'heading' | 'item'
//   pauseAfterMs  extra silence: end of paragraph 700, heading 500, list item 350, else 0
//   align       [[spokenStart, spokenEnd, srcStart, srcEnd], ...]: one entry per spoken word,
//               or per group of words said for one source token ('five dollars' <- '$5')
//
// opts: { dialect, skip: { citations, urls, footnoteMarks, blocks, code }, lexicon, keepSkipped,
//         maxChars (300), pauses: { paragraph, heading, item, sentence }, dateOrder, words }
// Blocks with a `skip` reason ('header', 'footer', 'footnote', 'margin', 'citation', 'caption',
// 'code') are left out unless keepSkipped, which keeps them in the text and reads them.
// skip.blocks overrides what is read: true leaves out every skipped block (keepSkipped then only
// gives the offsets of the full text), false reads them, an array lists the reasons to leave out.
// Code blocks (type 'code') are never read unless skip.code is false.

import { Tracked } from './tracked.js';
import { makeContext, verbalizeTracked } from './verbalize.js';
import { splitSentences } from './split.js';
import { romanHeading } from './rules/roman.js';
import { cardinal, romanValue } from './numbers.js';
import { docToText } from '../doc.js';

const PAUSES = { paragraph: 700, heading: 500, item: 350, sentence: 0 };
const MAX_CHARS = 300;
const KIND = { h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', li: 'item', cell: 'item' };
// docToText's rule for list items that carry their own number ('3. Stir', 'b) Bake').
const OWN_MARKER = /^(?:\d{1,4}(?:\.\d{1,3})*|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,7})[.)]\s/;

/* ---------- blocks ---------- */

function docBlocks(doc, keep) {
  const blocks = [];
  let text = '';
  for (const b of doc.blocks || []) {
    if (!b || !b.text || (b.skip && !keep)) continue;
    if (text) text += '\n\n';
    const prefix = b.type === 'li' && !OWN_MARKER.test(b.text) ? '• ' : '';
    const start = text.length;
    text += prefix + b.text;
    blocks.push({ start, body: start + prefix.length, end: text.length, kind: KIND[b.type] || 'paragraph', type: b.type, skip: b.skip, page: b.page });
  }
  return { text, blocks };
}

const BULLET = /^[ \t]*[-*+•◦▪▫‣⁃●○■□►▸➢➤–—][ \t]+(?=\S)/;
const ORDERED = /^[ \t]*\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{2,6})[.)][ \t]+(?=\S)/;
const ATX = /^[ \t]{0,3}#{1,6}[ \t]+(?=\S)/;
const SETEXT = /^[ \t]*(?:={2,}|-{2,})[ \t]*$/;
const RULE = /^[ \t]*(?:[-*_=~#•·.][ \t]*){3,}$/;
const TERMINAL = /[.!?…,;]["'”’)\]]*$/;

// A line standing alone that reads like a title rather than a sentence.
function headingLike(line) {
  const s = line.trim();
  if (s.length > 90 || !/\p{L}/u.test(s) || /^\p{Ll}/u.test(s) || s.split(/\s+/).length > 12) return false;
  if (/\p{Lu}.*\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s)) return !/[,;]$/.test(s);
  return !TERMINAL.test(s) && !/:$/.test(s);
}

// Divisions as old books print them, full stop and all ('BOOK II.', 'CHAPTER IV.', 'CHAP. III.'),
// which extractors may hand over as plain paragraphs.
const DIVISION = /^(?:book|chapter|chap\.?|part|section|sect\.?|article|art\.|volume|vol\.|canto|letter|lecture|stave)\s+(?:\d{1,4}|[ivxlc]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*[.:]?$/i;
function divisionLike(s) {
  return s.length <= 40 && DIVISION.test(s);
}

// The title under a chapter heading: one short line in title case ('Of the Wages of Labour.')
function titleLike(s) {
  if (s.length > 120 || s.includes('\n') || !/^["'“‘(]?\p{Lu}/u.test(s) || /[.!?;:](?=\s)/u.test(s)) return false;
  const long = s.split(/\s+/).filter((w) => /^["'“‘(]?\p{L}{4,}/u.test(w));
  return long.length >= 2 && long.filter((w) => /^["'“‘(]?\p{Lu}/u.test(w)).length >= 0.6 * long.length;
}

const capsLine = (s) => s.length <= 70 && /\p{Lu}.*\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s) && !/[,;]$/.test(s) && !/[.!?](?=\s)/u.test(s);

// Paragraph blocks that are really headings: numbered divisions, short lines in capitals, and
// the title line right under such a heading.
const OPEN_END = /\s(?:the|a|an|of|to|in|on|and|or|but|that|which|who|with|for|from|by|as|at|is|was|be|his|her|their|its|our|this|these|those)$/i;
function inferHeadings(text, blocks) {
  let prev = null;
  blocks.forEach((b, i) => {
    if (b.skip) return;
    // a line taken for a heading in plain text that runs on into the next block is prose
    if (b.guess) {
      const next = blocks[i + 1];
      const line = text.slice(b.body, b.end).trim();
      if (OPEN_END.test(line) || (next && /^["'“‘(]?\p{Ll}/u.test(text.slice(next.body, next.body + 3)))) b.kind = 'paragraph';
    }
    if (b.kind === 'paragraph' && (!b.type || b.type === 'p')) {
      const s = text.slice(b.body, b.end).trim();
      if (divisionLike(s) || (b.type && capsLine(s)) || (prev && prev.division && titleLike(s))) b.kind = 'heading';
    }
    if (b.kind === 'heading') {
      const h = text.slice(b.body, b.end).trim();
      b.division = divisionLike(h) || !!romanHeading(h) || capsLine(h);
    }
    prev = b;
  });
  return blocks;
}

function groupBlocks(s, lines, out) {
  let cur = null;
  const push = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  const ordinals = lines.filter(([a, b]) => ORDERED.test(s.slice(a, b))).length;
  const first = out.length;
  for (let k = 0; k < lines.length; k++) {
    const [a, b] = lines[k];
    const line = s.slice(a, b);
    const lead = /^[ \t]*/.exec(line)[0].length;
    if (k + 1 < lines.length && !cur && SETEXT.test(s.slice(lines[k + 1][0], lines[k + 1][1])) && !BULLET.test(line)) {
      out.push({ start: a + lead, body: a + lead, end: b, kind: 'heading' });
      k++;
      continue;
    }
    if (RULE.test(line)) {
      push();
      continue;
    }
    const h = ATX.exec(line);
    if (h) {
      push();
      out.push({ start: a + lead, body: a + h[0].length, end: b, kind: 'heading' });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet || (ORDERED.test(line) && (ordinals > 1 || (cur && cur.kind === 'item')))) {
      push();
      cur = { start: a + lead, body: bullet ? a + bullet[0].length : a + lead, end: b, kind: 'item' };
      continue;
    }
    if (cur) cur.end = b;
    else cur = { start: a + lead, body: a + lead, end: b, kind: 'paragraph' };
  }
  push();
  // a lone short line without a full stop is a heading
  if (lines.length === 1 && out.length === first + 1 && out[first].kind === 'paragraph' && headingLike(s.slice(lines[0][0], lines[0][1]))) Object.assign(out[first], { kind: 'heading', guess: true });
}

// Plain text -> blocks with offsets: blank lines separate blocks; '#' and underlined lines
// are headings; '-', '*', '•' and numbered lines are list items.
function textBlocks(s) {
  const blocks = [];
  let group = [];
  const flush = () => {
    if (group.length) groupBlocks(s, group, blocks);
    group = [];
  };
  let i = 0;
  while (i <= s.length) {
    let j = s.indexOf('\n', i);
    if (j < 0) j = s.length;
    let e = j;
    while (e > i && /\s/.test(s[e - 1])) e--;
    if (e > i && /\S/.test(s.slice(i, e))) group.push([i, e]);
    else flush();
    i = j + 1;
  }
  flush();
  return blocks;
}

// Line breaks inside a block that end a line of their own (an address, a poem, an email
// header, 'Thanks,\nJane'), as opposed to hard wraps in the middle of a sentence. In a Doc
// every line break is meant; in plain text a short line followed by a capital is.
function lineRuns(text, a, b, meant) {
  if (!text.slice(a, b).includes('\n')) return [[a, b]];
  const lines = [];
  for (let i = a; i < b; ) {
    let j = text.indexOf('\n', i);
    if (j < 0 || j > b) j = b;
    lines.push([i, j]);
    i = j + 1;
  }
  const width = lines.reduce((w, [x, y]) => Math.max(w, y - x), 0);
  const runs = [];
  let start = a;
  for (let k = 0; k + 1 < lines.length; k++) {
    const prev = text.slice(lines[k][0], lines[k][1]).trim();
    const next = text.slice(lines[k + 1][0], lines[k + 1][1]).trim();
    const wrapped = !meant && (/^["'“‘(]?\p{Ll}/u.test(next) || prev.length >= Math.max(40, width * 0.7) || /[-–]$/.test(prev));
    if (prev && !wrapped) {
      runs.push([start, lines[k][1]]);
      start = lines[k + 1][0];
    }
  }
  runs.push([start, b]);
  return runs;
}

function skipped(block, opts) {
  const sk = opts.skip || {};
  const keep = !!opts.keepSkipped;
  if (block.type === 'code' && sk.code !== false) return true;
  if (!block.skip) return false;
  const rule = sk.blocks === undefined ? !keep : sk.blocks;
  if (Array.isArray(rule)) return rule.includes(block.skip);
  return !!rule;
}

// Does paragraph B carry on the sentence paragraph A leaves unfinished? Signs: A stops without
// punctuation and B starts in lower case (or comes over a page break); A ends on an amount or
// a reference that B's number completes ('was 47s.' | '6d. the quarter', 'ch.' | 'III, and').
const CUE_END = /(?:^|\s)(?:ch|chap|vol|vols|p|pp|pt|sect|art|no|book|part|chapter|volume|section)\.?$/i;
function joinable(text, A, B) {
  if (A.kind !== 'paragraph' || B.kind !== 'paragraph') return false;
  const a = text.slice(A.body, A.end).trimEnd();
  const b = text.slice(B.body, B.end).trimStart();
  const pageBreak = A.page > 0 && B.page > 0 && A.page !== B.page;
  const unfinished = a.length >= 40 && /[\p{L}\p{N},\-–—]$/u.test(a);
  const lowerNext = /^["'“‘(]?\p{Ll}/u.test(b);
  if (unfinished && (lowerNext || pageBreak)) return true;
  if (pageBreak && lowerNext) return true;
  if (/\d[ls]\.$/.test(a) && /^\d{1,2}(?:\s?[½¼¾]|\s?1⁄[24])?\s?[sd]\.(?!\w)|^[½¼¾]d\./.test(b)) return true;
  return CUE_END.test(a) && /^(?:\d|[IVXLC]+\b|[ivxlc]+\b)/.test(b);
}

/* ---------- one sentence ---------- */

const PIECE = /[;:,](?=\s)|\s[—–]\s|\s+/g;
const DIGIT_WORD = /(?:^|\s)(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)$/;
const SCALE_WORD = /(?:hundred|thousand|million|billion|trillion)$/;
const CONJ = /^\s*(?:and|but|or|nor|so|yet|which|who|whom|whose|where|while|whereas|although|though|because|since|unless|until|when|if|then|that)\s/;

// Where to break a spoken sentence longer than `max`: at ; : — first, then a comma before a
// conjunction, a comma, a space before a conjunction, any space. Never inside a phone number
// group or between 'one hundred' and 'and five'.
function clauseCuts(s, max) {
  const cuts = [];
  let a = 0;
  while (s.length - a > max) {
    const lo = a + Math.floor(max * 0.4);
    const hi = a + max;
    let best = -1;
    let rank = -1;
    PIECE.lastIndex = lo;
    for (let m = PIECE.exec(s); m && m.index <= hi; m = PIECE.exec(s)) {
      const c = m[0];
      const before = s.slice(Math.max(0, m.index - 12), m.index);
      const rest = s.slice(m.index + c.length, m.index + c.length + 12);
      let r;
      let at;
      if (c === ';' || c === ':' || /[—–]/.test(c)) [r, at] = [4, m.index + (c.length === 1 ? 1 : 0)];
      else if (c === ',') {
        r = DIGIT_WORD.test(before) && /^\s*(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/.test(rest) ? 0 : CONJ.test(rest) ? 3 : 2;
        at = m.index + 1;
      } else {
        r = CONJ.test(rest + ' ') && !SCALE_WORD.test(before) ? 1 : 0;
        at = m.index;
      }
      if (r >= rank) [best, rank] = [at, r];
    }
    if (best <= a) best = hi;
    cuts.push([a, best]);
    a = best;
    while (a < s.length && /\s/.test(s[a])) a++;
  }
  cuts.push([a, s.length]);
  return cuts;
}

const LETTER = /[\p{L}\p{N}]/u;

// Word alignment for spoken [p, q) of t: spoken offsets relative to p, source offsets
// clamped to the segment. Words said for the same source characters share one entry.
function alignOf(t, p, q, lo, hi) {
  const out = [];
  const re = /\S+/g;
  re.lastIndex = p;
  for (let m = re.exec(t.s); m && m.index < q; m = re.exec(t.s)) {
    let ws = m.index;
    let we = Math.min(q, ws + m[0].length);
    while (ws < we && !LETTER.test(t.s[ws])) ws++;
    while (we > ws && !LETTER.test(t.s[we - 1])) we--;
    if (we <= ws) continue;
    let [sa, sb] = t.range(ws, we);
    sa = Math.min(Math.max(sa, lo), hi);
    sb = Math.min(Math.max(sb, sa), hi);
    const prev = out[out.length - 1];
    const empty = sb <= sa;
    if (prev) {
      const prevEmpty = prev[3] <= prev[2];
      // inserted words ('the' in 'Henry the Eighth') and words for the same source token join the entry before
      if (empty || prevEmpty || sa < prev[3]) {
        prev[1] = we - p;
        if (prevEmpty && !empty) [prev[2], prev[3]] = [sa, sb];
        else if (!empty) prev[3] = Math.max(prev[3], sb);
        continue;
      }
    }
    out.push([ws - p, we - p, sa, sb]);
  }
  return out;
}

function sayMarker(m) {
  const core = m.replace(/[().\s]/g, '');
  if (/^\d+$/.test(core)) return cardinal(core);
  if (/^[ivxlc]{2,}$/i.test(core) && romanValue(core)) return cardinal(romanValue(core));
  return core.toUpperCase();
}

const RUN_ON = /^\s*["'“‘(]?(?:\p{Ll}|(?:And|But|Or|Nor|So|Yet|For|With|To|Of|In|That|Which|Who|Where|When|While|As|Than|Like|Upon|Till|Until|Though|Through|From)\b)/u;

function finish(t, runOn) {
  // headings, list items and unpunctuated lines end with a full stop, so the voice lets them
  // fall; a line that runs on into the next gets a comma
  if (!/[.!?…:;,]["'”’)\]]*$/.test(t.s)) t.replace(/[\p{L}\p{N}"'”’)\]]$/u, (m) => m[0] + (runOn ? ',' : '.'));
  // 'nineteen ninety was...' -> 'Nineteen ninety was...'
  t.replace(/^(["'“‘(]*)(\p{Ll})(?=\p{Ll}*(?:[\s,.;:!?'’-]|$))/u, (m) => [[m[1], 0, m[1].length], [m[2].toUpperCase(), m[1].length, m[0].length]]);
  return t;
}

/* ---------- plan ---------- */

export function plan(input, opts = {}) {
  const ctx = makeContext(opts);
  const pauses = Object.assign({}, PAUSES, opts.pauses);
  const max = Math.max(60, opts.maxChars || MAX_CHARS);
  let text;
  let blocks;
  if (input && typeof input === 'object' && Array.isArray(input.blocks)) {
    const keep = !!opts.keepSkipped;
    ({ text, blocks } = docBlocks(input, keep));
    const expected = docToText(input, { keepSkipped: keep });
    if (expected !== text) {
      text = expected;
      blocks = textBlocks(text);
    }
  } else {
    text = String(input ?? '');
    blocks = textBlocks(text);
  }
  inferHeadings(text, blocks);

  // sentences of every block that is read
  const units = [];
  for (const blk of blocks) {
    if (skipped(blk, opts)) continue;
    let a = blk.body;
    let marker = null;
    if (blk.kind === 'item') {
      const m = /^\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{2,6})[.)][ \t]+(?=\S)/.exec(text.slice(a, Math.min(blk.end, a + 12)));
      if (m) {
        marker = { said: sayMarker(m[0]) + '.', from: a, to: a + m[0].trimEnd().length };
        a += m[0].length;
      }
    } else if (blk.type === 'note') {
      // a footnote read aloud says what it is: '2. The prices are...' -> 'Note two. The prices are...'
      const m = /^(?:\d{1,3}|[*†‡§]{1,3})[.)]?[ \t]+(?=\S)/.exec(text.slice(a, Math.min(blk.end, a + 8)));
      if (m) {
        const n = /\d+/.exec(m[0]);
        marker = { said: n ? `Note ${cardinal(n[0], ctx.uk)}.` : 'Note.', from: a, to: a + m[0].trimEnd().length };
        a += m[0].length;
      }
    }
    let ranges;
    if (blk.kind === 'heading') ranges = [{ start: a, end: blk.end }];
    else {
      const runs = lineRuns(text, a, blk.end, !!blk.type);
      ranges = runs.flatMap(([x, y], k) => {
        const rs = splitSentences(text.slice(x, y)).map((r) => ({ start: r.start + x, end: r.end + x }));
        // a line of verse that runs on into the next ('Two roads diverged in a yellow wood, / And
        // sorry I could not...') gets a comma, not a full stop
        if (rs.length && k + 1 < runs.length && RUN_ON.test(text.slice(runs[k + 1][0], runs[k + 1][0] + 12))) rs[rs.length - 1].runOn = true;
        return rs;
      });
    }
    units.push({ blk, marker, ranges });
  }
  // a sentence broken across two blocks (a page break the extractor didn't mend) is read whole
  // (B's other sentences join A's paragraph too, so the paragraph pause comes at B's end)
  for (let i = 0; i + 1 < units.length; ) {
    const A = units[i];
    const B = units[i + 1];
    if (!A.ranges.length || !B.ranges.length || B.marker || !joinable(text, A.tail || A.blk, B.blk)) {
      i++;
      continue;
    }
    const ra = A.ranges.pop();
    const rb = B.ranges.shift();
    A.ranges.push({ start: ra.start, end: rb.end, pieces: [...(ra.pieces || [[ra.start, ra.end]]), [rb.start, rb.end]] }, ...B.ranges);
    A.tail = B.blk;
    units.splice(i + 1, 1);
  }

  const segs = [];
  for (const { blk, marker, ranges } of units) {
    const kind = blk.kind === 'paragraph' ? 'sentence' : blk.kind;
    const before = segs.length;
    ranges.forEach((r, k) => {
      let sa = r.start;
      const sb = r.end;
      let t;
      const roman = blk.kind === 'heading' ? romanHeading(text.slice(sa, sb)) : null;
      if (roman) t = Tracked.span(roman, sa, sb);
      else if (r.pieces) t = verbalizeTracked(Tracked.concat(r.pieces.map(([x, y]) => Tracked.of(text.slice(x, y), x))), ctx);
      else t = verbalizeTracked(Tracked.of(text.slice(sa, sb), sa), ctx);
      if (k === 0 && marker) {
        t = t.s ? Tracked.concat([Tracked.span(marker.said, marker.from, marker.to), t]) : Tracked.span(marker.said, marker.from, marker.to);
        sa = marker.from;
      }
      if (!LETTER.test(t.s)) return;
      finish(t, r.runOn);
      const cuts = t.s.length > max ? clauseCuts(t.s, max) : [[0, t.s.length]];
      let lastEnd = sa;
      cuts.forEach(([p, q], j) => {
        while (q > p && /\s/.test(t.s[q - 1])) q--;
        if (q <= p || !LETTER.test(t.s.slice(p, q))) return;
        let [start, end] = t.range(p, q);
        if (j === 0) start = sa;
        if (j === cuts.length - 1) end = sb;
        start = Math.max(start, lastEnd);
        end = Math.max(end, start);
        while (start < end && /\s/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
        lastEnd = end;
        segs.push({ index: 0, start, end, spoken: t.s.slice(p, q), kind, pauseAfterMs: pauses.sentence, align: alignOf(t, p, q, start, end) });
      });
    });
    if (segs.length > before) segs[segs.length - 1].pauseAfterMs = pauses[blk.kind] ?? pauses.paragraph;
  }
  segs.forEach((s, i) => (s.index = i));
  return segs;
}
