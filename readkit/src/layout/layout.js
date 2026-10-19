// Layout: where the text is on the page, kept as lines instead of reflowed paragraphs.
//
//   Layout = { kind, title, text, pages, lines, rows, tables, pairs, regions, warnings }
//   text     every line in reading order: the pieces of one visual row are joined with a tab,
//            rows with '\n', pages with '\n\n' (plain-text input is kept exactly as given)
//   pages    [{ page, width, height, unit: 'pt' | 'px' | 'char' }]
//   lines    [{ text, page, box: { x0, y0, x1, y1 }, conf, size, bold, heading, source,
//               start, end (offsets in text), row, region, table?: { table, row, col },
//               words: [{ text, box, conf, start, end }] }]
//            a line is a run of words on one baseline with no wide gap in it: a table cell,
//            a label, the value beside it, one line of a column
//   rows     [{ page, lines: [line indexes, left to right], box }]   lines sharing a baseline
//   tables   [{ page, box, columns: [{ x0, x1 }], header: string[] | null,
//               rows: [{ cells: [{ col, text, lines, start, end }], lines }] }]
//            cells that wrap onto a second line are joined into one cell
//   pairs    [{ key, label, value, page, line, labelSpan: [s, e], valueSpan: [s, e], how }]
//            'Date: Oct 21' (inline), a label column beside its values (column), a label
//            above its value as on flyers (stacked); key is the label's meaning
//            ('date', 'time', 'when', 'where', 'title', 'host', 'url', 'description', ...)
//   regions  [{ page, box, lines }]   reading-order blocks (a column of a flyer, a table)
//   panels   [{ page, box, overlay }]  flat-coloured cards and dialogs of a screenshot
//            (src/layout/surface.js); line.panel is the innermost one a line is on, and
//            line.underline marks a bar under the line (a selected tab, a link)
//   overlays [{ page, box, text }]   panels laid over the page (an extension popup, a menu):
//            their text is kept here and left out of lines
//
// Positioned sources (PDF text layers and OCR'd pages through src/pdf, photos through
// src/ocr) come in as pages of atoms; markup (DOCX, HTML, Markdown) as blocks whose table
// cells know their row and column; plain text as it is. Pure: runs in Node.

import { xycut } from '../ocr/layout.js';
import { readSchema } from '../calendar/schema.js';

const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

/* ---------- labels ---------- */

const LABEL_KEYS = {
  date: ['date', 'dates', 'day', 'days', 'event date', 'start date', 'date of event', 'datum', 'appointment date', 'class date', 'check-in', 'check in', 'arrival date'],
  end: ['end date', 'ends', 'end', 'end time', 'until', 'finish', 'finishes', 'check-out', 'check out', 'departure date', 'return', 'returns', 'return time', 'back by', 'pick-up', 'pickup', 'pick up', 'dismissal'],
  time: ['time', 'times', 'start time', 'starts', 'start', 'begins', 'doors', 'doors open', 'show', 'showtime', 'kick-off', 'kickoff', 'appointment time', 'arrival', 'arrive by', 'hours', 'time slot', 'slot', 'departure', 'departs', 'depart', 'departure time', 'leaves', 'leave', 'call time', 'tee time', 'check-in time', 'boarding'],
  when: ['when', 'date & time', 'date and time', 'date/time', 'date / time', 'date time', 'schedule', 'scheduled'],
  where: ['where', 'location', 'venue', 'place', 'address', 'room', 'meeting point', 'loc', 'building', 'site', 'clinic', 'office', 'theatre', 'theater', 'hall', 'stage', 'campus', 'meeting room', 'conference room', 'classroom', 'lecture hall', 'track', 'circuit', 'stadium', 'arena', 'ballpark', 'field', 'pitch', 'ground', 'rink', 'court', 'gym', 'studio', 'course location', 'meeting place', 'meeting location', 'store', 'branch', 'church', 'school', 'facility'],
  title: ['event', 'what', 'title', 'subject', 'topic', 'session', 'class', 'course', 'meeting', 'appointment', 'activity', 'program', 'programme', 'event name', 'name of event', 'occasion', 're', 'performance', 'match', 'game', 'show title', 'film', 'movie', 'service', 'services', 'service type', 'appointment type', 'type of appointment', 'visit type', 'reason for visit', 'visit reason', 'procedure', 'treatment'],
  description: ['description', 'details', 'about', 'notes', 'note', 'agenda', 'info', 'information', 'summary', 'dress code', 'bring', 'what to bring'],
  url: ['url', 'link', 'website', 'web', 'tickets', 'rsvp', 'register', 'registration', 'join', 'zoom', 'meeting link', 'join link', 'livestream', 'stream', 'more info', 'sign up'],
  host: ['host', 'hosts', 'hosted by', 'organizer', 'organiser', 'organized by', 'organised by', 'presenter', 'presenters', 'speaker', 'speakers', 'instructor', 'professor', 'teacher', 'lecturer', 'with', 'provider', 'doctor', 'physician', 'dentist', 'coach', 'leader', 'facilitator', 'moderator', 'chair', 'artist', 'performer', 'dj', 'band', 'featuring'],
  timezone: ['time zone', 'timezone', 'tz'],
  duration: ['duration', 'length', 'running time', 'run time'],
  other: ['cost', 'price', 'admission', 'entry', 'fee', 'tickets price', 'contact', 'phone', 'tel', 'email', 'e-mail', 'guests', 'party size', 'confirmation', 'confirmation number', 'confirmation code', 'reference', 'booking', 'booking reference', 'order', 'order number', 'seat', 'seats', 'row', 'section', 'gate', 'flight', 'passenger', 'patient', 'name', 'ticket', 'ticket type', 'qty', 'quantity', 'total', 'from', 'to', 'cc', 'bcc', 'sent', 'reply-to', 'meeting id', 'passcode', 'password', 'dial-in', 'dial in', 'credits', 'units', 'instructor email', 'office hours', 'prerequisites', 'textbook', 'grading', 'age', 'ages', 'parking', 'accessibility', 'food', 'refreshments', 'sponsor', 'sponsors', 'reservation', 'table', 'status'],
};
const LABELS = new Map();
for (const [key, list] of Object.entries(LABEL_KEYS)) for (const l of list) LABELS.set(l, key);

