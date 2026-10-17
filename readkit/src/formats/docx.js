// Word (.docx, .docm, .dotx) -> blocks. Reads what a person sees in Word's normal view:
// deleted tracked changes, moved-from text, field codes, hidden text and the fallback copy of
// text boxes are left out; headings come from styles, list numbers are worked out from
// numbering.xml, table cells become 'cell' blocks, and footnotes and endnotes go at the end.

import { makeBlock } from '../doc.js';
import { walkXml, parseXml, kid, kids, findAll, attr } from './xml.js';
import { readRels, relOfType, mainPart, coreProps, appProps } from './opc.js';
import { formatNumber, symbolChar, wingdingsChar, isCitation } from './util.js';

// Never read: old versions of tracked changes, deletions, ruby guide text, section setup.
const SKIP = new Set([
  'mc:Fallback', 'w:moveFrom', 'w:delText', 'w:delInstrText', 'w:pPrChange', 'w:rPrChange', 'w:sectPrChange', 'w:tblPrChange',
  'w:trPrChange', 'w:tcPrChange', 'w:tblGridChange', 'w:numberingChange', 'w:sectPr', 'w:rt', 'w:commentReference', 'w:annotationRef',
]);
// w:del inside a run or row property is a marker (deleted paragraph mark, deleted row), not content.
const skipDocx = (name, attrs, parent) => (name === 'w:del' ? parent !== 'w:rPr' && parent !== 'w:trPr' : SKIP.has(name));

const on = (el) => (el ? !/^(?:0|false|off)$/i.test(attr(el, 'w:val') || '') : undefined);
const val = (el) => attr(el, 'w:val');

function fontKind(rFonts) {
  const f = rFonts && (attr(rFonts, 'w:ascii') || attr(rFonts, 'w:hAnsi') || attr(rFonts, 'w:cs'));
  if (!f) return undefined;
  if (/^symbol$/i.test(f)) return 'symbol';
  if (/^wingdings/i.test(f) || /^webdings$/i.test(f)) return 'wingdings';
  return '';
}

/* ---------- styles ---------- */

async function readStyles(zip, path) {
  const raw = new Map();
  let defaultPara = null;
  const x = path && (await zip.text(path));
  if (x) {
    const root = await parseXml(x, { skip: new Set(['w:latentStyles']) });
    for (const s of kids(root, 'w:style')) {
      const id = attr(s, 'w:styleId');
      if (!id) continue;
      const pPr = kid(s, 'w:pPr');
      const rPr = kid(s, 'w:rPr');
      const numPr = kid(pPr, 'w:numPr');
      const st = {
        type: attr(s, 'w:type') || 'paragraph',
        name: String(val(kid(s, 'w:name')) || id).toLowerCase(),
        basedOn: val(kid(s, 'w:basedOn')),
        outline: val(kid(pPr, 'w:outlineLvl')),
        numId: val(kid(numPr, 'w:numId')),
        ilvl: val(kid(numPr, 'w:ilvl')),
        vanish: on(kid(rPr, 'w:vanish')),
        font: fontKind(kid(rPr, 'w:rFonts')),
      };
      raw.set(id, st);
      if (st.type === 'paragraph' && /^(?:1|true|on)$/i.test(attr(s, 'w:default') || '')) defaultPara = id;
    }
  }
  const memo = new Map();
  // Inherited properties: the nearest style in the basedOn chain that sets them wins.
  const resolve = (id) => {
    if (!id || !raw.has(id)) return null;
    if (memo.has(id)) return memo.get(id);
    const out = { names: [], outline: undefined, numId: undefined, ilvl: undefined, vanish: undefined, font: undefined };
    const seen = new Set();
    for (let s = raw.get(id), sid = id; s && !seen.has(sid); sid = s.basedOn, s = raw.get(s.basedOn)) {
      seen.add(sid);
      out.names.push(s.name);
      for (const k of ['outline', 'numId', 'ilvl', 'vanish', 'font']) if (out[k] === undefined && s[k] != null) out[k] = s[k];
    }
    memo.set(id, out);
    return out;
  };
  // With no styles part (some generators skip it) the style id itself ("Heading1") is the best name.
  const bare = (id) => ({ names: id ? [String(id).toLowerCase()] : [] });
  return { resolve, para: (id) => (id && raw.has(id) ? resolve(id) : (id && bare(id)) || resolve(defaultPara) || bare()) };
}

