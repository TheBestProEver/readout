// Copied from readkit (tests/fixtures/e2e/book.mjs, MIT, same author) for Readout's v2 test.
// A synthetic scanned book chapter for the end-to-end test (browser only: pages are drawn on
// a canvas and embedded as 300 dpi JPEGs). Like a real scan of an old book it has:
//   - the scanner's own OCR as an invisible text layer (render mode 3), with OCR-like slips;
//   - margin notes in a small italic face beside indented ("notched") body lines;
//   - running heads with the page number on pages 2 and 3, a centred page number on page 1;
//   - footnotes in a smaller face, with raised markers in the body;
//   - a sentence that runs on from one page to the next.
// The text is written for this test. Returns { bytes, truth }.
import { makePdf, esc, textWidth, rng } from './mkpdf.mjs';

export const TITLE = ['CHAPTER I', 'OF THE RIVER AND ITS MILLS'];
export const HEAD = 'THE MILLS OF EASTFORD';

// Body paragraphs; {n} marks a footnote reference after the word before it.
export const PARAS = [
  'The river that runs through Eastford was for many years the only road the town possessed. Grain came down it from the farms of the upper valley, timber came down it from the hills, and the mills that stood along its banks turned the one into flour and the other into boards. A traveller who stood on the old bridge in the year 1820 could count eleven wheels between the church and the weir, and every one of them was busy from the first thaw of spring until the river froze again in the winter.',
  'The mills were of two kinds. The larger stood on the main stream and ground corn for the whole district; the smaller stood on the cuts and channels that the millers had dug beside it, and sawed timber or fulled cloth.{1} A miller on the main stream could grind as much in a week as a small mill could grind in a month, but he paid a higher rent to the owner of the bank, and his wheel stood idle whenever the water ran low in the summer.',
  'Each mill had its keeper, and each keeper had his own way of reading the water. Some trusted the marks cut into the stones of the weir; others watched the colour of the stream, or the reeds along its edge, or the flight of the herons in the evening. The best of them could tell a day in advance when the river would rise, and they opened their sluices before the flood reached the town, so that the water passed under the wheels instead of over them.',
  'The trade in flour grew so quickly that by the middle of the century the millers had formed a company of their own. They met on the first Monday of every month in the long room of the Swan, settled their accounts, and fixed the price of a sack for the weeks to come. Mr. Hale, who kept the largest mill, wrote the minutes of these meetings for thirty years, and his books are still the best account we have of the river and the people who worked on it.{2}',
  'It was the railway, and not the river, that brought the mills to an end. When the line was opened in 1862, flour from the great steam mills of the cities could be sold in Eastford more cheaply than the local millers could grind it, and one by one the wheels were stopped. The last of them, the small mill below the church, ground its final sack in the spring of 1891, and the keeper locked the door and gave the key to the parish.',
  "The keepers themselves are remembered in the names of the fields along the river. Hale's Meadow lies below the weir, and the long field beside the lower cut is still called the Fuller's Ground, although no cloth has been fulled there for more than a century. The old people of the town could name every keeper who had worked on the river since their grandparents' time, and they told stories of the floods and frosts that each of them had seen.",
  'The weir itself has been mended many times. In 1947 the county replaced its wooden gates with steel ones, and in 1983 a new fish pass was cut through the eastern end, so that the salmon could climb past it in the autumn. On a quiet evening the sound of the water is the same as it ever was, and it is easy to imagine the wheels turning again in the dark.',
  'Today only the weir remains, and the stones of two of the old mill houses, which have been turned into cottages. Visitors who walk along the river in the evening can still see the cuts that the millers dug, now quiet and full of reeds, and on a still day they can hear the water falling over the weir, as the people of the town heard it for five hundred years.',
];
export const FOOTNOTES = {
  1: 'The fulling mill at the end of the lower cut was the last of its kind in the county.',
  2: 'The minute books are kept in the county archive, in twelve volumes.',
};
// Margin notes: [paragraph index, lines]
export const NOTES = [
  [0, ['The river', 'as a road.']],
  [1, ['Mills of two', 'kinds.']],
  [3, ['The millers', 'form a', 'company.']],
  [6, ['The weir', 'mended.']],
  [7, ['What is', 'left today.']],
];

