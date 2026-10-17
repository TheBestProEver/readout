// Web pages and HTML files -> blocks. A saved article goes through Defuddle (config.defuddle)
// and, if that finds too little, Readability (config.readability); both load on demand from
// the CDN and are optional: offline, or when both fail, a block-by-block walk of the page
// (minus menus, banners and sidebars) is used. HTML that is a document rather than a web page
// (exported from Word, Google Docs, pandoc...) skips the article extractors.

import { config } from '../config.js';
import { makeBlock, textToBlocks, countWords } from '../doc.js';
import { domToBlocks } from './dom.js';
import { decodeEntities } from './xml.js';
import { readMime } from './mime.js';

const loading = new Map();

// Loads a classic script that defines a global (UMD builds, Readability.js) and returns it.
export function loadGlobal(url, name, timeout = 20000) {
  if (globalThis[name]) return Promise.resolve(globalThis[name]);
  if (!url || typeof document === 'undefined') return Promise.reject(new Error('cannot load ' + name + ' here'));
  if (!loading.has(url)) {
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const timer = setTimeout(() => {
        s.remove();
        reject(new Error('timed out loading ' + url));
      }, timeout);
      s.src = url;
      s.async = true;
      s.onload = () => {
        clearTimeout(timer);
        if (globalThis[name]) resolve(globalThis[name]);
        else reject(new Error(url + ' did not define ' + name));
      };
      s.onerror = () => {
        clearTimeout(timer);
        s.remove();
        reject(new Error('could not load ' + url));
      };
      (document.head || document.documentElement).appendChild(s);
    }).catch((e) => {
      loading.delete(url);
      throw e;
    });
    loading.set(url, p);
  }
  return loading.get(url);
}

/* ---------- page facts ---------- */

function metaContent(doc, sel) {
  const el = doc.querySelector(sel);
  return el ? (el.getAttribute('content') || '').trim() : '';
}

function pageMeta(doc) {
  return {
    title: metaContent(doc, 'meta[property="og:title"]') || metaContent(doc, 'meta[name="twitter:title"]') || (doc.title || '').trim(),
    site: metaContent(doc, 'meta[property="og:site_name"]') || metaContent(doc, 'meta[name="application-name"]'),
    generator: metaContent(doc, 'meta[name="generator"]') || metaContent(doc, 'meta[name="Generator"]'),
  };
}

// "www.bbc.co.uk" -> "bbc", "en.wikipedia.org" -> "wikipedia"
function siteLabel(url) {
  let parts;
  try {
    parts = url ? new URL(url).hostname.toLowerCase().split('.') : [];
  } catch (e) {
    return '';
  }
  if (parts.length < 2) return parts[0] || '';
  const n = parts.length;
  // two-part public suffixes such as co.uk, com.au, org.nz
  const cut = parts[n - 1].length === 2 && parts[n - 2].length <= 3 && n >= 3 ? 2 : 1;
  return parts[n - 1 - cut] || '';
}

// " - Wikipedia", " | BBC News": the site's name after the article's.
export function cleanTitle(title, site, url) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  const seps = [' | ', ' - ', ' – ', ' — ', ' :: ', ' · ', ' « ', ' » '];
  const host = siteLabel(url);
  for (const sep of seps) {
    const k = t.lastIndexOf(sep);
    if (k <= 0) continue;
    const tail = t.slice(k + sep.length).trim().toLowerCase();
    const squashed = tail.replace(/[^\p{L}\p{N}]+/gu, '');
    const known = (site && tail === site.toLowerCase()) || (host && squashed.length >= 2 && (squashed.startsWith(host) || host.startsWith(squashed))) || /^(?:wikipedia|the guardian|bbc news|bbc|cnn|reuters|medium|substack)$/.test(tail);
    if (known) {
      t = t.slice(0, k).trim();
      break;
    }
  }
  return t;
}

// HTML that is a document (one flow of text, no site furniture) rather than a web page.
const PAGE_FURNITURE = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|masthead|site-?header|site-?footer|footer|sidebar|breadcrumbs?|cookie|banner|share|social|newsletter|comments)(?:$|[\s_-])/i;

function documentLike(doc, meta) {
  if (/Microsoft Word|LibreOffice|OpenOffice|Google Docs|pandoc|calibre|Ebookmaker|TextEdit|Apple Pages|Writer|Typora|Obsidian|Notion|Markdown/i.test(meta.generator)) return true;
  const body = doc.body;
  if (!body) return true;
  if (/\bdoc-content\b/.test(body.getAttribute('class') || '')) return true; // Google Docs export
  if (body.querySelector('nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]')) return false;
  // Old-style sites mark their furniture only with class names.
  for (const el of body.querySelectorAll('[class], [id]')) {
    if (PAGE_FURNITURE.test((el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || ''))) return false;
  }
  const text = body.textContent.replace(/\s+/g, ' ');
  let linked = 0;
  for (const a of body.getElementsByTagName('a')) linked += a.textContent.length;
  return linked < text.length * 0.25;
}