// 'Date:' / 'WHEN' / 'Location' -> 'date' / 'when' / 'where' (or null).
export function labelKey(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[:：\-–—|•·]+\s*$/, '')
    .replace(/^[\s•·*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return LABELS.get(t) || null;
}

// A heading over a flyer's column that names what it holds: a label, or 'Drop-off dates',
// 'Opening hours', 'Event location'.
export function looseLabel(s) {
  const k = labelKey(s);
  if (k) return k;
  const t = String(s || '').trim();
  if (t.length > 30 || t.split(/\s+/).length > 4) return null;
  if (/\b(?:dates?|days?)\s*[:：]?$/i.test(t)) return 'date';
  if (/\b(?:times?|hours)\s*[:：]?$/i.test(t)) return 'time';
  if (/\b(?:where|location|venue|place|address)\s*[:：]?$/i.test(t)) return 'where';
  if (/\bwhen\s*[:：]?$/i.test(t)) return 'when';
  return null;
}

// 'Date: Oct 21' -> { label, value, labelEnd, valueStart } (offsets within s)
const INLINE = /^([ \t]*)([A-Za-z][A-Za-z &/'.-]{0,30}?)[ \t]*[:：][ \t]*(?=\S)/;
function inlinePair(s) {
  const m = INLINE.exec(s);
  if (!m) return null;
  const label = m[2].trim();
  if (label.split(/\s+/).length > 4) return null;
  const key = labelKey(label);
  // an unknown label must look like one: short, capitalised ('Dress code:', 'Doors:')
  if (!key && !/^[A-Z][a-z]+(?: [a-z&/]+){0,2}$/.test(label) && !/^[A-Z][A-Z &/]{1,24}$/.test(label)) return null;
  if (/^(?:https?|mailto|tel|ftp)$/i.test(label)) return null;
  return { label, key: key || 'other', labelStart: m[1].length, labelEnd: m[1].length + m[2].length, valueStart: m[0].length };
}

/* ---------- builders ---------- */

function finishLayout(L) {
  L.pairs = L.pairs || [];
  L.tables = L.tables || [];
  L.rows = L.rows || [];
  L.regions = L.regions || [];
  L.panels = L.panels || [];
  L.overlays = L.overlays || [];
  L.warnings = L.warnings || [];
  return L;
}

// Plain text: lines as they are. A line is cut into pieces at tabs and at runs of three or
// more spaces (a form or a table typed in a fixed-width font); the text is the input itself.
export function layoutFromText(text, { kind = 'text', title = '', page = 1 } = {}) {
  const s = String(text || '');
  const L = { kind, title, text: s, pages: [{ page, width: 0, height: 0, unit: 'char' }], lines: [], rows: [], tables: [], pairs: [], regions: [] };
  let at = 0;
  let y = 0;
  let width = 0;
  const parts = s.split('\n');
  const pieces = (lineText) => {
    const out = [];
    const re = /[^\t]+?(?=\t| {3,}|$)/g;
    let m;
    while ((m = re.exec(lineText))) {
      const lead = m[0].length - m[0].trimStart().length;
      const t = m[0].trim();
      if (t) out.push({ x0: m.index + lead, t });
    }
    return out;
  };
  const cut = parts.map((raw) => pieces(raw.replace(/\r$/, '')));
  // a typed table's columns: piece starts that two rows of three or more pieces share nearby;
  // a cell that runs into the next column with only two spaces is cut there
  // ('10:30 AM  @ Comets' under '9:00 AM   vs Hawks')
  const columnsNear = (k) => {
    const count = new Map();
    for (let j = Math.max(0, k - 4); j <= Math.min(cut.length - 1, k + 4); j++) {
      if (j === k || cut[j].length < 3) continue;
      for (const p of cut[j]) count.set(p.x0, (count.get(p.x0) || 0) + 1);
    }
    return [...count.entries()].filter(([, n]) => n >= 2).map(([c]) => c);
  };
  for (const [k, raw] of parts.entries()) {
    const lineText = raw.replace(/\r$/, '');
    const row = { page, lines: [], box: { x0: 0, y0: y, x1: lineText.length, y1: y + 1 } };
    let ps = cut[k];
    if (ps.length >= 2) {
      const cols = columnsNear(k);
      if (cols.length >= 3) {
        const out = [];
        for (const p of ps) {
          let rest = p;
          for (;;) {
            const m = /\S {2}(?=\S)/g;
            let hit = null;
            let mm;
            while ((mm = m.exec(rest.t))) {
              const c = rest.x0 + mm.index + 3;
              if (cols.some((x) => Math.abs(x - c) <= 1)) {
                hit = mm.index + 1;
                break;
              }
            }
            if (!hit) break;
            out.push({ x0: rest.x0, t: rest.t.slice(0, hit).trim() });
            rest = { x0: rest.x0 + hit + 2, t: rest.t.slice(hit + 2) };
          }
          out.push(rest);
        }
        ps = out;
      }
    }
    for (const { x0, t } of ps) {
      const line = makeLine(t, page, { x0, y0: y, x1: x0 + t.length, y1: y + 1 }, at + x0, { size: 1, source: 'text' });
      row.lines.push(L.lines.length);
      L.lines.push(line);
    }
    if (row.lines.length) {
      for (const li of row.lines) L.lines[li].row = L.rows.length;
      L.rows.push(row);
    }
    width = Math.max(width, lineText.length);
    at += raw.length + 1;
    y++;
  }
  L.pages[0].width = width;
  L.pages[0].height = y;
  for (const l of L.lines) l.region = 0;
  L.regions = [{ page, box: { x0: 0, y0: 0, x1: width, y1: y }, lines: L.lines.map((_, i) => i) }];
  L.tables = textTables(L);
  L.pairs = findPairs(L);
  markHeadings(L, null);
  return finishLayout(L);
}

function makeLine(text, page, box, start, extra = {}) {
  const words = [];
  const re = /\S+/g;
  let m;
  const w = box.x1 - box.x0;
  while ((m = re.exec(text))) {
    const x0 = box.x0 + (w * m.index) / Math.max(1, text.length);
    const x1 = box.x0 + (w * (m.index + m[0].length)) / Math.max(1, text.length);
    words.push({ text: m[0], box: { x0, y0: box.y0, x1, y1: box.y1 }, conf: extra.conf != null ? extra.conf : 1, start: start + m.index, end: start + m.index + m[0].length });
  }
  return { text, page, box, conf: extra.conf != null ? extra.conf : 1, size: extra.size || 1, bold: !!extra.bold, heading: extra.heading || 0, source: extra.source || 'text', start, end: start + text.length, words, row: -1, region: -1 };
}

// Tables in plain text: runs of rows split into the same number (2+) of tab-separated pieces,
// or pieces starting at the same columns.
function textTables(L) {
  const tables = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) tables.push(gridTable(L, run, (r) => r.lines.map((li) => L.lines[li])));
    run = [];
  };
  for (let r = 0; r < L.rows.length; r++) {
    const row = L.rows[r];
    const n = row.lines.length;
    const prev = run.length ? L.rows[run[run.length - 1]] : null;
    const contiguous = prev && row.box.y0 - prev.box.y0 <= 2;
    if (n >= 2 && (!prev || (contiguous && Math.abs(n - prev.lines.length) <= 1))) run.push(r);
    else {
      flush();
      if (n >= 2) run.push(r);
    }
  }
  flush();
  return tables.filter(Boolean);
}

// A table from rows of lines that already are its cells (left to right).
function gridTable(L, rowIdx, cellsOf) {
  const rows = rowIdx.map((r) => L.rows[r]);
  const ncol = Math.max(...rows.map((r) => r.lines.length));
  if (ncol < 2) return null;
  const ti = L.tables ? L.tables.length : 0;
  const out = { page: rows[0].page, box: unionBox(rows.map((r) => r.box)), columns: [], header: null, rows: [] };
  for (const r of rows) {
    const lines = cellsOf(r);
    const cells = lines.map((l, col) => ({ col, text: l.text, lines: [L.lines.indexOf(l)], start: l.start, end: l.end }));
    out.rows.push({ cells, lines: cells.map((c) => c.lines[0]) });
  }
  for (let c = 0; c < ncol; c++) {
    const xs = out.rows.map((r) => r.cells[c]).filter(Boolean).map((cell) => L.lines[cell.lines[0]].box);
    out.columns.push({ x0: Math.min(...xs.map((b) => b.x0)), x1: Math.max(...xs.map((b) => b.x1)) });
  }
  out.header = headerOf(out, L);
  out.rows.forEach((r, ri) => r.cells.forEach((c) => (L.lines[c.lines[0]].table = { table: ti, row: ri, col: c.col })));
  return out;
}

const HEADER_WORDS = /^(?:date|dates|day|time|times|start|end|topic|topics|session|event|title|subject|activity|room|location|venue|where|when|speaker|speakers|reading|readings|assignment|assignments|due|week|wk|lecture|class|description|details|notes|instructor|presenter|track|stage|program|programme|what|who|deadline|deliverable|homework|lab|section|module|unit|chapter|exam|quiz|item|agenda|hour|hours|duration|type|category|status|host|period)s?$/i;

function headerOf(t, L) {
  const first = t.rows[0];
  if (!first || t.rows.length < 2) return null;
  const texts = first.cells.map((c) => c.text.replace(/[:：]$/, '').trim());
  const headerish = texts.filter((x) => HEADER_WORDS.test(x) || x.split(/\s+/).every((w) => HEADER_WORDS.test(w.replace(/[^\w]/g, '')))).length;
  const anyDigit = texts.some((x) => /\d/.test(x));
  const bold = first.cells.every((c) => L.lines[c.lines[0]].bold);
  const caps = texts.every((x) => x === x.toUpperCase() && /[A-Z]/.test(x));
  if (headerish >= Math.max(1, Math.ceil(texts.length / 2)) || ((bold || caps) && !anyDigit)) return texts;
  return null;
}

function unionBox(boxes) {
  const bs = boxes.filter(Boolean);
  if (!bs.length) return null;
  return { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) };
}

