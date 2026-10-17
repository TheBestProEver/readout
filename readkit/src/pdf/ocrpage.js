// OCR results -> the same segments the layout uses for text-layer pages, so OCR'd
// pages get the same reading order, running-head removal, paragraphs and
// de-hyphenation. Also: post-OCR correction, and patching a broken font's runs with
// the OCR words found in the same place.

import { isJunkToken, known, core } from './quality.js';

// Boxes come as { x0, y0, x1, y1 } (Tesseract), [x0, y0, x1, y1], or { x, y, w, h }.
export function normBox(b) {
  if (!b) return null;
  if (Array.isArray(b)) return b.length >= 4 ? { x0: b[0], y0: b[1], x1: b[2], y1: b[3] } : null;
  if ('x0' in b) return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
  if ('left' in b) return { x0: b.left, y0: b.top, x1: b.left + (b.width || 0), y1: b.top + (b.height || 0) };
  if ('x' in b) return { x0: b.x, y0: b.y, x1: b.x + (b.w ?? b.width ?? 0), y1: b.y + (b.h ?? b.height ?? 0) };
  return null;
}

const normConf = (c) => (typeof c !== 'number' || !isFinite(c) ? 0.5 : c > 1 ? c / 100 : Math.max(0, c));

// Groups an OCR result into lines of words: [{ words: [{ text, conf, box }], box, conf }].
export function ocrLines(result) {
  const lines = [];
  const raw = Array.isArray(result.lines) ? result.lines : [];
  const words = Array.isArray(result.words) ? result.words : [];
  if (words.length && words.every((w) => typeof w.line === 'number')) {
    for (const w of words) {
      const text = String(w.text || '').trim();
      if (!text) continue;
      const i = w.line;
      if (!lines[i]) {
        const l = raw[i];
        lines[i] = { words: [], box: l ? normBox(l.bbox) : null, conf: l ? normConf(l.conf) : null };
      }
      lines[i].words.push({ text, conf: normConf(w.conf), box: normBox(w.bbox) });
    }
  } else {
    for (const l of raw) {
      const text = String(l.text || '').trim();
      if (!text) continue;
      const box = normBox(l.bbox);
      const conf = normConf(l.conf);
      lines.push({ box, conf, words: splitLine(text, box, conf) });
    }
  }
  const out = [];
  for (const l of lines) {
    if (!l || !l.words.length) continue;
    if (!l.box) l.box = unionBox(l.words.map((w) => w.box).filter(Boolean));
    if (!l.box) continue;
    if (l.conf == null) l.conf = l.words.reduce((s, w) => s + w.conf, 0) / l.words.length;
    out.push(l);
  }
  return out;
}

// Words without their own boxes get boxes spread across the line by character count.
function splitLine(text, box, conf) {
  const toks = text.split(/\s+/).filter(Boolean);
  if (!box) return toks.map((t) => ({ text: t, conf, box: null }));
  const total = toks.reduce((n, t) => n + t.length + 1, -1) || 1;
  const w = box.x1 - box.x0;
  let at = 0;
  return toks.map((t) => {
    const x0 = box.x0 + (w * at) / total;
    at += t.length + 1;
    return { text: t, conf, box: { x0, y0: box.y0, x1: box.x0 + (w * (at - 1)) / total, y1: box.y1 } };
  });
}