function mainRoot(doc) {
  const mains = doc.querySelectorAll('main, [role="main"]');
  if (mains.length === 1) return mains[0];
  const articles = doc.querySelectorAll('article');
  if (articles.length === 1) return articles[0];
  return doc.body || doc.documentElement;
}

async function contentBlocks(html, ctx) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  return domToBlocks(d.body, { mode: 'content', pause: ctx.pause, source: 'markup' });
}

const wordsOf = (blocks) => blocks.reduce((n, b) => n + (b.skip ? 0 : countWords(b.text)), 0);
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/* ---------- readers ---------- */

// html (string) -> { title, blocks, warnings, how }. ctx: { url, pause, articles (default true) }
// A <br> alone in an inline wrapper (the Guardian's "question? <em>asker</em><em><br></em>answer")
// is dropped with the "empty" wrapper by Defuddle, gluing the answer to the question. Lift it out.
const INLINE_WRAP = new Set(['EM', 'I', 'STRONG', 'B', 'SPAN', 'FONT', 'U', 'SMALL', 'MARK']);
// An inline wrapper holding only whitespace and <br>s (memoized: each element is judged once).
function onlyBreaks(el, memo) {
  if (memo.has(el)) return memo.get(el);
  let ok = el.nodeType === 1 && INLINE_WRAP.has(el.tagName);
  for (let n = ok ? el.firstChild : null; ok && n; n = n.nextSibling) {
    if (n.nodeType === 3) ok = !n.data.trim();
    else if (n.nodeType === 1) ok = n.tagName === 'BR' || onlyBreaks(n, memo);
  }
  memo.set(el, ok);
  return ok;
}
function liftBreaks(doc) {
  const memo = new Map();
  for (const br of doc.querySelectorAll('br')) {
    let box = br.parentNode;
    if (!box || !onlyBreaks(box, memo)) continue;
    while (box.parentNode && onlyBreaks(box.parentNode, memo)) box = box.parentNode;
    if (!box.parentNode) continue; // inside a wrapper already lifted
    const frag = doc.createDocumentFragment();
    for (let k = box.querySelectorAll('br').length; k > 0; k--) frag.appendChild(doc.createElement('br'));
    box.parentNode.replaceChild(frag, box);
  }
}

