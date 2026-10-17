// PowerPoint (.pptx, .ppsx, .potx) -> blocks. Slides come in true order (presentation.xml's
// slide list, never file names) and hidden slides are left out. On each slide the title comes
// first, then the other text in reading order (top to bottom, left to right), tables cell by
// cell, SmartArt text, and the speaker notes last.

import { makeBlock } from '../doc.js';
import { parseXml, kid, kids, find, findAll, textOf, attr } from './xml.js';
import { readRels, relOfType, mainPart, coreProps } from './opc.js';
import { formatNumber } from './util.js';

const AUTONUM = /^(alphaLc|alphaUc|arabic|romanLc|romanUc)(Paren[BR]|Period|Plain)/;

function autoLabel(type, n) {
  const m = AUTONUM.exec(type || 'arabicPeriod') || [0, 'arabic', 'Period'];
  const num = formatNumber(n, m[1]);
  return m[2] === 'ParenBoth' ? '(' + num + ')' : m[2] === 'ParenR' ? num + ')' : m[2] === 'Plain' ? num : num + '.';
}

// One a:p -> { text, lvl, bullet: 'none' | 'char' | 'num' | undefined (inherit), numType, start }
function readPara(p) {
  const pPr = kid(p, 'a:pPr');
  let text = '';
  for (const c of p.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'a:r') text += textOf(kid(c, 'a:t'));
    else if (c.name === 'a:br') text += '\n';
    else if (c.name === 'a:fld') {
      // Slide numbers and dates are layout furniture, not content.
      if (!/^(?:slidenum|datetime\d*)$/i.test(attr(c, 'type') || '')) text += textOf(kid(c, 'a:t'));
    }
  }
  let bullet;
  let numType;
  let start = 1;
  if (pPr) {
    if (kid(pPr, 'a:buNone')) bullet = 'none';
    else if (kid(pPr, 'a:buAutoNum')) {
      bullet = 'num';
      numType = attr(kid(pPr, 'a:buAutoNum'), 'type');
      start = +attr(kid(pPr, 'a:buAutoNum'), 'startAt') || 1;
    } else if (kid(pPr, 'a:buChar') || kid(pPr, 'a:buBlip')) bullet = 'char';
  }
  return { text, lvl: +attr(pPr, 'lvl') || 0, bullet, numType, start };
}

// Bullets per level from a list style (a:lstStyle, p:bodyStyle): true, false or undefined.
function levelBullets(lst) {
  const out = [];
  if (!lst) return out;
  for (let i = 0; i < 9; i++) {
    const l = kid(lst, 'a:lvl' + (i + 1) + 'pPr');
    if (!l) continue;
    if (kid(l, 'a:buNone')) out[i] = false;
    else if (kid(l, 'a:buChar') || kid(l, 'a:buAutoNum') || kid(l, 'a:buBlip')) out[i] = true;
  }
  return out;
}

function posOf(x) {
  const off = kid(x, 'a:off');
  const ext = kid(x, 'a:ext');
  if (!off) return null;
  return { x: +attr(off, 'x') || 0, y: +attr(off, 'y') || 0, w: +attr(ext, 'cx') || 0, h: +attr(ext, 'cy') || 0 };
}

function phOf(nv) {
  const ph = nv && find(nv, 'p:ph');
  return ph ? { type: attr(ph, 'type') || 'obj', idx: attr(ph, 'idx') } : null;
}

// Placeholder positions and bullet defaults from a slide layout (cached per layout part).
async function layoutInfo(zip, path, cache) {
  if (!path) return null;
  if (cache.has(path)) return cache.get(path);
  const info = { byIdx: new Map(), byType: new Map(), master: null };
  cache.set(path, info);
  const x = await zip.text(path);
  if (!x) return info;
  const root = await parseXml(x);
  for (const sp of findAll(root, 'p:sp')) {
    const ph = phOf(kid(sp, 'p:nvSpPr'));
    if (!ph) continue;
    const rec = { pos: posOf(kid(kid(sp, 'p:spPr'), 'a:xfrm')), bullets: levelBullets(kid(kid(sp, 'p:txBody'), 'a:lstStyle')) };
    if (ph.idx != null) info.byIdx.set(ph.idx, rec);
    if (!info.byType.has(ph.type)) info.byType.set(ph.type, rec);
  }
  const rels = await readRels(zip, path);
  const masterPath = relOfType(rels, 'slideMaster');
  if (masterPath) {
    if (!cache.has(masterPath)) {
      const mx = await zip.text(masterPath);
      const m = { body: [] };
      if (mx) {
        const mroot = await parseXml(mx);
        m.body = levelBullets(find(mroot, 'p:bodyStyle'));
      }
      cache.set(masterPath, m);
    }
    info.master = cache.get(masterPath);
  }
  return info;
}