// Paragraph kind from its style names (own name first, then the styles it is based on).
function styleKind(st) {
  const name = st.names[0] || '';
  if (/^toc \d$|^toc heading$|^table of figures$/.test(name)) return { toc: true };
  for (const n of st.names) {
    const h = /^heading\s*([1-9])$/.exec(n);
    if (h) return { heading: Math.min(6, +h[1]) };
    if (n === 'title') return { heading: 1 };
    if (n === 'subtitle') return { heading: 2 };
  }
  if (/quote|block text/.test(name)) return { type: 'quote' };
  if (name === 'caption') return { type: 'caption' };
  return {};
}

/* ---------- list numbering ---------- */

async function readNumbering(zip, path, styles) {
  const abstracts = new Map();
  const nums = new Map();
  const x = path && (await zip.text(path));
  if (x) {
    const root = await parseXml(x);
    const level = (l) => ({
      start: val(kid(l, 'w:start')) != null ? +val(kid(l, 'w:start')) : 1,
      fmt: val(kid(l, 'w:numFmt')) || 'decimal',
      text: val(kid(l, 'w:lvlText')),
      legal: on(kid(l, 'w:isLgl')),
    });
    for (const a of kids(root, 'w:abstractNum')) {
      const levels = new Map();
      for (const l of kids(a, 'w:lvl')) levels.set(+attr(l, 'w:ilvl') || 0, level(l));
      abstracts.set(attr(a, 'w:abstractNumId'), { levels, link: val(kid(a, 'w:numStyleLink')) });
    }
    for (const nm of kids(root, 'w:num')) {
      const overrides = new Map();
      for (const ov of kids(nm, 'w:lvlOverride')) {
        const so = val(kid(ov, 'w:startOverride'));
        const lv = kid(ov, 'w:lvl');
        overrides.set(+attr(ov, 'w:ilvl') || 0, { start: so != null ? +so : null, lvl: lv ? level(lv) : null });
      }
      nums.set(attr(nm, 'w:numId'), { abs: val(kid(nm, 'w:abstractNumId')), overrides });
    }
  }
  const counters = new Map();
  const started = new Set();
  const absOf = (numId) => {
    let num = nums.get(numId);
    let a = num && abstracts.get(num.abs);
    // A list style link points at the numbering defined by a style.
    for (let hops = 0; a && a.link && hops < 4; hops++) {
      const st = styles.resolve(a.link);
      const linked = st && st.numId && nums.get(st.numId);
      if (!linked || linked === num) break;
      num = linked;
      a = abstracts.get(num.abs);
    }
    return a ? { num, a, key: num.abs } : null;
  };
  // The label Word would show before this paragraph ("1.", "a)", "2.3"), or '' for bullets.
  return (numId, ilvl) => {
    const found = absOf(numId);
    if (!found) return '';
    const { a, key } = found;
    const own = nums.get(numId) || found.num;
    const lv = (k) => (own.overrides.get(k) && own.overrides.get(k).lvl) || a.levels.get(k) || { start: 1, fmt: 'decimal', text: '%' + (k + 1) + '.' };
    let c = counters.get(key);
    if (!c) counters.set(key, (c = []));
    if (!started.has(numId)) {
      started.add(numId);
      for (const [k, ov] of own.overrides) if (ov.start != null) c[k] = ov.start - 1;
    }
    c[ilvl] = c[ilvl] == null ? lv(ilvl).start : c[ilvl] + 1;
    for (let k = ilvl + 1; k < 10; k++) c[k] = undefined;
    const me = lv(ilvl);
    if (me.fmt === 'bullet' || me.fmt === 'none' || !me.text) return '';
    return me.text
      .replace(/%([1-9])/g, (m, d) => {
        const k = +d - 1;
        const v = c[k] == null ? lv(k).start : c[k];
        return formatNumber(v, me.legal ? 'decimal' : lv(k).fmt);
      })
      .trim();
  };
}