// Markup documents: one line per block line; the cells of one table row share a line row,
// joined with tabs, and make up the tables.
export function layoutFromBlocks(blocks, { kind = 'html', title = '' } = {}) {
  const L = { kind, title, text: '', pages: [], lines: [], rows: [], tables: [], pairs: [], regions: [] };
  let text = '';
  let y = 0;
  const pages = new Map();
  const tableRows = new Map(); // table id -> Map(row -> row index in L.rows)
  const emitRow = (pieces, page, extra, cell) => {
    if (text) text += '\n';
    const row = { page, lines: [], box: null };
    let x = 0;
    pieces.forEach((p, k) => {
      if (k) {
        text += '\t';
        x += 1;
      }
      const start = text.length;
      text += p.text;
      const line = makeLine(p.text, page, { x0: x, y0: y, x1: x + p.text.length, y1: y + 1 }, start, { ...extra, ...p.extra, size: 1, source: p.source || 'markup' });
      x += p.text.length;
      line.row = L.rows.length;
      if (p.cell) line.cell = p.cell;
      row.lines.push(L.lines.length);
      L.lines.push(line);
    });
    row.box = { x0: 0, y0: y, x1: x, y1: y + 1 };
    L.rows.push(row);
    y++;
    if (!pages.has(page)) pages.set(page, 0);
    pages.set(page, Math.max(pages.get(page), x));
    if (cell) {
      if (!tableRows.has(cell.table)) tableRows.set(cell.table, new Map());
      tableRows.get(cell.table).set(cell.row, L.rows.length - 1);
    }
  };
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.skip === 'header' || b.skip === 'footer') {
      i++;
      continue;
    }
    const page = b.page || 1;
    if (b.type === 'cell' && b.cell) {
      // the cells of one row, in column order
      const cells = [];
      while (i < blocks.length && blocks[i].type === 'cell' && blocks[i].cell && blocks[i].cell.table === b.cell.table && blocks[i].cell.row === b.cell.row) {
        cells.push(blocks[i]);
        i++;
      }
      cells.sort((x, z) => x.cell.col - z.cell.col);
      // cells with several paragraphs: one cell, its paragraphs joined
      const merged = [];
      for (const c of cells) {
        const last = merged[merged.length - 1];
        if (last && last.cell.col === c.cell.col) last.text += ' ' + c.text.replace(/\n/g, ' ');
        else merged.push({ text: c.text.replace(/\n/g, ' '), cell: c.cell, source: c.source });
      }
      emitRow(merged, page, {}, b.cell);
      continue;
    }
    const heading = /^h([1-6])$/.exec(b.type);
    for (const part of String(b.text || '').split('\n')) {
      const t = part.trim();
      if (!t) continue;
      emitRow([{ text: t, source: b.source }], page, { heading: heading ? +heading[1] : 0, bold: !!heading });
    }
    i++;
  }
  L.text = text;
  L.pages = [...pages.entries()].map(([page, w]) => ({ page, width: w, height: y, unit: 'char' }));
  if (!L.pages.length) L.pages.push({ page: 1, width: 0, height: 0, unit: 'char' });
  for (const l of L.lines) l.region = 0;
  L.regions = [{ page: L.pages[0].page, box: { x0: 0, y0: 0, x1: Math.max(0, ...L.pages.map((p) => p.width)), y1: y }, lines: L.lines.map((_, k) => k) }];
  // tables from the cells' own coordinates
  for (const [, rowsMap] of tableRows) {
    const idx = [...rowsMap.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const t = gridTable(L, idx, (r) => r.lines.map((li) => L.lines[li]));
    if (t) {
      // cells keep their real column even when a row has fewer cells
      t.rows.forEach((r) => r.cells.forEach((c) => (c.col = L.lines[c.lines[0]].cell ? L.lines[c.lines[0]].cell.col : c.col)));
      L.tables.push(t);
    }
  }
  // tab-separated rows outside tables (a pasted grid)
  for (const t of textTables(L)) if (!t.rows.some((r) => r.cells.some((c) => L.lines[c.lines[0]].cell))) L.tables.push(t);
  L.pairs = findPairs(L);
  markHeadings(L, null);
  return finishLayout(L);
}