// Flattens the shape tree into text-bearing shapes with page positions.
function collectShapes(tree, out, tf) {
  for (const c of tree.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'mc:AlternateContent') {
      const choice = kid(c, 'mc:Choice');
      if (choice) collectShapes(choice, out, tf);
    } else if (c.name === 'p:grpSp') {
      // Child offsets are in the group's own coordinate space.
      const g = kid(kid(c, 'p:grpSpPr'), 'a:xfrm');
      const off = kid(g, 'a:off');
      const ext = kid(g, 'a:ext');
      const choff = kid(g, 'a:chOff');
      const chext = kid(g, 'a:chExt');
      let t = tf;
      if (off && choff) {
        const sx = chext && +attr(chext, 'cx') ? (+attr(ext, 'cx') || 0) / +attr(chext, 'cx') : 1;
        const sy = chext && +attr(chext, 'cy') ? (+attr(ext, 'cy') || 0) / +attr(chext, 'cy') : 1;
        const ox = +attr(off, 'x') - +attr(choff, 'x') * sx;
        const oy = +attr(off, 'y') - +attr(choff, 'y') * sy;
        t = { sx: tf.sx * sx, sy: tf.sy * sy, ox: tf.ox + ox * tf.sx, oy: tf.oy + oy * tf.sy };
      }
      collectShapes(c, out, t);
    } else if (c.name === 'p:sp' || c.name === 'p:graphicFrame') {
      const nv = kid(c, c.name === 'p:sp' ? 'p:nvSpPr' : 'p:nvGraphicFramePr');
      const cNvPr = kid(nv, 'p:cNvPr');
      if (/^(?:1|true)$/.test(attr(cNvPr, 'hidden') || '')) continue;
      const raw = posOf(c.name === 'p:sp' ? kid(kid(c, 'p:spPr'), 'a:xfrm') : kid(c, 'p:xfrm'));
      const pos = raw ? { x: tf.ox + raw.x * tf.sx, y: tf.oy + raw.y * tf.sy, w: raw.w * tf.sx, h: raw.h * tf.sy } : null;
      out.push({ node: c, ph: phOf(nv), pos, textBox: /^(?:1|true)$/.test(attr(kid(nv, 'p:cNvSpPr'), 'txBox') || ''), order: out.length });
    }
  }
  return out;
}

// Reading order: top to bottom; shapes that sit side by side (overlapping vertically) left to right.
function byPosition(a, b) {
  if (!a.pos || !b.pos) return a.order - b.order;
  const top = Math.max(a.pos.y, b.pos.y);
  const bottom = Math.min(a.pos.y + a.pos.h, b.pos.y + b.pos.h);
  const overlap = bottom - top;
  const minH = Math.min(a.pos.h, b.pos.h) || 1;
  if (overlap > minH * 0.5) return a.pos.x - b.pos.x || a.order - b.order;
  return a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.order - b.order;
}

function bodyParas(txBody, defaults) {
  const out = [];
  if (!txBody) return out;
  const own = levelBullets(kid(txBody, 'a:lstStyle'));
  const counters = [];
  for (const p of kids(txBody, 'a:p')) {
    const para = readPara(p);
    const text = para.text.trimEnd();
    let bullet = para.bullet;
    if (bullet === undefined) {
      const inherited = own[para.lvl] !== undefined ? own[para.lvl] : defaults[para.lvl];
      bullet = inherited ? 'char' : 'none';
    }
    if (!text.trim()) {
      if (bullet !== 'num') counters.length = 0;
      continue;
    }
    let label = '';
    if (bullet === 'num') {
      counters.length = para.lvl + 1;
      counters[para.lvl] = counters[para.lvl] ? counters[para.lvl] + 1 : para.start;
      label = autoLabel(para.numType, counters[para.lvl]) + ' ';
    } else counters.length = para.lvl;
    out.push({ text: label + text, li: bullet !== 'none' });
  }
  return out;
}

