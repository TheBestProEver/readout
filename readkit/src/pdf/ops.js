// What a page draws, from its pdf.js operator list: how much of the text is invisible
// (render mode 3, the OCR layer scanners add) or hidden under a page-sized image, how
// much of the page the largest image covers, whether anything besides text is painted,
// and which fonts are bold. Pure: takes { fnArray, argsArray }, pdf.js's OPS table, the
// page's view box and a font lookup.

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// Share of the page box covered by the unit square under matrix m.
function coverage(m, view) {
  const pts = [
    [m[4], m[5]],
    [m[0] + m[4], m[1] + m[5]],
    [m[2] + m[4], m[3] + m[5]],
    [m[0] + m[2] + m[4], m[1] + m[3] + m[5]],
  ];
  const x0 = Math.max(view[0], Math.min(...pts.map((p) => p[0])));
  const x1 = Math.min(view[2], Math.max(...pts.map((p) => p[0])));
  const y0 = Math.max(view[1], Math.min(...pts.map((p) => p[1])));
  const y1 = Math.min(view[3], Math.max(...pts.map((p) => p[1])));
  const area = (view[2] - view[0]) * (view[3] - view[1]);
  if (x1 <= x0 || y1 <= y0 || !(area > 0)) return 0;
  return ((x1 - x0) * (y1 - y0)) / area;
}

function glyphCount(glyphs) {
  let n = 0;
  if (!Array.isArray(glyphs)) return 0;
  for (const g of glyphs) if (g && typeof g === 'object' && !g.isSpace && g.unicode && g.unicode.trim()) n++;
  return n;
}

const BOLD_NAME = /bold|black|heavy|semibold|demibold|demi\b|extrabold|ultrabold|[-,+](?:bd|sb|hv|blk)\b|w[6-9]\b/i;

export function isBoldFont(font) {
  if (!font) return false;
  if (font.bold || font.black) return true;
  return BOLD_NAME.test(String(font.name || ''));
}

// opList: { fnArray, argsArray }; OPS: pdf.js OPS; view: page.view ([x0, y0, x1, y1]);
// fontOf(name) -> pdf.js font object or null.
export function analyzeOps(opList, OPS, view, fontOf) {
  const fn = opList.fnArray || [];
  const args = opList.argsArray || [];
  const stack = [];
  let ctm = IDENTITY;
  let mode = 0;
  let glyphs = 0;
  let invisible = 0;
  let hidden = 0; // visible glyphs painted before the last page-sized image
  let maxImage = 0;
  let images = 0;
  let paths = 0;
  const fonts = {};
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup].filter((v) => v !== undefined));
  const pathOps = new Set([OPS.constructPath, OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.shadingFill, OPS.rawFillPath].filter((v) => v !== undefined));
  for (let i = 0; i < fn.length; i++) {
    const f = fn[i];
    const a = args[i];
    switch (f) {
      case OPS.save:
        stack.push([ctm, mode]);
        break;
      case OPS.restore:
        if (stack.length) [ctm, mode] = stack.pop();
        break;
      case OPS.transform:
        if (a && a.length >= 6) ctm = mul(ctm, a);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push([ctm, mode]);
        if (a && Array.isArray(a[0]) && a[0].length >= 6) ctm = mul(ctm, a[0]);
        else if (a && a[0] && a[0].length >= 6) ctm = mul(ctm, Array.from(a[0]));
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) [ctm, mode] = stack.pop();
        break;
      case OPS.beginGroup:
        stack.push([ctm, mode]);
        if (a && a[0] && a[0].matrix && a[0].matrix.length >= 6) ctm = mul(ctm, Array.from(a[0].matrix));
        break;
      case OPS.endGroup:
        if (stack.length) [ctm, mode] = stack.pop();
        break;
      case OPS.setTextRenderingMode:
        mode = a ? a[0] : 0;
        break;
      case OPS.setFont: {
        const name = a && a[0];
        if (name && !(name in fonts)) fonts[name] = { bold: isBoldFont(fontOf && fontOf(name)) };
        break;
      }
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const n = glyphCount(a && a[0]);
        glyphs += n;
        if (mode === 3 || mode === 7) invisible += n;
        break;
      }
      default:
        if (imageOps.has(f)) {
          images++;
          let cov = coverage(ctm, view);
          if (f === OPS.paintImageXObjectRepeat || f === OPS.paintImageMaskXObjectRepeat) cov = Math.min(1, cov * Math.max(1, ((a && a[3] && a[3].length) || 2) / 2));
          if (cov > maxImage) maxImage = cov;
          // Text painted before a page-sized image is hidden underneath it.
          if (cov >= 0.85) hidden = glyphs - invisible;
        } else if (pathOps.has(f)) paths++;
    }
  }
  return {
    glyphs,
    invisible,
    hidden,
    hiddenShare: glyphs ? Math.min(1, (invisible + hidden) / glyphs) : 0,
    maxImage,
    images,
    paths,
    paints: images + paths > 0,
    fonts,
  };
}

// A scanned page whose text is the scanner's own invisible OCR layer.
export function isScanLayer(info) {
  if (!info || !info.glyphs) return false;
  if (info.invisible / info.glyphs >= 0.5 && info.maxImage >= 0.5) return true;
  return info.hiddenShare >= 0.5 && info.maxImage >= 0.85;
}