/* ---------- positioned pages ---------- */

// pages: [{ page, width, height, unit, source, atoms: [{ text, x0, x1, top, bot, size, bold, conf,
//   words: [{ text, x0, x1, top, bot, conf }] }] }]
export function layoutFromPages(pages, { kind = 'pdf', title = '' } = {}) {
  const L = { kind, title, text: '', pages: [], lines: [], rows: [], tables: [], pairs: [], regions: [], panels: [], overlays: [] };
  let text = '';
  for (const pg of pages) {
    L.pages.push({ page: pg.page, width: pg.width, height: pg.height, unit: pg.unit || 'pt' });
    for (const p of pg.panels || []) L.panels.push({ page: pg.page, box: p.box, overlay: !!p.overlay });
    let atoms = splitWide(pg.atoms || []).filter((a) => a.text.trim());
    // text on a panel laid over the page (a popup, a menu) is not the page's: kept aside
    const over = (pg.panels || []).filter((p) => p.overlay);
    if (over.length) {
      for (const p of over) {
        const mine = atoms.filter((a) => within(a, p.box));
        L.overlays.push({ page: pg.page, box: p.box, atoms: mine, text: mine.sort((a, b) => a.top - b.top || a.x0 - b.x0).map((a) => a.text).join('\n') });
      }
      atoms = atoms.filter((a) => !over.some((p) => within(a, p.box)));
    }
    if (!atoms.length) continue;
    const rows = visualRows(atoms);
    const tables = findTables(rows, atoms);
    // reading order: tables as single units, everything else line by line
    const inTable = new Set();
    for (const t of tables) for (const r of t.rows) for (const a of r.atoms) inTable.add(a);
    const units = [];
    for (const t of tables) units.push({ table: t, x0: t.box.x0, x1: t.box.x1, top: t.box.y0, bot: t.box.y1, size: t.size });
    for (const a of atoms) if (!inTable.has(a)) units.push({ atom: a, x0: a.x0, x1: a.x1, top: a.top, bot: a.bot, size: a.size });
    for (const u of units) u.base = u.top + 0.75 * Math.min(u.size, u.bot - u.top);
    const leaves = xycut(units, 0);
    if (text) text += '\n\n';
    const pageStart = L.lines.length;
    let region = L.regions.length;
    let prevLeaf = null;
    for (const leaf of leaves) {
      // a new region when the reading moves to another column or jumps down
      const lb = { x0: Math.min(...leaf.map((u) => u.x0)), x1: Math.max(...leaf.map((u) => u.x1)), top: Math.min(...leaf.map((u) => u.top)), bot: Math.max(...leaf.map((u) => u.bot)) };
      const size = median(leaf.map((u) => u.size)) || 10;
      const fresh = !prevLeaf || leaf.some((u) => u.table) || prevLeaf.table || lb.x1 < prevLeaf.x0 || lb.x0 > prevLeaf.x1 || lb.top - prevLeaf.bot > 2.5 * size || lb.top < prevLeaf.top - size;
      if (fresh && prevLeaf) region++;
      if (!L.regions[region]) L.regions[region] = { page: pg.page, box: null, lines: [] };
      prevLeaf = { ...lb, table: leaf.some((u) => u.table) };
      const table = leaf.find((u) => u.table);
      if (table) {
        text = emitTable(L, table.table, pg, text, region);
        continue;
      }
      // rows inside the leaf, left to right
      const sorted = leaf.map((u) => u.atom).sort((a, b) => a.top - b.top || a.x0 - b.x0);
      const grouped = [];
      for (const a of sorted) {
        const g = grouped[grouped.length - 1];
        if (g && overlapY(g, a) > 0.5) {
          g.atoms.push(a);
          g.top = Math.min(g.top, a.top);
          g.bot = Math.max(g.bot, a.bot);
        } else grouped.push({ atoms: [a], top: a.top, bot: a.bot });
      }
      for (const g of grouped) {
        g.atoms.sort((a, b) => a.x0 - b.x0);
        text = emitRow(L, g.atoms, pg, text, region);
      }
    }
    // the page's rows across columns (for 'label   value' read across a gutter)
    pageRows(L, pageStart);
  }
  L.text = text;
  for (const r of L.regions) if (r) r.box = unionBox(r.lines.map((i) => L.lines[i].box));
  L.regions = L.regions.filter(Boolean);
  L.pairs = findPairs(L);
  markHeadings(L, pages);
  return finishLayout(L);
}

