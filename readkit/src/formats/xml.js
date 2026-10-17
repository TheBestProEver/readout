// A small streaming XML reader for OOXML, ODF and EPUB package files. DOMParser only exists
// on the main thread and parses a whole part in one go (a 10 MB document.xml freezes the page);
// this reader yields while it works, runs in workers and Node, and only builds small trees
// for the elements a format asks for. It is namespace-aware: names come back with a fixed
// prefix per namespace ('w:p', 'a:t', 'text:h'), whatever prefix the file used. It is lenient
// with broken files and never validates.

const NS = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rel',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup': 'wpg',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://schemas.microsoft.com/office/drawing/2008/diagram': 'dsp',
  'http://schemas.openxmlformats.org/package/2006/metadata/core-properties': 'cp',
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties': 'ep',
  'http://purl.oclc.org/ooxml/officeDocument/extendedProperties': 'ep',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0': 'presentation',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
  'urn:oasis:names:tc:opendocument:xmlns:meta:1.0': 'meta',
  'http://www.idpf.org/2007/opf': 'opf',
  'urn:oasis:names:tc:opendocument:xmlns:container': 'container',
  'http://www.w3.org/2001/04/xmlenc#': 'enc',
  'http://www.w3.org/2000/09/xmldsig#': 'ds',
  'http://www.w3.org/1999/xhtml': 'html',
  'http://www.idpf.org/2007/ops': 'epub',
  'http://www.daisy.org/z3986/2005/ncx/': 'ncx',
  'http://www.w3.org/XML/1998/namespace': 'xml',
};

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, e) => {
    if (e[0] !== '#') return ENT[e] !== undefined ? ENT[e] : m;
    const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : '';
  });
}

const ROOT_SCOPE = { map: new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]), el: new Map(), at: new Map() };

function canon(scope, raw, isAttr) {
  const cache = isAttr ? scope.at : scope.el;
  let v = cache.get(raw);
  if (v !== undefined) return v;
  const c = raw.indexOf(':');
  if (c < 0) {
    const uri = isAttr ? undefined : scope.map.get('');
    const p = uri === undefined ? '' : NS[uri];
    v = p ? p + ':' + raw : raw;
  } else {
    const prefix = raw.slice(0, c);
    const uri = scope.map.get(prefix);
    const p = uri === undefined ? prefix : NS[uri] || prefix;
    v = p + ':' + raw.slice(c + 1);
  }
  cache.set(raw, v);
  return v;
}

const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * Streams through `xml`. For every element whose name is in `collect` (outermost only), a
 * tree { name, attrs, children: (node | string)[] } is built and passed to
 * onElement(node, ancestors). Elements in `skip` (a Set, or (name, getAttrs, parentName) =>
 * boolean) are passed over with everything inside them. collect = null builds the whole document and
 * returns its root.
 */
