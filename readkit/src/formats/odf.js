// OpenDocument text and presentations (.odt, .ott, .odp, .otp, and the flat .fodt/.fodp
// XML forms) -> blocks. Tracked deletions, annotations, hidden text and the table of contents
// are left out; list numbers and numbered headings are worked out; notes go at the end.

import { makeBlock } from '../doc.js';
import { walkXml, parseXml, kid, kids, find, textOf, attr } from './xml.js';
import { formatNumber, isCitation } from './util.js';
import { usefulTitle } from './opc.js';

const SKIP = new Set([
  'office:annotation', 'office:annotation-end', 'text:tracked-changes', 'text:table-of-content', 'text:illustration-index', 'text:table-index',
  'text:object-index', 'text:user-index', 'text:alphabetical-index', 'office:forms', 'text:sequence-decls', 'text:variable-decls',
  'text:user-field-decls', 'svg:title', 'svg:desc', 'draw:image', 'presentation:notes', 'office:scripts', 'office:font-face-decls',
  'office:settings', 'table:covered-table-cell', 'office:event-listeners',
]);
const hidden = (name, attrs) => {
  if (SKIP.has(name)) return true;
  if (name === 'text:section') return attrs()['text:display'] === 'none';
  if (name === 'text:hidden-paragraph' || name === 'text:hidden-text') return attrs()['text:is-hidden'] !== 'false';
  return false;
};

/* ---------- styles: names, outline levels, list styles, hidden pages ---------- */

function makeStyles() {
  return { para: new Map(), lists: new Map(), outline: null, pages: new Map() };
}

function addStyle(styles, el) {
  const name = attr(el, 'style:name');
  if (el.name === 'style:style' && name) {
    const family = attr(el, 'style:family');
    if (family === 'paragraph') {
      styles.para.set(name, {
        parent: attr(el, 'style:parent-style-name'),
        display: String(attr(el, 'style:display-name') || name.replace(/_20_/g, ' ')).toLowerCase(),
        outline: attr(el, 'style:default-outline-level'),
        list: attr(el, 'style:list-style-name'),
      });
    } else if (family === 'drawing-page') {
      const props = kid(el, 'style:drawing-page-properties');
      styles.pages.set(name, attr(props, 'presentation:visibility') === 'hidden');
    }
  } else if (el.name === 'text:list-style' && name) {
    styles.lists.set(name, listLevels(el));
  } else if (el.name === 'text:outline-style') {
    styles.outline = listLevels(el);
  }
}

function listLevels(el) {
  const levels = new Map();
  for (const l of kids(el)) {
    const lvl = +attr(l, 'text:level') || 1;
    if (l.name === 'text:list-level-style-number' || l.name === 'text:outline-level-style') {
      levels.set(lvl, {
        fmt: attr(l, 'style:num-format') || '',
        prefix: attr(l, 'style:num-prefix') || '',
        suffix: attr(l, 'style:num-suffix') || '',
        display: +attr(l, 'text:display-levels') || 1,
        start: +attr(l, 'text:start-value') || 1,
      });
    } else levels.set(lvl, { fmt: '' }); // bullets and images: no label
  }
  return levels;
}

function paraStyle(styles, name) {
  const out = { names: [], outline: undefined, list: undefined };
  const seen = new Set();
  for (let n = name, s = styles.para.get(n); s && !seen.has(n); n = s.parent, s = styles.para.get(n)) {
    seen.add(n);
    out.names.push(s.display);
    if (out.outline === undefined && s.outline) out.outline = +s.outline;
    if (out.list === undefined && s.list) out.list = s.list;
  }
  return out;
}

function kindOf(st) {
  for (const n of st.names) {
    if (n === 'title') return { heading: 1 };
    if (n === 'subtitle') return { heading: 2 };
    const h = /^heading\s*([1-9])$/.exec(n);
    if (h) return { heading: Math.min(6, +h[1]) };
  }
  const n = st.names[0] || '';
  if (/^contents (?:\d+|heading)$/.test(n)) return { toc: true };
  if (/quot/.test(n)) return { type: 'quote' };
  // LibreOffice's caption styles (Illustration, Table, Figure...) are all based on Caption.
  if (st.names.includes('caption')) return { type: 'caption' };
  if (n === 'preformatted text') return { type: 'code' };
  return {};
}

// "2.1." from counters [2, 1] and a level style showing two levels.
function numberLabel(level, counters, depth, levelsMap) {
  if (!level || !level.fmt) return '';
  const parts = [];
  for (let d = Math.max(1, depth - level.display + 1); d <= depth; d++) {
    const lv = levelsMap.get(d) || level;
    parts.push(formatNumber(counters[d] || lv.start || 1, lv.fmt || '1'));
  }
  return (level.prefix + parts.join('.') + level.suffix).trim();
}

/* ---------- text inside a paragraph ---------- */