export async function readHtml(html, ctx) {
  const c = ctx || {};
  if (typeof DOMParser === 'undefined') return stripHtml(html, c.url);
  const pause = c.pause || (async () => {});
  // Each parse and each extractor is one long, unsplittable task, so give the page back between them.
  const parse = () => {
    const d = new DOMParser().parseFromString(html, 'text/html');
    // Scripts never hold article text; JSON-LD stays for Defuddle's metadata.
    for (const s of d.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, template')) s.remove();
    liftBreaks(d);
    return d;
  };
  let doc = parse();
  const meta = pageMeta(doc);
  if (!doc.body) return { title: meta.title, blocks: [], warnings: [], how: 'none' };
  const docLike = documentLike(doc, meta);
  let blocks = null;
  let title = meta.title;
  let how = 'dom';

  if (!docLike && c.articles !== false) {
    const bodyWords = countWords(doc.body.textContent);
    const candidates = [];
    let used = false; // the extractors change the document they are given
    const fresh = () => {
      if (!used) {
        used = true;
        return doc;
      }
      return parse();
    };
    await pause();
    // Defuddle keeps whole articles where Readability sometimes stops early.
    try {
      const Defuddle = await loadGlobal(config.defuddle, 'Defuddle');
      await pause();
      const res = new Defuddle(fresh(), { url: c.url || undefined }).parse();
      await pause();
      if (res && res.content) candidates.push({ how: 'defuddle', title: res.title, blocks: await contentBlocks(res.content, c) });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      /* offline, blocked or failed: try the next one */
    }
    const enough = (b) => b && (wordsOf(b.blocks) >= 150 || wordsOf(b.blocks) >= bodyWords * 0.5);
    if (!candidates.some(enough)) {
      try {
        const Readability = await loadGlobal(config.readability, 'Readability');
        await pause();
        const res = new Readability(fresh(), { charThreshold: 300 }).parse();
        await pause();
        if (res && res.content) candidates.push({ how: 'readability', title: res.title, blocks: await contentBlocks(res.content, c) });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        /* fall through to the page walk */
      }
    }
    const best = candidates.find(enough) || candidates.sort((a, b) => wordsOf(b.blocks) - wordsOf(a.blocks))[0];
    if (best && wordsOf(best.blocks) >= 30) {
      blocks = best.blocks;
      title = best.title || title;
      how = best.how;
    }
    if (!blocks && used) doc = parse();
  }
  if (!blocks) blocks = await domToBlocks(docLike ? doc.body : mainRoot(doc), { mode: docLike ? 'content' : 'page', pause: c.pause, source: 'markup' });
  title = cleanTitle(title, meta.site, c.url);
  // An extracted article starts with its headline.
  if (title && how !== 'dom' && !(blocks[0] && /^h[1-6]$/.test(blocks[0].type) && norm(blocks[0].text) === norm(title))) {
    const at = blocks.findIndex((b) => /^h[1-6]$/.test(b.type) && norm(b.text) === norm(title));
    if (at > 0 && at < 4) blocks.splice(at, 1);
    blocks.unshift(makeBlock('h1', title));
  }
  return { title, blocks, warnings: [], how };
}

// Saved pages (.mhtml) and e-mails (.eml).
export async function readMimeDoc(bytes, ctx) {
  const m = readMime(bytes);
  if (m.html != null) {
    const r = await readHtml(m.html, Object.assign({}, ctx, { url: m.url || (ctx && ctx.url) }));
    if (m.subject && !r.title) r.title = m.subject;
    return Object.assign(r, { kind: 'html' });
  }
  return { title: m.subject, blocks: textToBlocks(m.text || ''), warnings: [], kind: 'text' };
}

/* ---------- without a DOM (workers, Node) ---------- */

const NAMED = { mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', bull: '•', middot: '·', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', pound: '£', euro: '€', deg: '°', times: '×', shy: '' };
const BLOCK_TAGS = /^\/?(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|section|article|blockquote|pre|header|footer|figure|figcaption|dd|dt|dl|hr|main|aside|nav|title|body|html)$/i;
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'math', 'nav']);

// A plain tag-stripping reader, used only where DOMParser doesn't exist.
export function stripHtml(html, url) {
  const s = String(html);
  const lower = s.toLowerCase();
  let nextGt = -2; // cached position of the next '>' (-1: there is none)
  let out = '';
  let title = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      i = e < 0 ? s.length : e + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      // <!DOCTYPE ...>, <![CDATA[...]]>, <?xml ...?>
      if (s.startsWith('<![CDATA[', lt)) {
        const e = s.indexOf(']]>', lt + 9);
        out += s.slice(lt + 9, e < 0 ? s.length : e);
        i = e < 0 ? s.length : e + 3;
      } else {
        const e = s.indexOf('>', lt + 2);
        i = e < 0 ? s.length : e + 1;
      }
      continue;
    }
    if (nextGt !== -1 && nextGt <= lt) nextGt = s.indexOf('>', lt + 1);
    const gt = nextGt;
    if (gt < 0) {
      out += s.slice(lt);
      break;
    }
    const tag = /^<(\/?[a-zA-Z][a-zA-Z0-9]*)/.exec(s.slice(lt, Math.min(gt + 1, lt + 40)));
    if (!tag) {
      // "a < b" is text, not a tag
      out += '<';
      i = lt + 1;
      continue;
    }
    i = gt + 1;
    const name = tag[1].toLowerCase();
    if (DROP_TAGS.has(name)) {
      const end = lower.indexOf('</' + name, i);
      if (name === 'head' && !title) {
        const tm = /<title[^>]{0,200}>([^<]{0,500})/i.exec(s.slice(i, end < 0 ? s.length : end));
        if (tm) title = decodeEntities(tm[1]).trim();
      } else if (name === 'title' && !title) title = decodeEntities(s.slice(i, end < 0 ? i : end).slice(0, 500)).replace(/\s+/g, ' ').trim();
      i = end < 0 ? s.length : s.indexOf('>', end) + 1 || s.length;
      continue;
    }
    if (name === 'br') out += '\n';
    else if (BLOCK_TAGS.test(name)) out += '\n\n';
  }
  const text = decodeEntities(out).replace(/&([a-z]{2,8});/g, (m, e) => (NAMED[e] !== undefined ? NAMED[e] : m));
  return { title: cleanTitle(title, '', url), blocks: textToBlocks(text, { source: 'markup' }), warnings: [], how: 'strip' };
}
