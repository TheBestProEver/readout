// HTML/XHTML DOM -> blocks, for web pages, EPUB chapters and saved pages. Walks the tree
// block by block (never .textContent, which glues paragraphs into "squad.Trump"), turns <br>
// into a line break, drops scripts, navigation, hidden text, page-number markers and
// footnote marks, keeps figure captions as skippable 'caption' blocks, numbers ordered lists,
// and treats <pre> as code only when it looks like code.

import { makeBlock, textToBlocks } from '../doc.js';
import { formatNumber, citeSigns, isCitation } from './util.js';

const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'noframes', 'object', 'embed', 'applet', 'svg', 'math', 'canvas',
  'video', 'audio', 'map', 'area', 'select', 'button', 'input', 'textarea', 'option', 'optgroup', 'datalist', 'head', 'title', 'meta',
  'link', 'base', 'img', 'picture', 'source', 'track', 'nav', 'dialog', 'param', 'rt', 'rp', 'del', 'menu',
]);
const INLINE = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'blink', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark',
  'nobr', 'q', 'ruby', 'rb', 'rtc', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'output',
  'meter', 'progress', 'slot', 'wbr', 'abbr', 'img', 'font',
]);
// Elements a screen reader or print never shows, and furniture that isn't the text.
const HIDDEN_CLASS = /\b(?:sr-only|visually-?hidden|screen-?reader-text|a11y-hidden|offscreen|mw-editsection|noprint|mw-jump-link|navbox|ambox|hatnote|mw-cite-backlink|pagenum|pageno|page-?number|footnote-?back(?:ref|link)?|backlink|reflink-back)\b/i;
const PAGE_CLUTTER = /\b(?:cookie|consent|share|sharing|social|newsletter|subscribe|advert|ad-?slot|promo|related|comments?|sidebar|breadcrumbs?|skip-?link|site-?header|site-?footer|masthead|byline-?share|paywall|signup)\b/i;
const PAGE_ROLES = /^(?:banner|navigation|contentinfo|complementary|search|dialog|alertdialog|menu|menubar|toolbar|tablist|form)$/;
const NOTE_TYPES = /(?:^|\s)(?:footnote|endnote|rearnote|note)(?:\s|$)/;
const CITATIONS = /\b(?:references|reflist|refbegin|citation-list|bibliography|works-cited)\b/i;
const BOILERPLATE = /(?:^|\s)(?:imprint|colophon|copyright-page)(?:\s|$)/;

export { isCitation };

const attr = (el, n) => (el.getAttribute && el.getAttribute(n)) || '';
const epubType = (el) => attr(el, 'epub:type');

