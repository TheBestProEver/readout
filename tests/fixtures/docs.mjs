// Small documents of every kind Readout opens, built in Node with known text (Word,
// PowerPoint, OpenDocument, EPUB, RTF, a web page, Markdown, plain text).
import zlib from 'node:zlib';

// A ZIP with every file stored (no compression): enough for the readers.
export function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = (list) => XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"/>`).join('') + '</Relationships>';
const types = (part, type) => XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="${part}" ContentType="${type}"/></Types>`;

export function docx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const p = (t, styleId) => `<w:p>${styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const styles = XML + `<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`;
  const body = [p('Garden Notes', 'Heading1'), p('Tomatoes need full sun and deep watering.'), p('Basil grows well beside them.')].join('');
  return zip([
    ['[Content_Types].xml', types('/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']])],
    ['word/_rels/document.xml.rels', rels([['rId1', 'styles', 'styles.xml']])],
    ['word/document.xml', XML + `<w:document ${W}><w:body>${body}</w:body></w:document>`],
    ['word/styles.xml', styles],
  ]);
}

export function pptx() {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sp = (ph, y, text) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="${y}"/><a:ext cx="8000000" cy="800000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const slide = (title, body) => XML + `<p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp('<p:ph type="title"/>', 300000, title)}${sp('<p:ph idx="1"/>', 1500000, body)}</p:spTree></p:cSld></p:sld>`;
  return zip([
    ['[Content_Types].xml', types('/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')],
    ['_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', XML + `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels([['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']])],
    ['ppt/slides/slide1.xml', slide('Quarterly Plan', 'Hire two more bakers.')],
    ['ppt/slides/slide2.xml', slide('Budget', 'Ovens cost less this year.')],
  ]);
}

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"';
const odfManifest = (mime) => XML + `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;

export function odt() {
  const content = XML + `<office:document-content ${ODF_NS}><office:body><office:text><text:h text:outline-level="1">River Walk</text:h><text:p>The path follows the river for two miles.</text:p><text:p>Herons nest near the weir.</text:p></office:text></office:body></office:document-content>`;
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.text'],
    ['content.xml', content],
    ['META-INF/manifest.xml', odfManifest('application/vnd.oasis.opendocument.text')],
  ]);
}

export function odp() {
  const frame = (cls, t) => `<draw:frame presentation:class="${cls}" svg:x="1cm" svg:y="1cm"><draw:text-box><text:p>${t}</text:p></draw:text-box></draw:frame>`;
  const content = XML + `<office:document-content ${ODF_NS}><office:body><office:presentation><draw:page draw:name="p1">${frame('title', 'Bird Survey')}${frame('outline', 'Count the swallows at dawn.')}</draw:page></office:presentation></office:body></office:document-content>`;
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.presentation'],
    ['content.xml', content],
    ['META-INF/manifest.xml', odfManifest('application/vnd.oasis.opendocument.presentation')],
  ]);
}

export function epub() {
  const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:readout-test</dc:identifier><dc:title>The Lantern Book</dc:title><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  return zip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', opf],
    ['OEBPS/nav.xhtml', xhtml('Contents', '<nav epub:type="toc"><h1>Contents</h1><ol><li><a href="ch1.xhtml">Chapter One</a></li><li><a href="ch2.xhtml">Chapter Two</a></li></ol></nav>')],
    ['OEBPS/ch1.xhtml', xhtml('One', '<section epub:type="chapter"><h1>Chapter One</h1><p>The lantern burned all night in the window.</p></section>')],
    ['OEBPS/ch2.xhtml', xhtml('Two', '<section epub:type="chapter"><h1>Chapter Two</h1><p>At dawn the fishermen came home.</p></section>')],
  ]);
}

export const rtf = () => Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24 Letter to the editor.\\par\\par The bridge needs {\\b new} paint before winter.\\par}', 'latin1');

export const html = () =>
  Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Night Trains</title></head><body><nav><a href="/">Home</a> <a href="/about">About</a></nav><article><h1>Night Trains</h1><p>The sleeper leaves the station at ten and arrives by morning.</p><p>Passengers can book a cabin for two.</p></article><footer>Copyright 2026 Example News</footer></body></html>');

export const markdown = () => Buffer.from('# Packing List\n\nBring *warm* socks and a **rain** jacket.\n\n- passport\n- charger\n');

export const text = () => Buffer.from('Plain notes about the meeting.\n\nWe agreed to meet again on Friday.\n');

// [file name, MIME type, bytes, words that must be in the text, words that must not]
export function all() {
  return [
    ['Garden notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx(), ['Tomatoes need full sun', 'Basil grows'], []],
    ['Quarterly plan.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptx(), ['Hire two more bakers', 'Ovens cost less'], []],
    ['River walk.odt', 'application/vnd.oasis.opendocument.text', odt(), ['follows the river', 'Herons nest'], []],
    ['Bird survey.odp', 'application/vnd.oasis.opendocument.presentation', odp(), ['Count the swallows'], []],
    ['Lantern book.epub', 'application/epub+zip', epub(), ['lantern burned', 'fishermen came home'], []],
    ['Editor letter.rtf', 'application/rtf', rtf(), ['Letter to the editor', 'needs new paint'], ['fonttbl', 'Times New Roman']],
    ['Night trains.html', 'text/html', html(), ['sleeper leaves the station', 'book a cabin'], ['Copyright 2026']],
    ['Packing list.md', 'text/markdown', markdown(), ['Packing List', 'warm socks', 'passport'], ['**', '*warm*']],
    ['Meeting.txt', 'text/plain', text(), ['meet again on Friday'], []],
  ];
}