const W = 612;
const H = 792;
const FONT = 'Georgia, "Times New Roman", serif';
const BODY = { fs: 13, lead: 18, x: 72, width: 440, notchX: 160, indent: 18 };
const NOTE = { fs: 8.5, lead: 10.5, x: 72 };
const FOOT = { fs: 9, lead: 11.5 };

export async function scannedBook({ seed = 5 } = {}) {
  const ctx = new OffscreenCanvas(10, 10).getContext('2d');
  const measure = (s, fs, italic = false) => {
    ctx.font = `${italic ? 'italic ' : ''}${fs}px ${FONT}`;
    return ctx.measureText(s).width;
  };
  // The whole layout for one body bottom margin; the bottom is then chosen so that every
  // paragraph a page break splits is split in the middle of a sentence.
  const layoutBook = (bottom) => {
  const r = rng(seed);
  const breaks = []; // the word before each page break inside a paragraph
  // the scanner's OCR misreads about one long word in twelve
  const garble = (w) => (w.length < 5 || r() > 0.08 ? w : w.replace(/m/, 'rn').replace(/e/, 'c').replace(/l/, '1'));

  const pages = [];
  const newPage = (n) => {
    const p = { n, draw: [], layer: [], footnotes: [] };
    pages.push(p);
    return p;
  };
  // draw: { text, x, y, fs, italic, bold, w }; layer: same, the scanner's reading
  const put = (p, text, x, y, fs, { italic = false, layer = text } = {}) => {
    const w = measure(text, fs, italic);
    p.draw.push({ text, x, y, fs, italic, w });
    if (layer) p.layer.push({ text: layer, x, y, fs, w });
    return w;
  };

  // words of every paragraph, with footnote marks split off
  const paras = PARAS.map((t) => t.split(' ').map((w) => {
    const m = /^(.*?)\{(\d)\}$/.exec(w);
    return m ? { w: m[1], mark: m[2] } : { w };
  }));

  let page = newPage(1);
  const runOn = []; // pages each paragraph is printed on
  // page 1: chapter heading and title
  put(page, TITLE[0], (W - measure(TITLE[0], 14)) / 2, 712, 14);
  put(page, TITLE[1], (W - measure(TITLE[1], 12)) / 2, 684, 12);
  let y = 650;
  const bottomFor = () => bottom; // room for footnotes at the foot of every page
  const notchFor = new Map(NOTES.map(([i, lines]) => [i, lines]));
  let notchUntil = Infinity; // body lines at or above this y (going down the page) are notched

  const drawNote = (p, lines, top) => {
    lines.forEach((l, k) => put(p, l, NOTE.x, top - k * NOTE.lead, NOTE.fs, { italic: true, layer: l.split(' ').map(garble).join(' ') }));
    // every body line the note reaches down to is indented
    return top - (lines.length - 1) * NOTE.lead - 0.6 * BODY.lead;
  };

  for (let pi = 0; pi < paras.length; pi++) {
    const words = paras[pi];
    let k = 0;
    let first = true;
    if (notchFor.has(pi)) {
      if (y - 3 * BODY.lead < bottomFor(page)) {
        page = newPage(page.n + 1);
        y = 720;
      }
      notchUntil = drawNote(page, notchFor.get(pi), y);
    }
    while (k < words.length) {
      if (y < bottomFor(page)) {
        if (k > 0) breaks.push(words[k - 1].w);
        page = newPage(page.n + 1);
        y = 720;
        notchUntil = Infinity;
      }
      const notched = y >= notchUntil;
      const x0 = (notched ? BODY.notchX : BODY.x) + (first ? BODY.indent : 0);
      const maxW = BODY.x + BODY.width - x0;
      // fill the line
      let line = [];
      while (k < words.length) {
        const cand = [...line, words[k]].map((t) => t.w).join(' ');
        if (line.length && measure(cand, BODY.fs) > maxW) break;
        line.push(words[k++]);
      }
      // draw the words, justified as books are (every line but a paragraph's last fills
      // the measure), with a raised small number after a marked word
      const markW = (t) => (t.mark ? measure(t.mark, 7) + 0.5 : 0);
      const inked = line.reduce((n, t) => n + measure(t.w, BODY.fs) + markW(t), 0);
      const space = k < words.length && line.length > 1 ? (maxW - inked) / (line.length - 1) : measure(' ', BODY.fs);
      let x = x0;
      const layerWords = [];
      for (const t of line) {
        const w = measure(t.w, BODY.fs);
        page.draw.push({ text: t.w, x, y, fs: BODY.fs, w });
        x += w;
        let lw = garble(t.w);
        if (t.mark) {
          page.draw.push({ text: t.mark, x: x + 0.5, y: y + 4.5, fs: 7, w: measure(t.mark, 7) });
          x += measure(t.mark, 7) + 0.5;
          page.footnotes.push(+t.mark);
          lw += t.mark; // the scanner glues the marker to its word
        }
        x += space;
        layerWords.push(lw);
      }
      page.layer.push({ text: layerWords.join(' '), x: x0, y, fs: BODY.fs, w: x - space - x0 });
      (runOn[pi] = runOn[pi] || new Set()).add(page.n);
      y -= BODY.lead;
      first = false;
    }
  }

  // running heads, page numbers, footnotes
  for (const p of pages) {
    if (p.n === 1) put(p, '1', (W - measure('1', 10)) / 2, 44, 10);
    else {
      put(p, HEAD, (W - measure(HEAD, 10)) / 2, 752, 10);
      put(p, String(p.n), p.n % 2 ? 512 - measure(String(p.n), 10) : 72, 752, 10);
    }
    let fy = 128;
    for (const n of p.footnotes) {
      const text = `${n} ${FOOTNOTES[n]}`;
      // wrap to the text block
      const words = text.split(' ');
      let line = '';
      const lines = [];
      for (const w of words) {
        const cand = line ? line + ' ' + w : w;
        if (line && measure(cand, FOOT.fs) > BODY.width) {
          lines.push(line);
          line = w;
        } else line = cand;
      }
      if (line) lines.push(line);
      lines.forEach((l, i) => put(p, l, BODY.x + (i ? 0 : 10), fy - i * FOOT.lead, FOOT.fs, { layer: l.split(' ').map(garble).join(' ') }));
      fy -= lines.length * FOOT.lead + 4;
    }
  }

  return { pages, runOn, breaks };
  };
  let L = null;
  for (const b of [150, 159, 168, 177, 186, 195, 204, 213]) {
    const t = layoutBook(b);
    if (!L) L = t;
    if (t.breaks.length && t.breaks.every((w) => !/[.!?:;]["'”’)\]]*$/.test(w))) {
      L = t;
      break;
    }
  }
  const { pages, runOn } = L;

  // render each page as a scan, and add the invisible layer fitted to each line's width
  const k = 300 / 72;
  const out = [];
  for (const p of pages) {
    const c = new OffscreenCanvas(Math.round(W * k), Math.round(H * k));
    const g = c.getContext('2d');
    g.fillStyle = '#f6f2e8'; // old paper
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#1a1a1a';
    for (const d of p.draw) {
      g.font = `${d.italic ? 'italic ' : ''}${d.fs * k}px ${FONT}`;
      g.fillText(d.text, d.x * k, (H - d.y) * k);
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const im = { jpeg: new Uint8Array(await blob.arrayBuffer()), w: c.width, h: c.height };
    let ops = `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q\n`;
    for (const l of p.layer) {
      const tz = (100 * l.w) / Math.max(1, textWidth(l.text, l.fs));
      ops += `BT 3 Tr /F1 ${l.fs} Tf ${tz.toFixed(2)} Tz ${l.x.toFixed(2)} ${l.y.toFixed(2)} Td (${esc(l.text)}) Tj 100 Tz 0 Tr ET\n`;
    }
    out.push({ w: W, h: H, content: ops, images: { Im1: im } });
  }
  const bytes = makePdf({ pages: out, fonts: { F1: 'Helvetica' }, info: { Producer: 'Synthetic Scanner 1.0', Title: 'scan0001' } });
  const plain = (t) => t.replace(/\{\d\}/g, '');
  return {
    bytes,
    truth: {
      pages: pages.length,
      title: TITLE,
      paras: PARAS.map(plain),
      notes: NOTES.map(([, lines]) => lines.join(' ')),
      footnotes: Object.values(FOOTNOTES),
      heads: [HEAD],
      // paragraphs printed across a page break (they must come out whole)
      runOn: runOn.map((ps, i) => (ps && ps.size > 1 ? i : -1)).filter((i) => i >= 0),
      // where every line of the scanner's layer sits (for debugging layout failures)
      layout: pages.map((p) => p.layer.map((l) => [Math.round(l.x), Math.round(l.y), l.fs, l.text.slice(0, 24) + ' ... ' + l.text.slice(-12)])),
    },
  };
}
