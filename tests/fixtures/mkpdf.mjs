// Copied from readkit (tests/fixtures/pdf/mkpdf.mjs, MIT, same author).
// A tiny PDF writer for tests. Pure ES module (no Node APIs), so it runs in Node and in
// the browser, where scanned pages can be drawn on a canvas and embedded as JPEG.
//
// makePdf({ pages: [{ w, h, content, images: { Im1: { jpeg, w, h, gray } }, rotate }], fonts, info })
// fonts: { F1: 'Helvetica' | { base, bold, toUnicode: (code) => string | null } }

// Helvetica and Helvetica-Bold AFM widths (/1000 em) for codes 32..126. The font dicts
// carry these as /Widths, so pdf.js positions glyphs exactly as our line wrapper expects.
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

export function charWidth(code, bold) {
  const t = bold ? HBW : HW;
  return code >= 32 && code <= 126 ? t[code - 32] : 556;
}

export function textWidth(s, size, bold) {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i), bold);
  return (w * size) / 1000;
}

// Our generator only writes WinAnsi text; fold typographic characters to ASCII.
export function ascii(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/£/g, 'L')
    .replace(/[^\x20-\x7e\n]/g, '');
}

// WinAnsi codes for the few non-Latin-1 characters tests use.
const WIN = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
export const esc = (s) =>
  s
    .replace(/[€…‘’“”•–—]/g, (c) => String.fromCharCode(WIN[c]))
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

// Greedy line wrap; returns lines for one paragraph.
export function wrap(text, size, maxW, bold) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const t = line ? line + ' ' + w : w;
    if (line && textWidth(t, size, bold) > maxW) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