/* ---------- paragraphs ---------- */

function makeState() {
  return { fields: [], page: 1, rendered: false, refs: [], carry: '', tocRun: 0 };
}

const fieldHidden = (st) => st.fields.some((f) => f.phase === 'instr' || f.suppress);

// Text-box paragraphs anchored inside this run (outermost w:txbxContent only).
function textBoxes(node, out) {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'w:txbxContent') out.push(c);
    else textBoxes(c, out);
  }
  return out;
}

// Pictures in reading order (for documents that are only a pasted-in scan).
function pictures(node, ctx) {
  for (const n of findAll(node, (x) => x.name === 'a:blip' || x.name === 'v:imagedata')) {
    const id = attr(n, 'r:embed') || attr(n, 'r:id');
    const rel = id && ctx.rels.get(id);
    if (rel && !rel.external && rel.type === 'image' && !ctx.images.some((i) => i.path === rel.target)) ctx.images.push({ path: rel.target });
  }
}

function paraText(p, ctx, st, pstyle, deferred) {
  let out = '';
  const runProps = (r) => {
    const rPr = kid(r, 'w:rPr');
    const cs = ctx.styles.resolve(val(kid(rPr, 'w:rStyle')));
    let hidden = on(kid(rPr, 'w:vanish'));
    if (hidden === undefined) hidden = cs && cs.vanish !== undefined ? cs.vanish : !!pstyle.vanish;
    let font = fontKind(kid(rPr, 'w:rFonts'));
    if (font === undefined) font = (cs && cs.font) || pstyle.font || '';
    return { hidden, font };
  };
  const mapFont = (s, font) => {
    if (!font) return s;
    let t = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      t += c < 0x100 || (c >= 0xf000 && c <= 0xf0ff) ? (font === 'symbol' ? symbolChar(c) : wingdingsChar(c)) : ch;
    }
    return t;
  };
  const run = (r) => {
    const { hidden, font } = runProps(r);
    for (const c of r.children) {
      if (typeof c === 'string') continue;
      switch (c.name) {
        case 'w:t':
        case 'm:t':
          if (!hidden && !fieldHidden(st)) out += mapFont(c.children.join(''), font);
          break;
        case 'w:instrText': {
          const f = st.fields[st.fields.length - 1];
          if (f && f.phase === 'instr') f.instr += c.children.join('');
          break;
        }
        case 'w:fldChar': {
          const type = attr(c, 'w:fldCharType');
          if (type === 'begin') st.fields.push({ phase: 'instr', instr: '', suppress: false });
          else if (type === 'separate') {
            const f = st.fields[st.fields.length - 1];
            if (f) {
              f.phase = 'result';
              // A table of contents or index repeats the headings with page numbers: not worth hearing.
              f.suppress = /^\s*(?:TOC|INDEX)\b/i.test(f.instr);
            }
          } else if (type === 'end') st.fields.pop();
          break;
        }
        case 'w:tab':
        case 'w:ptab':
          if (!hidden && !fieldHidden(st)) out += ' ';
          break;
        case 'w:br':
        case 'w:cr':
          if (!hidden && !fieldHidden(st)) out += '\n';
          break;
        case 'w:noBreakHyphen':
          if (!hidden && !fieldHidden(st)) out += '-';
          break;
        case 'w:sym': {
          const code = parseInt(attr(c, 'w:char') || '', 16);
          const f = /wingdings|webdings/i.test(attr(c, 'w:font') || '') ? 'wingdings' : 'symbol';
          if (code && !hidden && !fieldHidden(st)) out += code >= 0xf000 || code < 0x100 ? (f === 'symbol' ? symbolChar(code) : wingdingsChar(code)) : String.fromCodePoint(code);
          break;
        }
        case 'w:lastRenderedPageBreak':
          st.page++;
          st.rendered = true;
          break;
        case 'w:footnoteReference':
        case 'w:endnoteReference':
          if (!ctx.inNote) st.refs.push((c.name === 'w:footnoteReference' ? 'f' : 'e') + attr(c, 'w:id'));
          break;
        case 'w:drawing':
        case 'w:pict':
        case 'w:object':
        case 'mc:AlternateContent':
          for (const box of textBoxes(c, [])) deferred.push(box);
          if (ctx.images && !hidden) pictures(c, ctx);
          break;
        case 'w:ruby': {
          const base = kid(c, 'w:rubyBase');
          if (base) inline(base);
          break;
        }
        default:
          break;
      }
    }
  };
  const inline = (node) => {
    for (const c of node.children) {
      if (typeof c === 'string') continue;
      const n = c.name;
      if (n === 'w:r' || n === 'm:r') run(c);
      else if (n === 'w:pPr' || n === 'w:rPr' || n === 'm:rPr' || n === 'm:ctrlPr' || n === 'w:sdtPr' || n === 'w:sdtEndPr') continue;
      else if (n === 'w:txbxContent') deferred.push(c);
      else if (n === 'w:p') deferred.push({ name: 'w:txbxContent', attrs: {}, children: [c] });
      else if (n === 'w:fldSimple') {
        if (!/^\s*(?:TOC|INDEX)\b/i.test(attr(c, 'w:instr') || '')) inline(c);
      } else inline(c);
    }
  };
  inline(p);
  return out;
}

