// schema.org events in a web page: JSON-LD (<script type="application/ld+json">) and microdata
// (itemscope itemtype=".../Event" with itemprop values). Pure: no DOM, so it runs in Node, in a
// worker and in an extension's service worker.
//   readSchema(html) -> [item]      the page's Event items, as JSON-LD-shaped plain objects
//   schemaEvent(item) -> { name, start, end, location, url, description, status, schedule } | null
// findEvents() turns them into Events (events.js); extract(..., { layout: true }) keeps them on
// the layout of an HTML page as layout.schema.

const MAX_HTML = 5e6;
const MAX_NODES = 4000;
const EVENT_TYPE = /(?:^|[/#:])(?:[A-Za-z]*Event|Festival|Hackathon|CourseInstance|EventSeries)$/;
const NOT_EVENT = /(?:^|[/#:])(?:OnDemandEvent|DeliveryEvent)$/; // a video to watch any time, a parcel
const SKIP_KEYS = new Set(['@context', 'potentialAction', 'review', 'aggregateRating', 'offers', 'image', 'breadcrumb', 'author', 'publisher', 'sponsor', 'funder']);

const typesOf = (o) => (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).filter((t) => typeof t === 'string');
export const isEventItem = (o) => !!o && typeof o === 'object' && typesOf(o).some((t) => EVENT_TYPE.test(t) && !NOT_EVENT.test(t));

/* ---------- JSON-LD ---------- */

function jsonBlocks(html) {
  const out = [];
  const low = html.toLowerCase();
  let i = 0;
  while (out.length < 50) {
    const s = low.indexOf('<script', i);
    if (s < 0) break;
    const gt = low.indexOf('>', s);
    if (gt < 0) break;
    const end = low.indexOf('</script', gt);
    if (end < 0) break;
    if (/type\s*=\s*["']?application\/ld\+json/.test(low.slice(s, gt))) out.push(html.slice(gt + 1, end));
    i = end + 8;
  }
  return out;
}

function parseJson(s) {
  let t = String(s).trim().replace(/^<!--|-->$/g, '').replace(/^\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>$/g, '').trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    // hand-written blocks: trailing commas, raw line breaks inside strings
    t = t.replace(/,(\s*[}\]])/g, '$1').replace(/[\r\n\t]+/g, ' ');
    try {
      return JSON.parse(t);
    } catch (e2) {
      return null;
    }
  }
}

// Every Event item in a parsed JSON-LD value: in arrays, @graph, item lists, a reservation's
// reservationFor, an organisation's events, a festival's subEvent.
function collect(v, out, depth = 0, seen = new Set()) {
  if (!v || typeof v !== 'object' || depth > 10 || seen.has(v) || seen.size > MAX_NODES) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out, depth + 1, seen);
    return;
  }
  if (isEventItem(v)) out.push(v);
  for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k) && x && typeof x === 'object') collect(x, out, depth + 1, seen);
}

/* ---------- microdata, through a small tag reader ---------- */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'svg']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', eacute: 'é', copy: '©' };
export const decodeEntities = (s) =>
  String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

function attrsOf(s) {
  const a = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) a[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return a;
}

// Start tags that end an open element as the HTML parser does ('<p>one<p>two', '<li>a<li>b',
// '<td>x<td>y'): each rule names the open elements it closes and the ones that stop the search.
const P_STOP = ['table', 'td', 'th', 'caption', 'button', 'object', 'template', 'html', 'marquee', 'applet'];
const P_CLOSERS = 'address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section summary table ul'.split(' ');
const P_RULE = { close: ['p'], stop: P_STOP };
const CLOSES = new Map([
  ...P_CLOSERS.map((t) => [t, [P_RULE]]),
  ['li', [{ close: ['li'], stop: ['ul', 'ol', 'menu', ...P_STOP] }, P_RULE]],
  ['dt', [{ close: ['dt', 'dd'], stop: ['dl', ...P_STOP] }, P_RULE]],
  ['dd', [{ close: ['dt', 'dd'], stop: ['dl', ...P_STOP] }, P_RULE]],
  ['option', [{ close: ['option'], stop: ['select', 'datalist', 'optgroup'] }]],
  ['tr', [{ close: ['tr'], stop: ['table', 'thead', 'tbody', 'tfoot'] }]],
  ['td', [{ close: ['td', 'th'], stop: ['tr', 'table'] }]],
  ['th', [{ close: ['td', 'th'], stop: ['tr', 'table'] }]],
]);
// deeper than this, elements are read as siblings (the readers below recurse once per level)
const MAX_DEPTH = 256;