export async function walkXml(xml, opts) {
  const o = opts || {};
  const collect = o.collect || null;
  const skip = o.skip || null;
  const skipFn = typeof skip === 'function' ? skip : skip ? (name) => skip.has(name) : null;
  const onElement = o.onElement || (() => {});
  const pause = o.pause;
  const n = xml.length;
  const names = []; // raw names of open elements
  const path = []; // canonical names of open elements
  const scopes = [];
  const nodes = []; // node for each open element (null outside collected trees)
  let scope = ROOT_SCOPE;
  let cur = null;
  let collectAt = -1;
  let skipAt = -1;
  let root = null;
  let ticks = 0;
  let i = 0;

  const close = () => {
    names.pop();
    path.pop();
    scope = scopes.pop();
    const node = nodes.pop();
    if (skipAt >= 0) {
      if (names.length === skipAt) skipAt = -1;
      return;
    }
    if (node && names.length === collectAt) {
      collectAt = -1;
      cur = null;
      if (collect) onElement(node, path.slice());
      else root = node;
    } else if (node) cur = nodes[nodes.length - 1];
  };

  while (i < n) {
    if (++ticks >= 512) {
      ticks = 0;
      if (pause) await pause();
    }
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i && cur && skipAt < 0) cur.children.push(decodeEntities(xml.slice(i, textEnd)));
    if (lt < 0) break;
    i = lt;
    const c1 = xml.charCodeAt(i + 1);
    if (c1 === 47) {
      // </name>
      const gt = xml.indexOf('>', i + 2);
      const raw = xml.slice(i + 2, gt < 0 ? n : gt).trim();
      i = gt < 0 ? n : gt + 1;
      if (names.length && names[names.length - 1] === raw) close();
      else {
        // Mismatched end tag in a broken file: close back to the match if it is open nearby.
        let k = names.length - 1;
        while (k >= 0 && names.length - k <= 8 && names[k] !== raw) k--;
        if (k >= 0 && names[k] === raw) while (names.length > k) close();
      }
      continue;
    }
    if (c1 === 33) {
      if (xml.startsWith('<!--', i)) {
        const e = xml.indexOf('-->', i + 4);
        i = e < 0 ? n : e + 3;
      } else if (xml.startsWith('<![CDATA[', i)) {
        const e = xml.indexOf(']]>', i + 9);
        if (cur && skipAt < 0) cur.children.push(xml.slice(i + 9, e < 0 ? n : e));
        i = e < 0 ? n : e + 3;
      } else {
        // <!DOCTYPE ...> with an optional [internal subset]
        let j = i + 2;
        let depth = 0;
        for (; j < n; j++) {
          const ch = xml.charCodeAt(j);
          if (ch === 91) depth++;
          else if (ch === 93) depth--;
          else if (ch === 62 && depth <= 0) break;
        }
        i = j + 1;
      }
      continue;
    }
    if (c1 === 63) {
      const e = xml.indexOf('?>', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // Start tag: name, then attributes (values may contain '>', so parse them properly).
    let j = i + 1;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (isSpace(ch) || ch === 47 || ch === 62) break;
      j++;
    }
    const raw = xml.slice(i + 1, j);
    let attrs = null;
    let selfClose = false;
    for (;;) {
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (j >= n) break;
      const ch = xml.charCodeAt(j);
      if (ch === 62) {
        j++;
        break;
      }
      if (ch === 47) {
        selfClose = xml.charCodeAt(j + 1) === 62;
        j += selfClose ? 2 : 1;
        if (selfClose) break;
        continue;
      }
      const a0 = j;
      while (j < n) {
        const c = xml.charCodeAt(j);
        if (c === 61 || isSpace(c) || c === 62 || c === 47) break;
        j++;
      }
      const an = xml.slice(a0, j);
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      let val = '';
      if (xml.charCodeAt(j) === 61) {
        j++;
        while (j < n && isSpace(xml.charCodeAt(j))) j++;
        const q = xml.charCodeAt(j);
        if (q === 34 || q === 39) {
          const e = xml.indexOf(q === 34 ? '"' : "'", j + 1);
          val = xml.slice(j + 1, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
        } else {
          const v0 = j;
          while (j < n && !isSpace(xml.charCodeAt(j)) && xml.charCodeAt(j) !== 62) j++;
          val = xml.slice(v0, j);
        }
      }
      if (!an) {
        j++;
        continue;
      }
      (attrs || (attrs = [])).push(an, val);
    }
    i = j;
    if (!raw) continue;

    if (skipAt >= 0) {
      // Inside a skipped element: only nesting matters.
      if (!selfClose) {
        names.push(raw);
        path.push('');
        scopes.push(scope);
        nodes.push(null);
      }
      continue;
    }
    // Namespace declarations open a new scope for this element and its children.
    let sc = scope;
    if (attrs) {
      for (let k = 0; k < attrs.length; k += 2) {
        const an = attrs[k];
        if (an === 'xmlns' || an.startsWith('xmlns:')) {
          if (sc === scope) sc = { map: new Map(scope.map), el: new Map(), at: new Map() };
          sc.map.set(an === 'xmlns' ? '' : an.slice(6), decodeEntities(attrs[k + 1]));
        }
      }
    }
    const name = canon(sc, raw, false);
    let at = null;
    const getAttrs = () => {
      if (at) return at;
      at = {};
      if (attrs) {
        for (let k = 0; k < attrs.length; k += 2) {
          const an = attrs[k];
          if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
          at[canon(sc, an, true)] = decodeEntities(attrs[k + 1]);
        }
      }
      return at;
    };
    if (skipFn && skipFn(name, getAttrs, path[path.length - 1])) {
      if (!selfClose) {
        names.push(raw);
        path.push(name);
        scopes.push(scope);
        nodes.push(null);
        skipAt = names.length - 1;
        scope = sc;
      }
      continue;
    }
    let node = null;
    if (cur) {
      node = { name, attrs: getAttrs(), children: [] };
      cur.children.push(node);
    } else if (collect ? collect.has(name) : !root && !names.length) {
      node = { name, attrs: getAttrs(), children: [] };
      if (selfClose) {
        if (collect) onElement(node, path.slice());
        else root = node;
        continue;
      }
      collectAt = names.length;
    }
    if (selfClose) continue;
    names.push(raw);
    path.push(name);
    scopes.push(scope);
    nodes.push(node);
    scope = sc;
    if (node) cur = node;
  }
  // A truncated file: deliver what was being built.
  while (names.length) close();
  return root;
}

// Whole-document parse for small parts (relationships, styles, the OPF).
export async function parseXml(xml, opts) {
  return (await walkXml(xml, Object.assign({}, opts, { collect: null }))) || { name: '', attrs: {}, children: [] };
}

/* ---------- tree helpers ---------- */

export function kid(node, name) {
  if (!node) return null;
  for (const c of node.children) if (typeof c !== 'string' && c.name === name) return c;
  return null;
}

export function kids(node, name) {
  const out = [];
  if (node) for (const c of node.children) if (typeof c !== 'string' && (!name || c.name === name)) out.push(c);
  return out;
}

// All descendants named `name` (or for which name(node) is true), in document order.
export function findAll(node, name, out) {
  const res = out || [];
  if (!node) return res;
  const test = typeof name === 'function' ? name : (n) => n.name === name;
  const stack = [node];
  const order = [];
  while (stack.length) {
    const n = stack.pop();
    if (n !== node && test(n)) order.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) if (typeof n.children[i] !== 'string') stack.push(n.children[i]);
  }
  for (const n of order) res.push(n);
  return res;
}

export function find(node, name) {
  if (!node) return null;
  const test = typeof name === 'function' ? name : (n) => n.name === name;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n !== node && test(n)) return n;
    for (let i = n.children.length - 1; i >= 0; i--) if (typeof n.children[i] !== 'string') stack.push(n.children[i]);
  }
  return null;
}

export function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let s = '';
  for (const c of node.children) s += typeof c === 'string' ? c : textOf(c);
  return s;
}

export function attr(node, name) {
  return node && node.attrs[name] !== undefined ? node.attrs[name] : null;
}