function unionBox(boxes) {
  if (!boxes.length) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

// Post-OCR correction. With the shared corrector (src/lang/correct.js) words are fixed
// in context and leftover junk dropped; without it, only clear junk is dropped.
// Returns { lines, dropped: string[] }.
export async function correctLines(lines, corrector, words) {
  const dropped = [];
  if (corrector && typeof corrector.correctWords === 'function') {
    const flat = [];
    for (const l of lines) for (const w of l.words) flat.push({ text: w.text, conf: w.conf });
    let res = null;
    try {
      res = await corrector.correctWords(flat);
    } catch (e) {
      res = null;
    }
    if (res && Array.isArray(res.words) && res.words.length === flat.length) {
      let k = 0;
      for (const l of lines) {
        for (const w of l.words) {
          const c = res.words[k++];
          if (c.dropped) w.dropped = true;
          else if (typeof c.text === 'string') w.text = c.text;
          if (typeof c.conf === 'number') w.conf = normConf(c.conf);
        }
      }
      for (const d of res.dropped || []) dropped.push(d);
      return { lines: pruneLines(lines), dropped };
    }
    // The corrector merged or split words: correct line by line instead.
    try {
      for (const l of lines) {
        const r = await corrector.correctWords(l.words.map((w) => ({ text: w.text, conf: w.conf })));
        if (r && Array.isArray(r.words) && r.words.length === l.words.length) {
          r.words.forEach((c, i) => {
            if (c.dropped) l.words[i].dropped = true;
            else if (typeof c.text === 'string') l.words[i].text = c.text;
          });
        } else if (r && Array.isArray(r.words)) {
          const box = l.box;
          const conf = l.conf;
          l.words = splitLine(r.words.filter((c) => !c.dropped).map((c) => c.text).join(' '), box, conf);
        }
        for (const d of (r && r.dropped) || []) dropped.push(d);
      }
      return { lines: pruneLines(lines), dropped };
    } catch (e) {
      /* fall back to the simple filter below */
    }
  }
  for (const l of lines) {
    for (const w of l.words) {
      if (junkOcrWord(w, words)) {
        w.dropped = true;
        dropped.push(w.text);
      }
    }
  }
  return { lines: pruneLines(lines), dropped };
}

function junkOcrWord(w, words) {
  const t = core(w.text);
  if (!t) return w.conf < 0.5 && !/^[–—&•·$£€%#*§()"“”'‘’,.;:!?-]+$/.test(w.text);
  if (isJunkToken(w.text, words)) return w.conf < 0.85;
  if (w.conf < 0.3 && !known(words, t) && !/^\d[\d.,:/-]*$/.test(t)) return true;
  return false;
}

function pruneLines(lines) {
  for (const l of lines) l.words = l.words.filter((w) => !w.dropped && w.text);
  return lines.filter((l) => l.words.length);
}

// Swaps the page OCR's words inside `regions` (page points) for a closer reading of
// those regions (`extra`: lines in page pixels). Words of `extra` outside the regions
// (the crop's padding) are dropped. Lines are as from ocrLines().
export function replaceRegions(lines, regions, extra, scale) {
  const inside = (b) => {
    const cx = (b.x0 + b.x1) / 2 / scale;
    const cy = (b.y0 + b.y1) / 2 / scale;
    return regions.some((r) => cx >= r.x0 && cx <= r.x1 && cy >= r.top && cy <= r.bot);
  };
  const out = [];
  const keep = (l, words, crop) => {
    if (!words.length) return;
    if (words.length === l.words.length && !crop) return out.push(l);
    const box = unionBox(words.map((w) => w.box).filter(Boolean)) || l.box;
    const line = { ...l, words, box };
    if (crop) line.crop = true;
    out.push(line);
  };
  for (const l of lines) keep(l, l.words.filter((w) => !(w.box && inside(w.box))), false);
  for (const l of extra) keep(l, l.words.filter((w) => w.box && inside(w.box)), true);
  return out;
}

// Moves OCR lines read from a crop at (dx, dy) (pixels) back to page pixels.
export function shiftLines(lines, dx, dy) {
  const mv = (b) => (b ? { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy } : b);
  return lines.map((l) => ({ ...l, box: mv(l.box), words: l.words.map((w) => ({ ...w, box: mv(w.box) })) }));
}

// OCR lines (image pixels) -> layout segments (page points: pixels / scale).
export function ocrSegments(lines, scale) {
  const segs = [];
  for (const l of lines) {
    const b = l.box;
    const h = (b.y1 - b.y0) / scale;
    if (!(h > 0)) continue;
    // The text size from the words' heights (median over words of three letters or
    // more, about an em tall with ascenders and descenders): a line box is stretched by
    // any one tall bracket or speck.
    const hs = l.words.filter((w) => w.box && /\p{L}{3}/u.test(w.text)).map((w) => (w.box.y1 - w.box.y0) / scale);
    hs.sort((x, y) => x - y);
    const fs = (hs.length ? hs[hs.length >> 1] : h) / 0.96;
    const top = b.y0 / scale;
    const text = l.words.map((w) => w.text).join(' ');
    const runs = l.words.map((w) => {
      const wb = w.box || b;
      return { str: w.text, x0: wb.x0 / scale, x1: wb.x1 / scale, conf: w.conf };
    });
    segs.push({
      runs,
      text,
      x0: b.x0 / scale,
      x1: b.x1 / scale,
      top,
      bot: b.y1 / scale,
      // the tops of lines (capitals, ascenders) are steadier than their bottoms
      base: top + 0.75 * fs,
      fs,
      chars: text.replace(/\s+/g, '').length,
      bold: 0,
      artifact: false,
      font: '',
      conf: l.words.reduce((s, w) => s + w.conf, 0) / l.words.length,
    });
  }
  return segs;
}

// Replaces the text of runs in a broken font with the OCR words inside each run's box.
// runs are in page points (unrotated pages only); OCR boxes in pixels at `scale`.
export function patchRuns(runs, badFonts, lines, scale) {
  const words = [];
  for (const l of lines) for (const w of l.words) if (w.box) words.push({ text: w.text, cx: (w.box.x0 + w.box.x1) / 2 / scale, cy: (w.box.y0 + w.box.y1) / 2 / scale, used: false });
  let patched = 0;
  const out = [];
  for (const r of runs) {
    if (!badFonts.has(r.font)) {
      out.push(r);
      continue;
    }
    const padX = 0.3 * r.fs;
    const padY = 0.25 * r.fs;
    const inside = words.filter((w) => !w.used && w.cx >= r.x0 - padX && w.cx <= r.x1 + padX && w.cy >= r.top - padY && w.cy <= r.bot + padY);
    inside.sort((a, b) => a.cx - b.cx);
    for (const w of inside) w.used = true;
    const str = inside.map((w) => w.text).join(' ');
    if (str) {
      out.push({ ...r, str: (/^\s/.test(r.str) ? ' ' : '') + str + (/\s$/.test(r.str) ? ' ' : '') });
      patched++;
    }
  }
  return { runs: out, patched };
}