// html -> a tree of { tag, attrs, kids } (text kids are strings). Forgiving: an end tag closes
// the nearest open element of its name; a <p>, <li>, <dt>/<dd>, <option>, <tr> or <td>/<th>
// left open ends where the next one (for <p>, a block) starts, as in the HTML parser; other
// unclosed elements end with their parent.
export function parseTags(html) {
  const root = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const low = html.toLowerCase();
  let i = 0;
  let nodes = 0;
  while (i < html.length && nodes < 50 * MAX_NODES) {
    const lt = html.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.kids.push(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) top.kids.push(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const body = html.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '!' || body[0] === '?') continue;
    if (body[0] === '/') {
      const name = body.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const nm = /^([a-zA-Z][\w:-]*)/.exec(body);
    if (!nm) {
      top.kids.push('<');
      i = lt + 1;
      continue;
    }
    const tag = nm[1].toLowerCase();
    for (const rule of CLOSES.get(tag) || []) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (rule.close.includes(stack[k].tag)) {
          stack.length = k;
          break;
        }
        if (rule.stop.includes(stack[k].tag)) break;
      }
    }
    const el = { tag, attrs: attrsOf(body.slice(nm[0].length)), kids: [] };
    nodes++;
    stack[stack.length - 1].kids.push(el);
    if (RAW.has(tag)) {
      const e = low.indexOf('</' + tag, i);
      if (tag !== 'svg') el.kids.push(html.slice(i, e < 0 ? html.length : e));
      const close = e < 0 ? -1 : low.indexOf('>', e);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(body) && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

const textOf = (n) => (typeof n === 'string' ? n : RAW.has(n.tag) && n.tag !== 'title' ? '' : n.kids.map(textOf).join(n.tag === 'br' ? '\n' : ''));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function propValue(n) {
  const a = n.attrs;
  if (n.tag === 'meta') return a.content || '';
  if (/^(?:audio|embed|iframe|img|source|track|video)$/.test(n.tag)) return a.src || '';
  if (/^(?:a|area|link)$/.test(n.tag)) return a.href || clean(textOf(n));
  if (n.tag === 'object') return a.data || '';
  if (n.tag === 'data' || n.tag === 'meter') return a.value || clean(textOf(n));
  if (n.tag === 'time') return a.datetime || clean(textOf(n));
  if (a.content) return a.content;
  return clean(textOf(n));
}

function typeName(t) {
  const first = String(t || '').trim().split(/\s+/)[0];
  return first ? first.replace(/^https?:\/\/(?:www\.)?schema\.org\//i, '') : undefined;
}

function itemOf(n, depth = 0) {
  const o = {};
  const t = typeName(n.attrs.itemtype);
  if (t) o['@type'] = t;
  if (depth < 8) props(n, o, depth);
  return o;
}

function props(n, o, depth) {
  for (const k of n.kids) {
    if (typeof k === 'string') continue;
    const names = k.attrs.itemprop ? k.attrs.itemprop.split(/\s+/).filter(Boolean) : [];
    const scope = 'itemscope' in k.attrs;
    if (names.length) {
      const v = scope ? itemOf(k, depth + 1) : propValue(k);
      for (const name of names) {
        if (o[name] === undefined) o[name] = v;
        else o[name] = [].concat(o[name], v);
      }
    }
    if (!scope) props(k, o, depth);
  }
}

function microdata(root) {
  const out = [];
  const walk = (n) => {
    for (const k of n.kids) {
      if (typeof k === 'string') continue;
      if ('itemscope' in k.attrs && !k.attrs.itemprop) out.push(itemOf(k));
      walk(k);
    }
  };
  walk(root);
  return out;
}

/* ---------- the page's events ---------- */

export function readSchema(html) {
  const s = String(html || '').slice(0, MAX_HTML);
  const items = [];
  if (/application\/ld\+json/i.test(s)) for (const b of jsonBlocks(s)) collect(parseJson(b), items);
  if (/\bitemscope\b/i.test(s) && /itemtype/i.test(s)) collect(microdata(parseTags(s)), items);
  // the same event in JSON-LD and microdata, or listed twice: once
  const seen = new Set();
  return items.filter((o) => {
    const k = `${clean(o.name)}|${o.startDate || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const one = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => {
  v = one(v);
  if (v == null) return '';
  if (typeof v === 'object') return clean(v.name || v['@value'] || v.text || '');
  return clean(decodeEntities(String(v)).replace(/<[^>]{0,200}>/g, ' '));
};

function addressText(a) {
  a = one(a);
  if (!a) return '';
  if (typeof a === 'string') return clean(a);
  const street = str(a.streetAddress);
  const city = str(a.addressLocality);
  const region = str(a.addressRegion);
  const post = str(a.postalCode);
  const parts = [street, city, [region, post].filter(Boolean).join(' ')].filter(Boolean);
  return parts.join(', ');
}

// 'Lincoln Hall, 2424 N Lincoln Ave, Chicago, IL 60614'; 'Online' for a virtual place.
function placeText(loc) {
  const list = Array.isArray(loc) ? loc : [loc];
  const parts = [];
  for (const l of list) {
    if (!l) continue;
    if (typeof l === 'string') {
      parts.push(clean(l));
      continue;
    }
    if (typesOf(l).some((t) => /VirtualLocation$/.test(t))) {
      if (!parts.length) parts.push(str(l.name) || 'Online');
      continue;
    }
    const name = str(l.name);
    const addr = addressText(l.address);
    const t = name && addr && !addr.toLowerCase().startsWith(name.toLowerCase()) ? `${name}, ${addr}` : name || addr;
    if (t) parts.push(t);
  }
  return parts[0] || '';
}

// 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM[:SS][.sss][Z|+HH:MM]' -> { date, time, offset (minutes) }
export function schemaTime(v) {
  const s = str(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(s);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  const out = { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : null, offset: null };
  if (m[4] && +m[4] > 23) return null;
  if (m[6]) out.offset = m[6] === 'Z' ? 0 : (m[6][0] === '-' ? -1 : 1) * (+m[6].slice(1, 3) * 60 + +m[6].slice(-2));
  return out;
}

const STATUS = /(?:^|[/#])(EventCancelled|EventPostponed|EventRescheduled|EventMovedOnline|EventScheduled)$/;

// One Event item -> what an Event needs, still in schema terms (times with their offsets).
export function schemaEvent(o) {
  const start = schemaTime(o.startDate);
  const schedule = one(o.eventSchedule);
  if (!start && !(schedule && typeof schedule === 'object' && schemaTime(schedule.startDate))) return null;
  const st = STATUS.exec(str(o.eventStatus));
  const virtual = /OnlineEventAttendanceMode$/.test(str(o.eventAttendanceMode));
  let location = placeText(o.location);
  if (!location && virtual) location = 'Online';
  return {
    name: str(o.name) || str(o.headline) || str(o.alternateName),
    start,
    end: schemaTime(o.endDate),
    duration: str(o.duration) || null,
    location: location || null,
    url: str(o.url) || null,
    description: str(o.description).slice(0, 500),
    status: st ? st[1] : null,
    schedule: schedule && typeof schedule === 'object' ? schedule : null,
  };
}