function inlineText(node, out, env) {
  for (const c of node.children) {
    if (typeof c === 'string') {
      out.text += c.replace(/[ \t\r\n]+/g, ' ');
      continue;
    }
    switch (c.name) {
      case 'text:s':
        out.text += ' '.repeat(Math.min(16, +attr(c, 'text:c') || 1));
        break;
      case 'text:tab':
        out.text += ' ';
        break;
      case 'text:line-break':
        out.text += '\n';
        break;
      case 'text:soft-page-break':
        env.page++;
        env.paged = true;
        break;
      case 'text:note': {
        // The note body is read at the end; its mark is dropped from the sentence.
        const body = kid(c, 'text:note-body');
        const mark = textOf(kid(c, 'text:note-citation')).trim();
        if (body) env.notes.push({ mark, body, cls: attr(c, 'text:note-class') || 'footnote' });
        break;
      }
      case 'text:number':
        out.label = textOf(c).trim();
        break;
      case 'text:ruby':
        inlineText(kid(c, 'text:ruby-base') || { children: [] }, out, env);
        break;
      case 'draw:frame':
      case 'draw:a':
      case 'draw:custom-shape':
      case 'draw:g':
      case 'draw:text-box':
        out.boxes.push(c);
        break;
      case 'text:bookmark-ref':
      case 'text:reference-ref':
      default:
        inlineText(c, out, env);
    }
  }
}

/* ---------- the reader ---------- */

function makeEnv() {
  return { page: 1, paged: false, notes: [], listCounters: new Map(), outlineCounters: [] };
}

