// EPUB 2 and 3 -> blocks, chapter by chapter in spine order (never manifest or file order).
// The navigation document, non-linear items, page-number markers and footnote marks are
// left out; footnotes move to the end of their chapter. DRM is detected from
// META-INF/encryption.xml, where font obfuscation alone is harmless and is not DRM.

import { parseXml, findAll, find, textOf, attr } from './xml.js';
import { resolvePath } from './util.js';
import { decodeText, declaredCharset } from './text.js';
import { domToBlocks } from './dom.js';
import { markReferences } from '../doc.js';
import { stripHtml } from './html.js';
import { usefulTitle } from './opc.js';
import { MAX_TEXT } from './zip.js';

const FONT_OBFUSCATION = /^(?:http:\/\/www\.idpf\.org\/2008\/embedding|http:\/\/ns\.adobe\.com\/pdf\/enc#RC)$/;
const local = (n) => n.name.slice(n.name.indexOf(':') + 1);

// Paths of content files that are really encrypted (DRM), and whether DRM markers exist.
async function encryptedParts(zip) {
  const out = new Set();
  const x = await zip.text('META-INF/encryption.xml');
  if (x) {
    const root = await parseXml(x);
    for (const ed of findAll(root, (n) => local(n) === 'EncryptedData')) {
      const method = find(ed, (n) => local(n) === 'EncryptionMethod');
      if (FONT_OBFUSCATION.test(attr(method, 'Algorithm') || '')) continue;
      const ref = find(ed, (n) => local(n) === 'CipherReference');
      const uri = ref && attr(ref, 'URI');
      if (uri) out.add(resolvePath('', uri));
    }
  }
  const marked = zip.has('META-INF/rights.xml') || zip.has('META-INF/license.lcpl') || zip.has('META-INF/sinf.xml');
  return { parts: out, marked };
}

function parseChapter(text) {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  // HTML entities such as &nbsp; break strict XML; read those chapters as HTML.
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

const DRM_TEXT = 'This book is protected by DRM, so it can’t be read here. Books bought from stores like Kindle, Kobo, Apple Books or Google Play usually are. A DRM-free copy (many publishers and Project Gutenberg offer one) will work.';

// ctx: { pause, onProgress, onBlocks(blocks) }
export async function readEpub(zip, ctx) {
  const c = ctx || {};
  const warnings = [];
  let opfPath = null;
  const container = await zip.text('META-INF/container.xml');
  if (container) {
    const root = await parseXml(container);
    const files = findAll(root, (n) => local(n) === 'rootfile');
    const rf = files.find((r) => /oebps-package/.test(attr(r, 'media-type') || '')) || files[0];
    opfPath = rf ? attr(rf, 'full-path') : null;
  }
  if (!opfPath || !zip.has(opfPath)) opfPath = zip.names.find((n) => /\.opf$/i.test(n)) || null;
  if (!opfPath) throw Object.assign(new Error('no package document'), { code: 'corrupt' });
  opfPath = zip.entry(opfPath).name;
  const opf = await parseXml(await zip.text(opfPath));

  // Title: EPUB 3 may mark one dc:title as the main title.
  const titles = findAll(opf, 'dc:title');
  const mainId = findAll(opf, (n) => local(n) === 'meta' && attr(n, 'property') === 'title-type' && textOf(n).trim() === 'main').map((m) => (attr(m, 'refines') || '').replace(/^#/, ''))[0];
  const titleEl = (mainId && titles.find((t) => attr(t, 'id') === mainId)) || titles[0];
  const title = usefulTitle(textOf(titleEl));

  const manifest = new Map();
  for (const it of findAll(opf, (n) => local(n) === 'item')) {
    const href = attr(it, 'href');
    if (!href || !attr(it, 'id')) continue;
    manifest.set(attr(it, 'id'), { path: resolvePath(opfPath, href), type: attr(it, 'media-type') || '', props: attr(it, 'properties') || '' });
  }
  const spine = [];
  for (const ref of findAll(opf, (n) => local(n) === 'itemref')) {
    if (attr(ref, 'linear') === 'no') continue;
    const item = manifest.get(attr(ref, 'idref'));
    if (!item || !item.path) continue;
    if (/\bnav\b/.test(item.props)) continue; // the table of contents
    if (item.type && !/html|xml|oeb/.test(item.type)) continue;
    if (/svg/.test(item.type)) continue;
    spine.push(item.path);
  }

  const drm = await encryptedParts(zip);
  const locked = spine.filter((p) => drm.parts.has(p));
  if (locked.length && locked.length === spine.length) {
    return { title, blocks: [], warnings: [{ type: 'drm', text: DRM_TEXT }], pages: 0, refused: 'drm' };
  }
  if (locked.length) warnings.push({ type: 'drm', text: `${locked.length} of the ${spine.length} parts of this book are DRM-protected and were left out.` });

  const blocks = [];
  let chapter = 0;
  // (a part too big to read safely is left out and said so; any other failure skips the part)
  let big = 0;
  const read = (path) =>
    drm.parts.has(path)
      ? Promise.resolve(null)
      : zip.bytes(path, MAX_TEXT).catch((e) => {
          if (e && e.code === 'too-large') big++;
          return null;
        });
  let next = spine.length ? read(spine[0]) : null;
  for (let k = 0; k < spine.length; k++) {
    if (c.onProgress) c.onProgress({ stage: 'parse', done: k, total: spine.length, message: `Reading part ${k + 1} of ${spine.length}` });
    const bytes = await next;
    next = k + 1 < spine.length ? read(spine[k + 1]) : null;
    if (!bytes || !bytes.length) continue;
    if (c.pause) await c.pause();
    const text = decodeText(bytes, { charset: declaredCharset(bytes) }).text;
    let got;
    if (typeof DOMParser !== 'undefined') {
      const doc = parseChapter(text);
      const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
      // Pictures in reading order, for a book that is only page scans (comics, fixed layout)
      if (c.images) {
        for (const el of body.querySelectorAll('img, image')) {
          const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          const p = src && resolvePath(spine[k], src);
          if (p && !c.images.some((im) => im.path === p)) c.images.push({ path: p });
        }
      }
      got = await domToBlocks(body, { mode: 'content', page: chapter + 1, notes: true, pause: c.pause, source: 'markup' });
    } else {
      got = stripHtml(text).blocks;
      for (const b of got) b.page = chapter + 1;
    }
    if (!got.length) continue;
    chapter++;
    for (const b of got) blocks.push(b);
    markReferences(got);
    if (c.onBlocks) c.onBlocks(got);
  }
  if (!blocks.length && drm.marked && drm.parts.size) return { title, blocks: [], warnings: [{ type: 'drm', text: DRM_TEXT }], pages: 0, refused: 'drm' };
  if (big) warnings.push({ type: 'truncated', text: `${big} of the ${spine.length} parts of this book unpack to more data than can be read safely and were left out.` });
  return { title, blocks, warnings, pages: chapter, images: c.images || [] };
}