/* ---------- reader ---------- */

export async function readDocx(zip, ctx) {
  const c = ctx || {};
  const main = await mainPart(zip, 'word/document.xml');
  const rels = await readRels(zip, main);
  const styles = await readStyles(zip, relOfType(rels, 'styles') || 'word/styles.xml');
  const label = await readNumbering(zip, relOfType(rels, 'numbering') || 'word/numbering.xml', styles);
  const env = { styles, inNote: false, rels, images: c.images || null };
  const st = makeState();
  const blocks = [];
  const warnings = [];

  const emitPara = (p, inCell, into, state) => {
    const pPr = kid(p, 'w:pPr');
    const pstyle = styles.para(val(kid(pPr, 'w:pStyle')));
    const kind = styleKind(pstyle);
    const deferred = [];
    const page = state.page;
    let text = paraText(p, env, state, pstyle, deferred);
    if (state.carry) {
      text = state.carry + text;
      state.carry = '';
    }
    // A deleted paragraph mark joins this paragraph's text to the next one.
    if (kid(kid(pPr, 'w:rPr'), 'w:del')) state.carry = text;
    else if (!kind.toc) {
      const outlineRaw = val(kid(pPr, 'w:outlineLvl')) != null ? val(kid(pPr, 'w:outlineLvl')) : pstyle.outline;
      const outline = outlineRaw != null && +outlineRaw < 9 ? Math.min(6, +outlineRaw + 1) : 0;
      let heading = kind.heading || outline;
      if (heading && text.length > 250) heading = 0; // body text that was given an outline level
      if (heading && state.fields.some((f) => f.suppress)) state.fields = state.fields.filter((f) => !f.suppress); // a TOC never contains real headings
      const numPr = kid(pPr, 'w:numPr');
      const numId = numPr ? val(kid(numPr, 'w:numId')) : pstyle.numId;
      const ilvl = +((numPr && val(kid(numPr, 'w:ilvl'))) || pstyle.ilvl || 0);
      let type = heading ? 'h' + heading : kind.type || (inCell ? 'cell' : 'p');
      if (numId && numId !== '0' && text.trim()) {
        const lab = label(numId, Math.min(9, ilvl));
        if (lab) text = lab + ' ' + text;
        if (!heading) type = 'li';
      }
      if (text.trim()) into.push(makeBlock(type, text, { page, skip: type === 'caption' ? 'caption' : undefined }));
    }
    for (const box of deferred) {
      for (const k of box.children) {
        if (typeof k === 'string') continue;
        if (k.name === 'w:p') emitPara(k, false, into, state);
        else if (k.name === 'w:tbl') emitTable(k, into, state);
      }
    }
  };

  // Rows, cells and their content, looking through content controls and custom XML wrappers.
  const within = (node, name, out) => {
    for (const k of node.children) {
      if (typeof k === 'string') continue;
      if (k.name === name) out.push(k);
      else if (k.name === 'w:sdt' || k.name === 'w:sdtContent' || k.name === 'w:customXml' || k.name === 'w:smartTag') within(k, name, out);
    }
    return out;
  };
  const emitTable = (tbl, into, state) => {
    for (const row of within(tbl, 'w:tr', [])) {
      if (kid(kid(row, 'w:trPr'), 'w:del')) continue; // a deleted row
      for (const cell of within(row, 'w:tc', [])) {
        for (const k of cell.children) {
          if (typeof k === 'string') continue;
          if (k.name === 'w:p') emitPara(k, true, into, state);
          else if (k.name === 'w:tbl') emitTable(k, into, state);
          else if (k.name === 'w:sdt' || k.name === 'w:customXml') {
            for (const p of within(k, 'w:p', [])) emitPara(p, true, into, state);
          }
        }
      }
    }
  };

  const xml = await zip.text(main);
  if (xml == null) throw Object.assign(new Error('word/document.xml missing'), { code: 'corrupt' });
  await walkXml(xml, {
    collect: new Set(['w:p', 'w:tbl']),
    skip: skipDocx,
    pause: c.pause,
    onElement: (node) => {
      if (node.name === 'w:p') emitPara(node, false, blocks, st);
      else emitTable(node, blocks, st);
    },
  });
  if (st.carry) blocks.push(makeBlock('p', st.carry, { page: st.page }));
  if (!st.rendered) for (const b of blocks) delete b.page;

  // Footnotes and endnotes, in the order the text refers to them.
  const notes = new Map();
  env.inNote = true;
  const images = env.images || [];
  env.images = null;
  for (const [kindKey, type, tag] of [['f', 'footnotes', 'w:footnote'], ['e', 'endnotes', 'w:endnote']]) {
    const path = relOfType(rels, type) || 'word/' + type + '.xml';
    const nx = await zip.text(path);
    if (!nx) continue;
    await walkXml(nx, {
      collect: new Set([tag]),
      skip: skipDocx,
      pause: c.pause,
      onElement: (node) => {
        if (attr(node, 'w:type') && attr(node, 'w:type') !== 'normal') return; // separators
        const parts = [];
        const ns = makeState();
        for (const k of node.children) {
          if (typeof k === 'string') continue;
          if (k.name === 'w:p' || k.name === 'w:tbl') {
            const tmp = [];
            if (k.name === 'w:p') emitPara(k, false, tmp, ns);
            else emitTable(k, tmp, ns);
            for (const b of tmp) parts.push(b.text);
          }
        }
        const t = parts.join('\n').trim();
        if (t) notes.set(kindKey + attr(node, 'w:id'), t);
      },
    });
  }
  const seen = new Set();
  const noteBlocks = [];
  let fn = 0;
  let en = 0;
  for (const ref of st.refs) {
    if (seen.has(ref) || !notes.has(ref)) continue;
    seen.add(ref);
    const mark = ref[0] === 'f' ? String(++fn) : formatNumber(++en, 'lowerRoman');
    const text = mark + '. ' + notes.get(ref);
    // Footnotes that only give a source ("Ibid., p. 4.") are skippable; the rest are read.
    noteBlocks.push(makeBlock('note', text, { skip: isCitation(text) ? 'citation' : undefined }));
  }
  if (noteBlocks.length) blocks.push(makeBlock('h2', 'Notes', { skip: noteBlocks.every((b) => b.skip) ? 'citation' : undefined }), ...noteBlocks);

  const core = await coreProps(zip);
  const app = await appProps(zip);
  return { title: core.title || '', blocks, warnings, pages: app.pages || (st.rendered ? st.page : 0), images };
}
