// Open Packaging Conventions (the ZIP-of-XML layout DOCX and PPTX share): relationships,
// the main part, and document properties.

import { parseXml, kids, kid, textOf, attr } from './xml.js';
import { resolvePath } from './util.js';

export function relsPath(part) {
  const i = part.lastIndexOf('/');
  return part.slice(0, i + 1) + '_rels/' + part.slice(i + 1) + '.rels';
}

// part -> Map rId -> { type (last path segment, e.g. 'slide'), target (resolved part path), external }
export async function readRels(zip, part) {
  const map = new Map();
  const x = await zip.text(relsPath(part));
  if (!x) return map;
  const root = await parseXml(x);
  for (const r of kids(root)) {
    if (!/Relationship$/.test(r.name)) continue;
    const external = attr(r, 'TargetMode') === 'External';
    const type = String(attr(r, 'Type') || '').split('/').pop();
    const target = external ? attr(r, 'Target') : resolvePath(part, attr(r, 'Target'));
    if (attr(r, 'Id')) map.set(attr(r, 'Id'), { type, target, external });
  }
  return map;
}

export function relOfType(rels, type) {
  for (const r of rels.values()) if (r.type === type && !r.external) return r.target;
  return null;
}

export async function mainPart(zip, fallback) {
  const rels = await readRels(zip, '');
  return relOfType(rels, 'officeDocument') || fallback;
}

// Metadata titles that say nothing ("Microsoft Word - draft.docx", "Untitled") are ignored.
export function usefulTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 200) return '';
  if (/^(?:untitled|document\s*\d*|doc\d*|title|presentation\s*\d*|powerpoint presentation|slide\s*\d+|unknown|none|default|new document|microsoft (?:word|powerpoint)\b.*|.*\.(?:docx?|pptx?|odt|rtf|pdf|txt|epub|html?))$/i.test(s)) return '';
  if (/^[A-Z]:\\|^\//.test(s)) return '';
  return s;
}

export async function coreProps(zip) {
  const x = await zip.text('docProps/core.xml');
  if (!x) return {};
  const root = await parseXml(x);
  return { title: usefulTitle(textOf(kid(root, 'dc:title'))), author: textOf(kid(root, 'dc:creator')).trim() };
}

export async function appProps(zip) {
  const x = await zip.text('docProps/app.xml');
  if (!x) return {};
  const root = await parseXml(x);
  const n = (name) => parseInt(textOf(kid(root, name)), 10) || 0;
  return { pages: n('ep:Pages'), slides: n('ep:Slides') };
}