function isHidden(el) {
  if (el.hasAttribute('hidden') || attr(el, 'aria-hidden') === 'true') return true;
  const style = attr(el, 'style');
  if (style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true;
  const cls = attr(el, 'class');
  if (cls && HIDDEN_CLASS.test(cls)) return true;
  const et = epubType(el);
  if (et && /\bpagebreak\b/.test(et)) return true;
  const role = attr(el, 'role');
  return role === 'doc-pagebreak' || role === 'doc-backlink';
}

// A footnote mark: <sup><a href="#fn1">1</a></sup>, epub:type="noteref", [12]
function isNoteRef(el, tag) {
  if (/\bnoteref\b/.test(epubType(el)) || attr(el, 'role') === 'doc-noteref') return true;
  if (tag === 'a' && /\b(?:footnote-?ref|noteref|fnref|footnote-reference)\b/i.test(attr(el, 'class'))) return true;
  // Calibre and Gutenberg books: <a href="#note12">[12]</a> (bracketed, so "see page 12" links stay)
  if (tag === 'a' && attr(el, 'href').includes('#') && isInternalLink(attr(el, 'href')) && /^\s*\[(?:\d{1,3}|[a-z]|[*†‡§¶])\]\s*$/i.test(el.textContent)) return true;
  if (tag === 'sup' || (tag === 'a' && el.parentNode && el.parentNode.localName === 'sup')) {
    const t = el.textContent.trim();
    if (t.length <= 6 && /^\[?\s*(?:\d{1,3}|[a-z]|[*†‡§¶])\s*\]?$/i.test(t) && (tag === 'a' || el.querySelector('a[href]'))) return true;
  }
  return false;
}

function isInternalLink(href) {
  return href && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

// Lists and tables made of links: a table of contents (inside a book or an article) or, on a
// whole page, a menu of other stories. Hearing them is noise.
function dropLinkLists(root, page) {
  const cands = root.querySelectorAll('ul, ol, table, dl, p, div, section');
  const gone = new Set();
  for (const el of cands) {
    let up = el.parentNode;
    let inside = false;
    while (up && up !== root) {
      if (gone.has(up)) {
        inside = true;
        break;
      }
      up = up.parentNode;
    }
    if (inside) continue;
    const links = el.getElementsByTagName('a');
    if (links.length < (page ? 3 : 4)) continue;
    const total = el.textContent.replace(/\s+/g, '').length;
    if (!total || total > 20000) continue;
    let linked = 0;
    let internal = 0;
    for (const a of links) {
      const len = a.textContent.replace(/\s+/g, '').length;
      linked += len;
      if (isInternalLink(attr(a, 'href'))) internal += len;
    }
    const share = (page ? linked : internal) / total;
    if (share >= (page ? 0.8 : 0.85)) {
      gone.add(el);
      // a "Contents" heading just before a table of contents goes with it
      let prev = el.previousElementSibling;
      if (prev && /^h[1-6]$/.test(prev.localName) && /^(?:table of )?contents$/i.test(prev.textContent.trim())) gone.add(prev);
    }
  }
  for (const el of gone) if (el.parentNode) el.parentNode.removeChild(el);
}

function looksLikeCode(el, text) {
  if (el.querySelector('code') || (el.parentNode && el.parentNode.localName === 'code')) return true;
  if (/\b(?:code|highlight|hljs|prettyprint|source|lang(?:uage)?-|brush|syntax|console|terminal)/i.test(attr(el, 'class') + ' ' + attr(el, 'data-lang'))) return true;
  const t = text.replace(/\s+/g, '');
  if (!t) return false;
  const sym = (t.match(/[{}();=<>[\]$#&|\\/*^~_]/g) || []).length;
  return sym / t.length > 0.06;
}

// Text of a <pre>, keeping its line breaks.
function preText(el) {
  let s = '';
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1) {
        const tag = c.localName.toLowerCase();
        if (tag === 'br') s += '\n';
        else if (!DROP.has(tag) && !isHidden(c)) walk(c);
      }
    }
  };
  walk(el);
  return s.replace(/\r\n?/g, '\n');
}

function olNumber(li, counters) {
  const ol = li.parentNode;
  if (!ol || ol.localName !== 'ol') return '';
  const style = attr(ol, 'style') + ';' + attr(li, 'style');
  if (/list-style(?:-type)?\s*:\s*none/i.test(style)) return '';
  let c = counters.get(ol);
  if (!c) {
    const reversed = ol.hasAttribute('reversed');
    const count = reversed ? [...ol.children].filter((k) => k.localName === 'li').length : 0;
    const start = ol.hasAttribute('start') ? parseInt(attr(ol, 'start'), 10) : reversed ? count : 1;
    c = { next: Number.isFinite(start) ? start : 1, step: reversed ? -1 : 1, type: attr(ol, 'type') || '1' };
    counters.set(ol, c);
  }
  const v = parseInt(attr(li, 'value'), 10);
  const n = Number.isFinite(v) ? v : c.next;
  c.next = n + c.step;
  return formatNumber(n, attr(li, 'type') || c.type) + '.';
}

/**
 * root: an Element (body, an article container). opts:
 *   mode: 'content' (a chapter or extracted article) | 'page' (a whole web page: drop menus,
 *         banners, sidebars, link lists)
 *   page, source ('markup'), skip (applies to every block), pause, notes (move EPUB footnotes
 *   to the end of the chapter), tocs (drop tables of contents, default true)
 */
export async function domToBlocks(root, opts) {
  const o = Object.assign({ mode: 'content', source: 'markup', notes: false, tocs: true }, opts);
  const page = o.mode === 'page';
  const blocks = [];
  const noteEls = [];
  if (!root) return blocks;
  if (o.tocs || page) dropLinkLists(root, page);
  if (o.notes) {
    for (const el of root.querySelectorAll('aside, section, div, li, p, dd')) {
      if (NOTE_TYPES.test(epubType(el)) || /^doc-(?:footnote|endnote)$/.test(attr(el, 'role'))) {
        // Only the outermost note element; notes inside notes stay with their parent.
        let up = el.parentNode;
        let nested = false;
        while (up && up !== root) {
          if (noteEls.includes(up)) {
            nested = true;
            break;
          }
          up = up.parentNode;
        }
        if (!nested) noteEls.push(el);
      }
    }
    for (const el of noteEls) if (el.parentNode) el.parentNode.removeChild(el);
  }

  const counters = new Map();
  let buf = '';
  const flush = (ctx) => {
    let t = buf;
    buf = '';
    if (!t.trim() || /^[\s↩↑^⤴\ufe0e]+$/.test(t)) return;
    if (ctx.li && ctx.li.prefix) {
      t = ctx.li.prefix + ' ' + t.trimStart();
      ctx.li.prefix = '';
    }
    blocks.push(makeBlock(ctx.type, t, { page: o.page, source: o.source, skip: ctx.skip || o.skip }));
  };
  const addText = (data) => {
    let s = data.replace(/[ \t\n\r\f]+/g, ' ');
    if (!s) return;
    // Two blocks laid out apart but written without a space: "squad.</p><p>Trump" in
    // broken markup, or <span>s styled as blocks. Never let a sentence end touch the next.
    if (/[.!?;:]["'”’)\]]?$/.test(buf.slice(-2)) && /^["'“‘(]?\p{Lu}/u.test(s)) s = ' ' + s;
    buf += s;
  };

  const childCtx = (el, tag, parent) => {
    const c = { type: parent.inherit ? parent.type : 'p', skip: parent.skip, inherit: parent.inherit, li: parent.li };
    const cls = attr(el, 'class');
    const id = attr(el, 'id');
    if (/^h[1-6]$/.test(tag)) {
      c.type = tag;
      c.inherit = false;
    } else if (attr(el, 'role') === 'heading') {
      c.type = 'h' + Math.min(6, Math.max(1, parseInt(attr(el, 'aria-level'), 10) || 2));
      c.inherit = false;
    } else if (tag === 'li') {
      c.type = 'li';
      c.inherit = true;
      c.li = { prefix: olNumber(el, counters) };
    } else if (tag === 'blockquote') {
      c.type = 'quote';
      c.inherit = true;
    } else if (tag === 'td' || tag === 'th') {
      const short = el.textContent.length < 300;
      c.type = short ? 'cell' : 'p';
      c.inherit = short;
    } else if (tag === 'figcaption' || tag === 'caption') {
      c.type = 'caption';
      c.skip = c.skip || 'caption';
      c.inherit = true;
    } else if (tag === 'dt' || tag === 'dd') {
      c.type = 'p';
      c.inherit = false;
    }
    if (cls && /\bpg-boilerplate\b/.test(cls)) c.skip = /footer/.test(id) || /\bpgfooter\b/.test(cls) ? 'footer' : 'header';
    // A book's publishing boilerplate (Standard Ebooks' imprint, colophon and "uncopyright",
    // publishers' copyright pages) is skippable like Project Gutenberg's licence.
    const et = epubType(el);
    if (et && !c.skip && BOILERPLATE.test(et)) c.skip = /\bimprint\b/.test(et) || /\bfrontmatter\b/.test(et + ' ' + epubType(root)) ? 'header' : 'footer';
    if ((cls && CITATIONS.test(cls)) || attr(el, 'role') === 'doc-bibliography' || /\bbibliography\b/.test(epubType(el)) || (tag === 'ol' && /\breferences\b/.test(cls))) c.skip = c.skip || 'citation';
    // A footnotes section (Defuddle's <div id="footnotes">, Markdown renderers' <section class="footnotes">):
    // each item is a note; the ones that are source citations are skippable.
    if (id === 'footnotes' || (cls && /\bfootnotes\b/.test(cls)) || attr(el, 'role') === 'doc-endnotes' || /\b(?:endnotes|footnotes|rearnotes)\b/.test(epubType(el))) {
      // When most notes are sources (Wikipedia's references), they all are.
      const items = el.querySelectorAll('li');
      let cites = 0;
      for (const li of items) if (li.querySelector('cite') || citeSigns(li.textContent) >= 1) cites++;
      c.footnotes = items.length && cites >= items.length * 0.6 ? 'citations' : 'notes';
    } else c.footnotes = parent.footnotes;
    if (tag === 'li' && parent.footnotes) {
      c.type = 'note';
      if (parent.footnotes === 'citations' || el.querySelector('cite') || isCitation(el.textContent)) c.skip = c.skip || 'citation';
    }
    return c;
  };

  const dropPage = (el, tag) => {
    if (tag === 'header' || tag === 'footer' || tag === 'aside' || tag === 'form') return true;
    if (PAGE_ROLES.test(attr(el, 'role'))) return true;
    const hint = attr(el, 'class') + ' ' + attr(el, 'id');
    return PAGE_CLUTTER.test(hint) && el.textContent.length < 3000;
  };

  const walk = async (start, ctx) => {
    const stack = [{ el: start, ctx, child: start.firstChild, block: false }];
    let steps = 0;
    while (stack.length) {
      if (o.pause && ++steps % 500 === 0) await o.pause();
      const top = stack[stack.length - 1];
      const node = top.child;
      if (!node) {
        stack.pop();
        if (top.block) flush(top.ctx);
        continue;
      }
      top.child = node.nextSibling;
      if (node.nodeType === 3 || node.nodeType === 4) {
        addText(node.data);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const tag = (node.localName || '').toLowerCase();
      if (DROP.has(tag) || isHidden(node)) continue;
      if (tag === 'br') {
        buf += '\n';
        continue;
      }
      if (INLINE.has(tag) || tag.includes(':')) {
        if ((tag === 'sup' || tag === 'a' || tag === 'span') && isNoteRef(node, tag)) continue;
        stack.push({ el: node, ctx: top.ctx, child: node.firstChild, block: false });
        continue;
      }
      if (page && dropPage(node, tag)) continue;
      flush(top.ctx);
      const c = childCtx(node, tag, top.ctx);
      if (tag === 'pre') {
        const text = preText(node);
        if (looksLikeCode(node, text)) blocks.push(makeBlock('code', text, { page: o.page, source: o.source, skip: c.skip || o.skip || 'code' }));
        else for (const b of textToBlocks(text, { source: o.source, page: o.page })) blocks.push(Object.assign(b, c.skip || o.skip ? { skip: c.skip || o.skip } : {}));
        continue;
      }
      stack.push({ el: node, ctx: c, child: node.firstChild, block: true });
    }
    flush(ctx);
  };

  await walk(root, { type: 'p', skip: undefined, inherit: false, li: null });
  for (const el of noteEls) {
    const before = blocks.length;
    // a note that only gives a source is skippable, like a reference list
    await walk(el, { type: 'note', skip: isCitation(el.textContent) ? 'citation' : undefined, inherit: true, li: null });
    for (let k = before; k < blocks.length; k++) if (blocks[k].type !== 'code') blocks[k].type = 'note';
  }
  return blocks.filter((b) => b.text);
}