async function smartArtText(zip, slidePath, slideRels, frame) {
  const ids = find(frame, 'dgm:relIds');
  const rel = ids && slideRels.get(attr(ids, 'r:dm'));
  if (!rel || rel.external) return [];
  const x = await zip.text(rel.target);
  if (!x) return [];
  const root = await parseXml(x);
  const out = [];
  for (const pt of findAll(root, 'dgm:pt')) {
    const type = attr(pt, 'type') || 'node';
    if (type !== 'node' && type !== 'asst') continue;
    const t = kid(pt, 'dgm:t');
    for (const p of kids(t, 'a:p')) {
      const s = readPara(p).text.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export async function readPptx(zip, ctx) {
  const c = ctx || {};
  const presPath = await mainPart(zip, 'ppt/presentation.xml');
  const presXml = await zip.text(presPath);
  if (presXml == null) throw Object.assign(new Error('presentation.xml missing'), { code: 'corrupt' });
  const pres = await parseXml(presXml);
  const rels = await readRels(zip, presPath);
  let slides = findAll(find(pres, 'p:sldIdLst'), 'p:sldId')
    .map((s) => rels.get(attr(s, 'r:id')))
    .filter((r) => r && !r.external)
    .map((r) => r.target);
  // A deck whose slide list is missing: fall back to file order by number (slide2 before slide10).
  if (!slides.length) {
    slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => +a.match(/(\d+)\.xml$/i)[1] - +b.match(/(\d+)\.xml$/i)[1]);
  }
  const blocks = [];
  const images = c.images || null;
  const cache = new Map();
  let firstTitle = '';
  let shown = 0;
  for (let n = 0; n < slides.length; n++) {
    if (c.onProgress) c.onProgress({ stage: 'parse', done: n, total: slides.length, message: `Reading slide ${n + 1} of ${slides.length}` });
    if (c.pause) await c.pause();
    const slidePath = slides[n];
    const sx = await zip.text(slidePath);
    if (!sx) continue;
    const root = await parseXml(sx, { pause: c.pause });
    if (attr(root, 'show') === '0' || attr(root, 'show') === 'false') continue; // hidden slide
    shown++;
    const page = n + 1; // PowerPoint numbers hidden slides too
    const slideRels = await readRels(zip, slidePath);
    const layout = await layoutInfo(zip, relOfType(slideRels, 'slideLayout'), cache);
    const tree = find(root, 'p:spTree');
    const shapes = tree ? collectShapes(tree, [], { sx: 1, sy: 1, ox: 0, oy: 0 }) : [];
    // Pictures, for a deck that is only scanned pages
    if (images && tree) {
      for (const pic of findAll(tree, 'p:pic')) {
        const blip = find(pic, 'a:blip');
        const rel = blip && slideRels.get(attr(blip, 'r:embed'));
        if (rel && !rel.external && rel.type === 'image') images.push({ path: rel.target, page });
      }
    }
    for (const s of shapes) {
      const lay = s.ph && layout ? (s.ph.idx != null && layout.byIdx.get(s.ph.idx)) || layout.byType.get(s.ph.type) : null;
      if (!s.pos && lay && lay.pos) s.pos = lay.pos;
      s.lay = lay;
    }
    const isTitle = (s) => s.ph && (s.ph.type === 'title' || s.ph.type === 'ctrTitle');
    const titles = shapes.filter(isTitle);
    const rest = shapes.filter((s) => !isTitle(s)).sort(byPosition);
    const title = titles.map((s) => bodyParas(kid(s.node, 'p:txBody'), []).map((p) => p.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim();
    const body = [];
    for (const s of rest) {
      const type = s.ph ? s.ph.type : '';
      if (type === 'sldNum' || type === 'dt' || type === 'sldImg' || type === 'hdr') continue;
      if (s.node.name === 'p:graphicFrame') {
        const tbl = find(s.node, 'a:tbl');
        if (tbl) {
          for (const tr of kids(tbl, 'a:tr')) {
            for (const tc of kids(tr, 'a:tc')) {
              if (/^(?:1|true)$/.test(attr(tc, 'hMerge') || attr(tc, 'vMerge') || '')) continue;
              const t = bodyParas(kid(tc, 'a:txBody'), []).map((p) => p.text).join('\n');
              if (t.trim()) body.push(makeBlock('cell', t, { page }));
            }
          }
        } else if (find(s.node, 'dgm:relIds')) {
          for (const t of await smartArtText(zip, slidePath, slideRels, s.node)) body.push(makeBlock('li', t, { page }));
        }
        continue;
      }
      // Body placeholders inherit bullets from the layout or the master; plain text boxes don't.
      const bodyLike = s.ph && !s.textBox && type !== 'subTitle' && type !== 'ftr';
      const defaults = bodyLike ? Object.assign([], (layout && layout.master && layout.master.body) || [true, true, true, true, true], (s.lay && s.lay.bullets) || []) : (s.lay && s.lay.bullets) || [];
      for (const p of bodyParas(kid(s.node, 'p:txBody'), defaults)) {
        body.push(makeBlock(type === 'ftr' ? 'p' : p.li ? 'li' : 'p', p.text, { page, skip: type === 'ftr' ? 'footer' : undefined }));
      }
    }
    // Speaker notes: only the notes body, not the slide image or the number.
    const notes = [];
    const notesPath = relOfType(slideRels, 'notesSlide');
    if (notesPath) {
      const nx = await zip.text(notesPath);
      if (nx) {
        const nroot = await parseXml(nx);
        const sps = findAll(nroot, 'p:sp').map((sp) => ({ sp, ph: phOf(kid(sp, 'p:nvSpPr')) }));
        // Normally the notes sit in the body placeholder; files from other tools may have none.
        const hasBody = sps.some((s) => s.ph && s.ph.type === 'body');
        for (const { sp, ph } of sps) {
          if (hasBody ? !ph || ph.type !== 'body' : ph && /^(?:sldNum|sldImg|hdr|ftr|dt)$/.test(ph.type)) continue;
          for (const p of bodyParas(kid(sp, 'p:txBody'), [])) if (hasBody || !/^\d+$/.test(p.text.trim())) notes.push(makeBlock('note', p.text, { page }));
        }
      }
    }
    if (!title && !body.length && !notes.length) continue;
    if (title && !firstTitle) firstTitle = title;
    blocks.push(makeBlock('h2', `Slide ${page}${title ? ': ' + title : ''}`, { page }));
    blocks.push(...body.filter((b) => b.text), ...notes.filter((b) => b.text));
  }
  const core = await coreProps(zip);
  return { title: core.title || firstTitle, blocks, warnings: [], pages: shown, images: images || [] };
}