// Wrap with hyphenation: when the next word doesn't fit, split it at a chosen point if
// both halves are at least 3 letters (deterministic: the split nearest the middle).
export function wrapHyphen(text, size, maxW, bold, canSplit = () => true) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const t = line ? line + ' ' + w : w;
    if (!line || textWidth(t, size, bold) <= maxW) {
      line = t;
      continue;
    }
    let done = false;
    const m = /^([A-Za-z]{6,})([^A-Za-z]*)$/.exec(w);
    if (m && canSplit(m[1])) {
      for (let k = m[1].length - 3; k >= 3; k--) {
        const head = m[1].slice(0, k) + '-';
        if (textWidth(line + ' ' + head, size, bold) <= maxW) {
          lines.push(line + ' ' + head);
          line = m[1].slice(k) + m[2];
          done = true;
          break;
        }
      }
    }
    if (!done) {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function textOp(font, size, x, y, str, extra = '') {
  return `BT /${font} ${size} Tf ${extra}${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(str)}) Tj ET\n`;
}

function bytesOf(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

function cmapStream(map) {
  const lines = [];
  for (let c = 0; c < 256; c++) {
    const u = map(c);
    if (u == null) continue;
    const hex = [...u].map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0')).join('');
    lines.push(`<${c.toString(16).padStart(2, '0')}> <${hex}>`);
  }
  const chunks = [];
  for (let i = 0; i < lines.length; i += 90) chunks.push(`${Math.min(90, lines.length - i)} beginbfchar\n${lines.slice(i, i + 90).join('\n')}\nendbfchar`);
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Test def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

// ToUnicode maps that render correctly but extract wrongly.
export const BROKEN = {
  // Every byte maps to a scrambled printable ASCII character (the "{P23gf49y" case).
  scramble: (c) => (c >= 32 && c <= 126 ? String.fromCharCode(33 + ((c * 37 + 11) % 94)) : null),
  // Letters shift by 3 (a Caesar cipher): letter-only garbage with normal vowel counts.
  caesar: (c) => {
    const ch = String.fromCharCode(c);
    if (/[a-z]/.test(ch)) return String.fromCharCode(97 + ((c - 97 + 3) % 26));
    if (/[A-Z]/.test(ch)) return String.fromCharCode(65 + ((c - 65 + 3) % 26));
    return c >= 32 && c <= 126 ? ch : null;
  },
  // Everything maps into the private-use area (symbolic fonts without a usable map).
  pua: (c) => (c > 32 && c <= 126 ? String.fromCharCode(0xf000 + c) : c === 32 ? ' ' : null),
};

export function makePdf({ pages, fonts = { F1: 'Helvetica', F2: 'Helvetica-Bold' }, info = null }) {
  const objs = []; // each: { dict, stream? }
  const add = (dict, stream) => (objs.push({ dict, stream }), objs.length);
  const catalog = add(null);
  const pagesId = add(null);
  const fontRefs = {};
  for (const [key, spec] of Object.entries(fonts)) {
    const s = typeof spec === 'string' ? { base: spec } : spec;
    const bold = s.bold != null ? s.bold : /Bold/.test(s.base);
    const widths = [];
    for (let c = 32; c <= 255; c++) widths.push(charWidth(c, bold));
    const enc = s.differences ? `<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${s.differences}] >>` : '/WinAnsiEncoding';
    let dict = `<< /Type /Font /Subtype /Type1 /BaseFont /${s.base} /Encoding ${enc} /FirstChar 32 /LastChar 255 /Widths [${widths.join(' ')}]`;
    if (s.toUnicode) {
      const cm = cmapStream(s.toUnicode);
      const id = add(`<< /Length ${cm.length} >>`, cm);
      dict += ` /ToUnicode ${id} 0 R`;
    }
    fontRefs[key] = add(dict + ' >>');
  }
  const fontRes = Object.entries(fontRefs).map(([k, id]) => `/${k} ${id} 0 R`).join(' ');
  const pageIds = [];
  for (const p of pages) {
    const w = p.w || 612;
    const h = p.h || 792;
    const xo = [];
    for (const [name, im] of Object.entries(p.images || {})) {
      const id = add(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>`, im.jpeg);
      xo.push(`/${name} ${id} 0 R`);
    }
    const content = p.content || '';
    const co = add(`<< /Length ${content.length} >>`, content);
    const res = `<< /Font << ${fontRes} >>${xo.length ? ` /XObject << ${xo.join(' ')} >>` : ''} >>`;
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w} ${h}]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Resources ${res} /Contents ${co} 0 R >>`));
  }
  objs[catalog - 1].dict = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1].dict = `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  let infoId = 0;
  if (info) infoId = add(`<< ${Object.entries(info).map(([k, v]) => `/${k} (${esc(ascii(v))})`).join(' ')} >>`);

  const parts = [];
  let size = 0;
  const push = (x) => {
    const b = typeof x === 'string' ? bytesOf(x) : x;
    parts.push(b);
    size += b.length;
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(size);
    push(`${i + 1} 0 obj\n${o.dict}\n`);
    if (o.stream != null) {
      push('stream\n');
      push(o.stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  });
  const xref = size;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/* ---------- deterministic prose ---------- */

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJ = ['The committee', 'Our neighbour', 'A young engineer', 'The old harbour', 'Every visitor', 'The research team', 'Her brother', 'The village council', 'A quiet student', 'The morning train', 'The library', 'Most farmers', 'The new manager', 'The museum'];
const VERB = ['described', 'remembered', 'considered', 'discovered', 'repaired', 'explained', 'questioned', 'collected', 'organised', 'measured', 'welcomed', 'recorded', 'reviewed', 'followed'];
const OBJ = ['the difficult problem', 'a remarkable collection of letters', 'the broken bridge', 'several important documents', 'the annual budget', 'an unusual pattern in the results', 'the history of the region', 'a long list of complaints', 'the careful plans', 'the distant mountains', 'every detail of the journey', 'the weather report', 'a simple solution', 'the original design'];
const TAIL = ['before the winter arrived', 'with great patience', 'during the long afternoon', 'after the meeting ended', 'without any help', 'in the early morning', 'for the second time', 'while the rain continued', 'near the old station', 'because nobody else would', 'as the evening grew colder', 'despite the noise outside'];

export function sentence(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  let s = `${pick(SUBJ)} ${pick(VERB)} ${pick(OBJ)} ${pick(TAIL)}`;
  if (r() < 0.3) s += `, and ${pick(SUBJ).toLowerCase()} ${pick(VERB)} ${pick(OBJ)}`;
  return s + '.';
}

export function paragraph(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(sentence(r));
  return out.join(' ');
}