function overlapY(a, b) {
  const o = Math.min(a.bot, b.bot) - Math.max(a.top, b.top);
  return o / Math.max(1e-6, Math.min(a.bot - a.top, b.bot - b.top));
}

// Atoms cut where a gap is far wider than a word space (a label and its value, table cells,
// two columns Tesseract read as one line).
function splitWide(atoms) {
  const out = [];
  for (const a of atoms) {
    const ws = (a.words || []).filter((w) => w.text && w.text.trim()).sort((x, y) => x.x0 - y.x0);
    if (ws.length < 2) {
      out.push({ ...a, words: ws.length ? ws : [{ text: a.text, x0: a.x0, x1: a.x1, top: a.top, bot: a.bot, conf: a.conf }] });
      continue;
    }
    const size = a.size || a.bot - a.top || 10;
    const gaps = [];
    for (let k = 1; k < ws.length; k++) gaps.push(ws[k].x0 - ws[k - 1].x1);
    // the usual word space: the median gap, leaving out the widest (on a two-word line the
    // only gap may be the wide one: 'DOORS        SHOW')
    const pos = gaps.filter((g) => g > 0).sort((a, b) => a - b);
    const usual = Math.min(pos.length > 2 ? median(pos.slice(0, -1)) : 0.35 * size, 0.6 * size) || 0.3 * size;
    let cur = [ws[0]];
    const pieces = [cur];
    for (let k = 1; k < ws.length; k++) {
      const g = ws[k].x0 - ws[k - 1].x1;
      if (g > Math.max(1.4 * size, 3 * usual)) {
        cur = [ws[k]];
        pieces.push(cur);
      } else cur.push(ws[k]);
    }
    for (const p of pieces) {
      out.push({
        ...a,
        text: p.map((w) => w.text).join(' '),
        x0: Math.min(...p.map((w) => w.x0)),
        x1: Math.max(...p.map((w) => w.x1)),
        top: pieces.length > 1 ? Math.min(...p.map((w) => (w.top != null ? w.top : a.top))) : a.top,
        bot: pieces.length > 1 ? Math.max(...p.map((w) => (w.bot != null ? w.bot : a.bot))) : a.bot,
        conf: p.reduce((s, w) => s + (w.conf != null ? w.conf : 1), 0) / p.length,
        words: p,
      });
    }
  }
  return out;
}

// Atoms on one baseline, left to right.
function visualRows(atoms) {
  const sorted = atoms.slice().sort((a, b) => (a.top + a.bot) / 2 - (b.top + b.bot) / 2);
  const rows = [];
  for (const a of sorted) {
    const mid = (a.top + a.bot) / 2;
    let best = null;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
      const r = rows[k];
      const tol = 0.5 * Math.min(r.size, a.size || r.size);
      if (Math.abs(r.mid - mid) <= tol && !r.atoms.some((o) => a.x0 < o.x1 && o.x0 < a.x1)) {
        best = r;
        break;
      }
    }
    if (best) {
      best.atoms.push(a);
      best.top = Math.min(best.top, a.top);
      best.bot = Math.max(best.bot, a.bot);
    } else rows.push({ atoms: [a], mid, top: a.top, bot: a.bot, size: a.size || a.bot - a.top });
  }
  for (const r of rows) r.atoms.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => a.top - b.top);
}

// Tables: consecutive rows whose pieces start at the same x positions (two or more columns),
// with the second line of a wrapped cell joined to the cell above it.
function findTables(rows) {
  const tables = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].atoms.length < 2) {
      i++;
      continue;
    }
    // grow a block of rows
    const block = [rows[i]];
    let j = i + 1;
    const size = median(rows[i].atoms.map((a) => a.size || 10)) || 10;
    while (j < rows.length) {
      const prev = block[block.length - 1];
      const r = rows[j];
      const gap = r.top - prev.bot;
      if (gap > 2.2 * size) break;
      if (Math.abs((r.size || size) - size) > 0.45 * size) break;
      if (r.atoms.length >= 2) {
        block.push(r);
        j++;
        continue;
      }
      // a one-piece row may be a wrapped cell or an empty-cell row; it must line up with a column
      const cols = columnsOf(block);
      const a = r.atoms[0];
      if (cols.length >= 2 && cols.some((c) => Math.abs(a.x0 - c.x0) <= 1.2 * size) && a.x1 <= cols[cols.length - 1].x1 + 4 * size) {
        block.push(r);
        j++;
        continue;
      }
      break;
    }
    const multi = block.filter((r) => r.atoms.length >= 2);
    const t = multi.length >= 2 ? tableOf(block, size) : null;
    if (t) {
      tables.push(t);
      i = j;
    } else i++;
  }
  return tables;
}

function columnsOf(block) {
  const xs = [];
  for (const r of block) if (r.atoms.length >= 2) for (const a of r.atoms) xs.push({ x0: a.x0, x1: a.x1, size: a.size || 10 });
  xs.sort((a, b) => a.x0 - b.x0);
  const cols = [];
  for (const x of xs) {
    const c = cols[cols.length - 1];
    if (c && x.x0 - c.last <= 1.2 * x.size) {
      c.n++;
      c.last = x.x0;
      c.x1 = Math.max(c.x1, x.x1);
      c.xs.push(x.x0);
    } else cols.push({ x0: x.x0, last: x.x0, x1: x.x1, n: 1, xs: [x.x0] });
  }
  for (const c of cols) c.x0 = median(c.xs);
  return cols;
}