export async function readOdf(src, ctx) {
  const c = ctx || {};
  const styles = makeStyles();
  let content;
  let meta = null;
  if (typeof src === 'string') content = src;
  else {
    const sx = await src.text('styles.xml');
    if (sx) await walkXml(sx, { collect: new Set(['style:style', 'text:list-style', 'text:outline-style']), skip: new Set(['office:font-face-decls', 'office:master-styles']), onElement: (el) => addStyle(styles, el), pause: c.pause });
    content = await src.text('content.xml');
    meta = await src.text('meta.xml');
    if (content == null) throw Object.assign(new Error('content.xml missing'), { code: 'corrupt' });
  }
  const env = makeEnv();
  const blocks = [];
  const images = c.images || null;
  let presentation = false;
  let title = '';
  let slide = 0;
  let slideBlocks = null;

  const emitPara = (el, into, ctxType, listInfo) => {
    const st = paraStyle(styles, attr(el, 'text:style-name'));
    const kind = kindOf(st);
    if (kind.toc) return;
    const out = { text: '', label: '', boxes: [] };
    const page = env.page;
    inlineText(el, out, env);
    let text = out.text;
    let type;
    if (el.name === 'text:h' || st.outline) {
      const lvl = +attr(el, 'text:outline-level') || st.outline || 1;
      type = 'h' + Math.min(6, lvl);
      // Numbered headings (outline numbering) like "2.1 Methods".
      if (!out.label && styles.outline && attr(el, 'text:is-list-header') !== 'true') {
        const oc = env.outlineCounters;
        oc.length = lvl + 1;
        oc[lvl] = (oc[lvl] || 0) + 1;
        const lab = numberLabel(styles.outline.get(lvl), oc, lvl, styles.outline);
        if (lab) out.label = lab;
      }
    } else if (kind.heading) type = 'h' + kind.heading;
    else if (listInfo) type = 'li';
    else type = kind.type || ctxType || 'p';
    if (listInfo && listInfo.label && !out.label) out.label = listInfo.label;
    if (out.label && text.trim()) text = out.label + ' ' + text.replace(/^ +/, '');
    if (text.trim()) into.push(makeBlock(type, text, { page: presentation ? slide : page, skip: type === 'caption' ? 'caption' : type === 'code' ? 'code' : undefined }));
    for (const box of out.boxes) walkContainer(box, into, ctxType);
  };

  // Lists: counters per list style, continued when the list says so.
  const emitList = (list, into, ctxType, depth, styleName) => {
    const sname = attr(list, 'text:style-name') || styleName;
    const levels = styles.lists.get(sname) || new Map();
    let counters = env.listCounters.get(sname);
    const continues = attr(list, 'text:continue-numbering') === 'true' || attr(list, 'text:continue-list');
    if (!counters || (depth === 1 && !continues)) env.listCounters.set(sname, (counters = []));
    for (const item of kids(list)) {
      if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue;
      let label = '';
      if (item.name === 'text:list-item') {
        const sv = attr(item, 'text:start-value');
        counters.length = depth + 1;
        counters[depth] = sv ? +sv : (counters[depth] || ((levels.get(depth) && levels.get(depth).start) || 1) - 1) + 1;
        label = numberLabel(levels.get(depth), counters, depth, levels);
      }
      let first = true;
      for (const k of kids(item)) {
        if (k.name === 'text:list') emitList(k, into, ctxType, depth + 1, sname);
        else if (k.name === 'text:p' || k.name === 'text:h') {
          emitPara(k, into, ctxType, item.name === 'text:list-item' ? { label: first ? label : '' } : null);
          first = false;
        } else walkContainer(k, into, ctxType);
      }
    }
  };

  const emitTable = (table, into) => {
    const rows = [];
    const collectRows = (n) => {
      for (const k of kids(n)) {
        if (k.name === 'table:table-row') rows.push(k);
        else if (/^table:table-(?:header-rows|rows|row-group)$/.test(k.name)) collectRows(k);
      }
    };
    collectRows(table);
    for (const row of rows) for (const cell of kids(row, 'table:table-cell')) walkContainer(cell, into, 'cell');
  };

  // Any element holding paragraphs (sections, cells, text boxes, shapes).
  const walkContainer = (node, into, ctxType) => {
    if (node.name === 'text:p' || node.name === 'text:h') return emitPara(node, into, ctxType);
    if (node.name === 'text:list') return emitList(node, into, ctxType, 1);
    if (node.name === 'table:table') return emitTable(node, into);
    if (node.name === 'text:soft-page-break') {
      env.page++;
      env.paged = true;
      return;
    }
    for (const k of kids(node)) walkContainer(k, into, ctxType);
  };

  // Presentations: one draw:page per slide, title first, notes after.
  const emitSlide = (pageEl) => {
    slide++;
    if (styles.pages.get(attr(pageEl, 'draw:style-name'))) return; // hidden slide
    const shapes = [];
    for (const k of kids(pageEl)) {
      if (k.name === 'presentation:notes' || k.name === 'office:forms' || k.name === 'draw:page-thumbnail') continue;
      shapes.push(k);
    }
    const isTitle = (s) => attr(s, 'presentation:class') === 'title';
    const furniture = (s) => /^(?:page-number|date-time|header|footer|page)$/.test(attr(s, 'presentation:class') || '');
    const titleText = shapes
      .filter(isTitle)
      .map((s) => {
        const tmp = [];
        walkContainer(s, tmp);
        return tmp.map((b) => b.text).join(' ');
      })
      .join(' ')
      .trim();
    const body = [];
    for (const s of shapes) if (!isTitle(s) && !furniture(s)) walkContainer(s, body, attr(s, 'presentation:class') === 'outline' ? 'li' : undefined);
    const notes = [];
    const notesEl = kid(pageEl, 'presentation:notes');
    if (notesEl) {
      for (const f of kids(notesEl)) {
        if (attr(f, 'presentation:class') !== 'notes') continue;
        const tmp = [];
        walkContainer(f, tmp);
        for (const b of tmp) notes.push(makeBlock('note', b.text, { page: slide }));
      }
    }
    if (!titleText && !body.length && !notes.length) return;
    if (!title && titleText) title = titleText;
    slideBlocks.push(makeBlock('h2', `Slide ${slide}${titleText ? ': ' + titleText : ''}`, { page: slide }), ...body, ...notes);
  };

  await walkXml(content, {
    collect: new Set(['style:style', 'text:list-style', 'text:outline-style', 'office:meta', 'text:h', 'text:p', 'text:list', 'table:table', 'text:soft-page-break', 'draw:page', 'draw:frame', 'draw:custom-shape']),
    // presentation:notes is skipped in documents but needed inside slides, which are collected whole.
    skip: (name, attrs, parent) => {
      if (name === 'presentation:notes') return parent !== 'draw:page';
      if (name === 'draw:image' && images) {
        // Pictures, for a document that is only a pasted-in scan
        const href = attrs()['xlink:href'];
        if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) images.push({ path: href.replace(/^\.\//, ''), page: slide + 1 });
      }
      return hidden(name, attrs);
    },
    pause: c.pause,
    onElement: (el, path) => {
      if (el.name === 'style:style' || el.name === 'text:list-style' || el.name === 'text:outline-style') return addStyle(styles, el);
      if (el.name === 'office:meta') {
        meta = meta || el;
        return;
      }
      if (path.includes('office:presentation') || el.name === 'draw:page') {
        presentation = true;
        if (!slideBlocks) slideBlocks = blocks;
        if (el.name === 'draw:page') emitSlide(el);
        return;
      }
      if (!path.includes('office:text') && !path.includes('office:body')) return;
      walkContainer(el, blocks);
    },
  });

  // Notes at the end, numbered by their marks.
  if (env.notes.length) {
    const noteBlocks = [];
    for (const n of env.notes) {
      const tmp = [];
      walkContainer(n.body, tmp);
      const t = tmp.map((b) => b.text).join('\n');
      if (!t.trim()) continue;
      const text = (n.mark ? n.mark + '. ' : '') + t;
      // Notes that only give a source ("Ibid., p. 4.") are skippable; the rest are read.
      noteBlocks.push(makeBlock('note', text, { skip: isCitation(text) ? 'citation' : undefined }));
    }
    if (noteBlocks.length) blocks.push(makeBlock('h2', 'Notes', { skip: noteBlocks.every((b) => b.skip) ? 'citation' : undefined }), ...noteBlocks);
  }
  if (!presentation && !env.paged) for (const b of blocks) delete b.page;
  if (images && !presentation) for (const im of images) im.page = 0;

  if (meta) {
    const m = typeof meta === 'string' ? await parseXml(meta) : meta;
    const t = usefulTitle(textOf(find(m, 'dc:title')));
    if (t) title = t;
  }
  return { title, blocks, warnings: [], pages: presentation ? slide : env.paged ? env.page : 0, kind: presentation ? 'odp' : 'odt', images: images || [] };
}