function tableOf(block, size) {
  const multi = block.filter((r) => r.atoms.length >= 2);
  let cols = columnsOf(block).filter((c) => c.n >= Math.max(2, Math.ceil(0.4 * multi.length)));
  if (cols.length < 2) return null;
  const colOf = (a) => {
    let best = -1;
    let bd = Infinity;
    cols.forEach((c, k) => {
      const d = Math.abs(a.x0 - c.x0);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    // a piece starting inside a column (right-aligned or centred) belongs to it
    if (bd > 1.5 * size) {
      const inside = cols.findIndex((c, k) => a.x0 >= c.x0 - size && a.x0 < (cols[k + 1] ? cols[k + 1].x0 - 0.5 * size : Infinity));
      return inside >= 0 ? inside : -1;
    }
    return best;
  };
  // every multi-piece row must fit the columns, one piece per column
  let fit = 0;
  for (const r of multi) {
    const ks = r.atoms.map(colOf);
    if (ks.every((k) => k >= 0) && new Set(ks).size === ks.length) fit++;
  }
  if (fit < Math.max(2, 0.7 * multi.length)) return null;
  // prose in two columns is not a table: table rows are short
  const longRows = multi.filter((r) => r.atoms.some((a) => a.text.length > 70)).length;
  if (longRows > 0.5 * multi.length) return null;
  const rows = [];
  let pitch = [];
  for (let k = 1; k < block.length; k++) pitch.push(block[k].top - block[k - 1].top);
  const usualPitch = median(pitch) || 1.5 * size;
  for (let k = 0; k < block.length; k++) {
    const r = block[k];
    const cells = r.atoms.map((a) => ({ col: colOf(a), atoms: [a] }));
    const prev = rows[rows.length - 1];
    const close = prev && r.top - prev.bot < 0.6 * size && r.top - prev.top < 0.9 * usualPitch;
    // a row whose pieces sit under cells of the row above, close below it, without a first
    // column of its own: the wrapped second line of those cells
    const cont = prev && close && !cells.some((c) => c.col === 0) && cells.every((c) => c.col >= 0 && prev.cells.some((p) => p.col === c.col));
    if (cont) {
      for (const c of cells) prev.cells.find((p) => p.col === c.col).atoms.push(...c.atoms);
      prev.bot = Math.max(prev.bot, r.bot);
      prev.atoms.push(...r.atoms);
      prev.visual.push(r);
      continue;
    }
    rows.push({ cells: cells.filter((c) => c.col >= 0), atoms: r.atoms.slice(), top: r.top, bot: r.bot, visual: [r] });
  }
  const box = unionBox(block.flatMap((r) => r.atoms.map((a) => ({ x0: a.x0, y0: a.top, x1: a.x1, y1: a.bot }))));
  cols = cols.map((c, k) => ({ x0: c.x0, x1: Math.max(c.x1, ...rows.flatMap((r) => r.cells.filter((x) => x.col === k).flatMap((x) => x.atoms.map((a) => a.x1)))) }));
  return { rows, columns: cols, box, size };
}

function emitRow(L, atoms, pg, text, region) {
  if (text && !text.endsWith('\n')) text += '\n';
  const row = { page: pg.page, lines: [], box: null };
  atoms.forEach((a, k) => {
    if (k) text += '\t';
    text = emitAtom(L, a, pg, text, region);
    row.lines.push(L.lines.length - 1);
    L.lines[L.lines.length - 1].row = L.rows.length;
  });
  row.box = unionBox(row.lines.map((i) => L.lines[i].box));
  L.rows.push(row);
  return text;
}

function emitAtom(L, a, pg, text, region) {
  const start = text.length;
  const words = [];
  let s = '';
  for (const w of a.words) {
    if (s) s += ' ';
    const ws = start + s.length;
    s += w.text;
    words.push({ text: w.text, box: { x0: w.x0, y0: w.top != null ? w.top : a.top, x1: w.x1, y1: w.bot != null ? w.bot : a.bot }, conf: round3(w.conf != null ? w.conf : a.conf != null ? a.conf : 1), start: ws, end: ws + w.text.length });
    if (w.raw && w.raw !== w.text) words[words.length - 1].raw = w.raw;
  }
  text += s;
  const line = { text: s, page: pg.page, box: { x0: a.x0, y0: a.top, x1: a.x1, y1: a.bot }, conf: round3(a.conf != null ? a.conf : 1), size: round3(a.size || a.bot - a.top), bold: !!a.bold, heading: 0, source: pg.source || a.source || 'text', start, end: start + s.length, words, row: -1, region };
  if (underlined(a)) line.underline = true;
  if (pg.panels && pg.panels.length) line.panel = panelOf(L, pg, line.box);
  L.lines.push(line);
  if (L.regions[region]) L.regions[region].lines.push(L.lines.length - 1);
  return text;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// A bar under every word of the line, the same bar, not much longer than the line: a selected
// tab's indicator or a link's underline (not a rule across the page). Words carry the bar
// src/layout/surface.js found under them (`ul`).
function underlined(a) {
  const ws = a.words || [];
  if (!ws.length || !ws.every((w) => w.ul)) return false;
  const u = ws[0].ul;
  if (!ws.every((w) => Math.abs(w.ul.y - u.y) <= 2 && w.ul.x0 < u.x1 && w.ul.x1 > u.x0)) return false;
  const width = a.x1 - a.x0;
  const size = a.size || a.bot - a.top || 10;
  return u.x1 - u.x0 <= 1.6 * width + 2 * size;
}

// The innermost panel (a card, a dialog) a box sits in, as an index into L.panels.
function panelOf(L, pg, box) {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  let best = -1;
  let area = Infinity;
  for (let i = 0; i < L.panels.length; i++) {
    const p = L.panels[i];
    if (p.page !== pg.page || p.overlay) continue;
    const b = p.box;
    const ar = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1 && ar < area) {
      best = i;
      area = ar;
    }
  }
  return best;
}

const within = (a, b) => {
  const cx = (a.x0 + a.x1) / 2;
  const cy = (a.top + a.bot) / 2;
  return cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1;
};

function emitTable(L, t, pg, text, region) {
  const ti = L.tables.length;
  const out = { page: pg.page, box: t.box, columns: t.columns, header: null, rows: [] };
  L.tables.push(out);
  t.rows.forEach((r, ri) => {
    // each visual row of the table becomes a text row; cells remember their table row
    const cellLines = new Map();
    for (const vr of r.visual) {
      const atoms = vr.atoms.slice().sort((a, b) => a.x0 - b.x0);
      if (text && !text.endsWith('\n')) text += '\n';
      const row = { page: pg.page, lines: [], box: null };
      atoms.forEach((a, k) => {
        if (k) text += '\t';
        text = emitAtom(L, a, pg, text, region);
        const li = L.lines.length - 1;
        L.lines[li].row = L.rows.length;
        row.lines.push(li);
        const cell = r.cells.find((c) => c.atoms.includes(a));
        if (cell) {
          L.lines[li].table = { table: ti, row: ri, col: cell.col };
          if (!cellLines.has(cell.col)) cellLines.set(cell.col, []);
          cellLines.get(cell.col).push(li);
        }
      });
      row.box = unionBox(row.lines.map((i) => L.lines[i].box));
      L.rows.push(row);
    }
    const cells = [...cellLines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([col, lis]) => ({ col, text: lis.map((i) => L.lines[i].text).join(' '), lines: lis, start: L.lines[lis[0]].start, end: L.lines[lis[lis.length - 1]].end }));
    out.rows.push({ cells, lines: cells.flatMap((c) => c.lines) });
  });
  out.header = headerOf(out, L);
  // 'WHEN | WHERE' over their values: a flyer's labelled columns, not a table of data
  const first = out.rows[0];
  // (a timetable's 'Day | Time | Activity | Place' heads rows of data)
  if (first && first.cells.length >= 2 && out.rows.length <= 4 && first.cells.every((c) => looseLabel(c.text)) && first.cells.some((c) => /^(?:when|where|what|who)[:：]?$/i.test(c.text.trim()))) out.form = true;
  return text;
}

// Rows across the whole page (the reading order may have put a label and its value in
// different regions): stored on the lines as `across` (indexes of lines level with it).
function pageRows(L, from) {
  const idx = [];
  for (let i = from; i < L.lines.length; i++) idx.push(i);
  for (const i of idx) {
    const a = L.lines[i];
    const mid = (a.box.y0 + a.box.y1) / 2;
    a.across = idx.filter((j) => j !== i && Math.abs((L.lines[j].box.y0 + L.lines[j].box.y1) / 2 - mid) <= 0.45 * Math.min(a.size, L.lines[j].size) && L.lines[j].region !== a.region);
  }
}

/* ---------- pairs and headings ---------- */

function findPairs(L) {
  const pairs = [];
  const used = new Set();
  const lines = L.lines;
  const push = (p) => {
    pairs.push(p);
    used.add(p.line);
  };
  // labelled columns: each label over the cells below it
  for (const t of L.tables || []) {
    if (!t.form) continue;
    const head = t.rows[0];
    for (const hc of head.cells) {
      const below = t.rows.slice(1).flatMap((r) => r.cells.filter((c) => c.col === hc.col).flatMap((c) => c.lines));
      if (!below.length) continue;
      const li = hc.lines[0];
      const l = lines[li];
      push({ key: looseLabel(hc.text), label: hc.text.replace(/[:：]\s*$/, '').trim(), value: below.map((j) => lines[j].text).join('\n'), page: l.page, line: li, valueLines: below, labelSpan: [l.start, l.end], valueSpan: [lines[below[0]].start, lines[below[below.length - 1]].end], how: 'stacked' });
      for (const j of below) used.add(j);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (used.has(i)) continue;
    // inline: 'Date: Oct 21'
    const ip = inlinePair(l.text);
    if (ip) {
      push({ key: ip.key, label: ip.label, value: l.text.slice(ip.valueStart).trim(), page: l.page, line: i, valueLines: [i], labelSpan: [l.start + ip.labelStart, l.start + ip.labelEnd], valueSpan: [l.start + ip.valueStart, l.end], how: 'inline' });
      continue;
    }
    const key = labelKey(l.text);
    const colon = /[:：]\s*$/.test(l.text);
    if (!key && !(colon && l.text.length <= 30 && /^[A-Za-z]/.test(l.text))) continue;
    // a label column: the value is the rest of its row
    const row = l.row >= 0 ? L.rows[l.row] : null;
    const rest = row ? row.lines.filter((j) => j !== i && lines[j].box.x0 >= l.box.x0) : [];
    // (labels level with each other, 'DATE   DOORS   SHOW', are not each other's values)
    const notLabel = (j) => !labelKey(lines[j].text);
    const beside = (rest.length ? rest : (l.across || []).filter((j) => lines[j].box.x0 > l.box.x1)).filter(notLabel);
    if (beside.length && (row ? row.lines[0] === i : true)) {
      const vs = beside.sort((a, b) => lines[a].box.x0 - lines[b].box.x0);
      push({ key: key || 'other', label: l.text.replace(/[:：]\s*$/, '').trim(), value: vs.map((j) => lines[j].text).join(' '), page: l.page, line: i, valueLines: vs, labelSpan: [l.start, l.end - (colon ? 1 : 0)], valueSpan: [lines[vs[0]].start, lines[vs[vs.length - 1]].end], how: 'column' });
      continue;
    }
    // stacked: 'WHEN' above 'Saturday, Oct 24' / '7 PM'
    if (!key) continue;
    const below = [];
    let last = l;
    for (let j = i + 1; j < lines.length && below.length < 3; j++) {
      const n = lines[j];
      if (n.page !== l.page || n.region !== l.region) break;
      if (labelKey(n.text) || inlinePair(n.text)) break;
      const gap = n.box.y0 - last.box.y1;
      const unit = L.pages.find((p) => p.page === l.page);
      const charUnits = unit && unit.unit === 'char';
      if (charUnits ? gap > 1 : gap > 1.6 * Math.max(l.size, n.size)) break;
      if (n.row === last.row && last !== l) break;
      // (under the label: a value in the next column over is someone else's)
      if (!charUnits && (n.box.x0 > l.box.x1 + l.size || n.box.x1 < l.box.x0 - l.size)) break;
      below.push(j);
      last = n;
      if (charUnits) break;
    }
    if (below.length) {
      push({ key, label: l.text.replace(/[:：]\s*$/, '').trim(), value: below.map((j) => lines[j].text).join('\n'), page: l.page, line: i, valueLines: below, labelSpan: [l.start, l.end - (colon ? 1 : 0)], valueSpan: [lines[below[0]].start, lines[below[below.length - 1]].end], how: 'stacked' });
    }
  }
  return pairs;
}

// Heading levels from size (positioned pages) or markup.
function markHeadings(L, pages) {
  if (!pages) return;
  const byPage = new Map();
  for (const l of L.lines) {
    if (!byPage.has(l.page)) byPage.set(l.page, []);
    byPage.get(l.page).push(l);
  }
  for (const [, ls] of byPage) {
    const sizes = [];
    for (const l of ls) for (let k = 0; k < Math.min(l.text.length, 80); k += 4) sizes.push(l.size);
    const body = median(sizes) || 1;
    const max = Math.max(...ls.map((l) => l.size));
    for (const l of ls) {
      if (l.text.length > 90) continue;
      if (l.size >= 1.6 * body && l.size >= 0.8 * max) l.heading = 1;
      else if (l.size >= 1.25 * body) l.heading = 2;
      else if (l.bold && l.text.length <= 60 && !(l.table)) l.heading = 3;
    }
  }
}

/* ---------- PDF segments and OCR lines -> atoms ---------- */

// src/pdf layout segments (text-layer, OCR'd or fused pages: what layoutPage() reads) -> atoms.
// A segment's text was built from its runs; each word's box comes from the run characters it
// was made of (runs carry x0/x1 only, so characters share a run's width evenly).
export function atomsFromSegments(segs) {
  const out = [];
  for (const s of segs || []) {
    const text = String(s.text || '').replace(/­/g, '');
    if (!text.trim()) continue;
    const chars = [];
    for (const r of s.runs || []) {
      const str = String(r.str || '');
      const n = str.length || 1;
      for (let k = 0; k < str.length; k++) {
        if (/\s/.test(str[k])) continue;
        chars.push({ ch: str[k], x0: r.x0 + ((r.x1 - r.x0) * k) / n, x1: r.x0 + ((r.x1 - r.x0) * (k + 1)) / n, top: r.top != null ? r.top : s.top, bot: r.bot != null ? r.bot : s.bot, conf: r.conf });
      }
    }
    const words = [];
    let j = 0;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const w = m[0];
      let first = null;
      let last = null;
      for (const ch of w) {
        // find this character among the next few run characters (markers and joins differ)
        let k = j;
        while (k < chars.length && k < j + 4 && chars[k].ch !== ch) k++;
        if (k < chars.length && chars[k].ch === ch) {
          if (!first) first = chars[k];
          last = chars[k];
          j = k + 1;
        }
      }
      const frac0 = m.index / text.length;
      const frac1 = (m.index + w.length) / text.length;
      const x0 = first ? first.x0 : s.x0 + (s.x1 - s.x0) * frac0;
      const x1 = last ? last.x1 : s.x0 + (s.x1 - s.x0) * frac1;
      const conf = first && typeof first.conf === 'number' ? first.conf : typeof s.conf === 'number' ? s.conf : 1;
      words.push({ text: w, x0, x1: Math.max(x1, x0 + 0.1), top: first ? first.top : s.top, bot: first ? first.bot : s.bot, conf });
    }
    out.push({ text: words.map((w) => w.text).join(' '), x0: s.x0, x1: s.x1, top: s.top, bot: s.bot, size: s.fs, bold: s.bold > 0.5, conf: typeof s.conf === 'number' ? s.conf : 1, words });
  }
  return out;
}

// OCR lines with corrected words (src/ocr ocrBlocks) -> atoms.
export function atomsFromOcr(lines) {
  const out = [];
  for (const l of lines || []) {
    const ws = (l.words || []).filter((w) => w.text && w.bbox).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!ws.length) continue;
    const words = ws.map((w) => ({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, top: w.bbox.y0, bot: w.bbox.y1, conf: w.conf, raw: w.raw, ...(w.ul ? { ul: w.ul } : {}) }));
    const top = Math.min(...words.map((w) => w.top));
    const bot = Math.max(...words.map((w) => w.bot));
    // text height from the words of three letters or more (a tall bracket stretches a box)
    const hs = words.filter((w) => /\p{L}{3}/u.test(w.text)).map((w) => w.bot - w.top);
    const size = (median(hs) || l.size || bot - top) / 0.96;
    out.push({ text: words.map((w) => w.text).join(' '), x0: words[0].x0, x1: Math.max(...words.map((w) => w.x1)), top, bot, size, bold: false, conf: words.reduce((s, w) => s + (w.conf || 0), 0) / words.length, words });
  }
  return out;
}

/* ---------- from extract() ---------- */

// The layout of an extracted document. src: what the reader kept for it
// ({ pages } for PDFs and pictures, the plain text for text files).
export function layoutOf(doc, src = {}) {
  let L;
  if (src.text != null) L = layoutFromText(src.text, { kind: doc.kind, title: doc.title });
  else if (src.pages && src.pages.length) L = layoutFromPages(src.pages, { kind: doc.kind, title: doc.title });
  else L = layoutFromBlocks(src.blocks || doc.blocks || [], { kind: doc.kind, title: doc.title });
  L.warnings = doc.warnings || [];
  // a web page's schema.org events (JSON-LD, microdata), read by findEvents()
  // (a page the schema reader cannot take is still read as text: never fail the file for it)
  if (src.html) {
    let items = [];
    try {
      items = readSchema(src.html);
    } catch (e) {
      L.warnings = [...L.warnings, { type: 'unsupported', page: null, text: 'The page’s schema.org event data could not be read.' }];
    }
    if (items.length) L.schema = items;
  }
  return L;
}

/**
 * extractLayout(input, opts) -> Layout (extract() with { layout: true }; the Doc is layout.doc)
 */
export async function extractLayout(input, opts = {}) {
  const { extract } = await import('../extract.js');
  const doc = await extract(input, { ...opts, layout: true });
  const L = doc.layout;
  Object.defineProperty(L, 'doc', { value: doc, enumerable: false });
  return L;
}
