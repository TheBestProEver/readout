// End-to-end test for opening PDFs and photos: text PDFs, scanned PDFs, and pictures
// read with OCR. Needs Chrome or Edge, and the internet (pdf.js and Tesseract load from jsDelivr).
//   node tests/pdf.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker, connect, launchChrome, newDevice, staticServer } from './browser.mjs';

const result = checker();
const check = result.check;

/* ---------- tiny PDF writer: text pages and full-page pictures ---------- */

const pdfString = (s) => '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';

function makePdf(pages) {
  const objs = [null, null, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const add = (b) => objs.push(b);
  const kids = [];
  for (const pg of pages) {
    let stream;
    let res;
    if (pg.jpeg) {
      const im = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`), pg.jpeg, Buffer.from('\nendstream')]));
      stream = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
      res = `<< /XObject << /Im1 ${im} 0 R >> >>`;
    } else {
      const parts = [];
      if (pg.header) parts.push(`BT /F1 10 Tf 72 750 Td ${pdfString(pg.header)} Tj ET`);
      pg.lines.forEach((l, i) => parts.push(`BT /F1 12 Tf 72 ${700 - i * 18} Td ${pdfString(l)} Tj ET`));
      if (pg.footer) parts.push(`BT /F1 10 Tf 280 40 Td ${pdfString(pg.footer)} Tj ET`);
      stream = parts.join('\n');
      res = '<< /Font << /F1 3 0 R >> >>';
    }
    const c = add(Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
    kids.push(add(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${c} 0 R >>`)));
  }
  objs[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
  const out = [Buffer.from('%PDF-1.4\n')];
  let pos = out[0].length;
  const offsets = objs.map((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    out.push(b);
    const at = pos;
    pos += b.length;
    return at;
  });
  out.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(out);
}

const SCAN = [
  ['The lighthouse keeper climbed the stairs', 'every evening before the sun went down.', 'He wiped the glass and lit the lamp,', 'then sat by the window with his tea.'],
  ['Ships passed in the dark, far from shore.', 'None of them knew his name, but all', 'of them trusted the light he kept.'],
  ['Winter brought storms that shook the tower.', 'Still the lamp burned through the night.'],
  ['In spring a letter came from the mainland.', 'It thanked him for forty quiet years.'],
];

async function main() {
  const app = staticServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${app.address().port}/`;
  const chrome = await launchChrome();
  const cdp = await connect(chrome.url);
  const shots = process.env.SHOTS || os.tmpdir();
  try {
    const phone = await newDevice(cdp, 'phone', { phone: true });
    await phone.goto(appUrl);
    await phone.eval(`
      T.openFile = async (b64, name, type) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type }));
        const input = T.$('fileInput');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
      };
      T.page = (lines, type) => {
        const c = document.createElement('canvas');
        c.width = 1224; c.height = 1584;
        const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = '#111'; x.font = '40px Georgia, serif';
        lines.forEach((l, i) => x.fillText(l, 110, 180 + i * 64));
        return c.toDataURL(type || 'image/jpeg', 0.92).split(',')[1];
      };
      T.docByTitle = (t) => T.R().state.docs.find((d) => d.title === t);
    `);
    const scanPage = async (lines) => ({ jpeg: Buffer.from(await phone.eval(`return T.page(${JSON.stringify(lines)})`), 'base64'), w: 1224, h: 1584 });
    const open = (buf, name, type) => phone.eval(`await T.openFile(${JSON.stringify(buf.toString('base64'))}, ${JSON.stringify(name)}, ${JSON.stringify(type || 'application/pdf')})`);
    const waitDoc = (title, ms) => phone.eval(`await T.wait(() => T.docByTitle(${JSON.stringify(title)}), ${ms || 30000}, 'the doc'); return T.docByTitle(${JSON.stringify(title)}).text;`);

    console.log('A PDF with text');
    const words = ['apples', 'rivers', 'lanterns', 'harbors', 'meadows', 'engines'];
    const textPdf = makePdf(
      words.map((w, i) => ({
        header: i % 2 ? `${i + 1}   Chapter 2: Slow Books` : `The Art of Reading   ${i + 1}`,
        lines: Array.from({ length: 10 }, (_, k) => `This is line ${k + 1} on the page about ${w}, and it keeps going.`),
        footer: `Page ${i + 1} of ${words.length}`,
      }))
    );
    await open(textPdf, 'Reading notes.pdf');
    const t1 = await waitDoc('Reading notes', 60000);
    check(words.every((w) => t1.includes(`page about ${w}`)), 'every page’s text is there');
    check(!/The Art of Reading|Slow Books|Page \d of 6/.test(t1), 'running headers and page numbers are left out', t1.slice(0, 300));
    check((await phone.eval('return T.R().state.current && T.R().state.current.title')) === 'Reading notes', 'and it opens ready to play');
    check(!(await phone.eval(`return T.$('ocrSheet').open`)), 'no question about pictures for a normal PDF');

    console.log('A short text PDF with a blank page');
    const letter = makePdf([
      { lines: ['Dear Sam,', 'Thank you for the books you sent last week.', 'The one about lighthouses was my favorite.'] },
      { lines: ['I will bring them back when I visit in June.', 'Warm wishes, Alex'] },
      { lines: [] },
    ]);
    await open(letter, 'Letter.pdf');
    const tl = await waitDoc('Letter', 60000);
    check(/books you sent/.test(tl) && /Warm wishes/.test(tl), 'opens with its text');
    check(!(await phone.eval(`return T.$('ocrSheet').open`)), 'and a blank page doesn’t make it look scanned');

    console.log('A scanned PDF, first time');
    const scan = makePdf([await scanPage(SCAN[0]), await scanPage(SCAN[1])]);
    await open(scan, 'Lighthouse scan.pdf');
    await phone.eval(`await T.wait(() => T.$('ocrSheet').open, 30000, 'the question')`);
    check(true, 'asks before the one-time download');
    check(/Lighthouse scan\.pdf” is scanned pages/.test(await phone.eval(`return T.$('ocrSheet').textContent`)), 'and says why');
    const overflow = await phone.eval(`const w = innerWidth; return [...document.querySelectorAll('#ocrSheet *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > w + 0.5 || r.left < -0.5); }).length`);
    check(overflow === 0, 'the question fits a 360 px phone screen');
    await phone.screenshot(path.join(shots, 'readout-ocr-question.png'));
    await phone.eval(`T.$('ocrYesBtn').click()`);
    await phone.eval(`await T.wait(() => /Reading the text in page|Getting ready/.test(T.toast()), 30000, 'progress')`);
    check(true, 'shows progress');
    const t2 = await waitDoc('Lighthouse scan', 180000);
    const lower = t2.toLowerCase();
    check(['lighthouse', 'keeper', 'stairs', 'ships', 'trusted'].every((w) => lower.includes(w)), 'the words in the pictures are read', t2);
    check(/lit the lamp/i.test(t2.replace(/\s+/g, ' ')), 'accurately enough to read aloud', t2);

    console.log('A photo of a page');
    const photo = Buffer.from(await phone.eval(`return T.page(${JSON.stringify(SCAN[2])}, 'image/png')`), 'base64');
    await open(photo, 'Tower photo.png', 'image/png');
    check(!(await phone.eval(`await new Promise(r => setTimeout(r, 300)); return T.$('ocrSheet').open`)), 'after one yes, it doesn’t ask again');
    const t3 = await waitDoc('Tower photo', 120000);
    check(/storms/i.test(t3) && /tower/i.test(t3), 'a photo’s text is read too', t3);

    console.log('Stopping part way');
    const four = makePdf(await Promise.all(SCAN.map((l) => scanPage(l))));
    await open(four, 'Four pages.pdf');
    await phone.eval(`await T.wait(() => /page 1 of 4/.test(T.toast()), 60000, 'page 1'); T.$('toastAction').click();`);
    const t4 = await waitDoc('Four pages', 120000);
    check(/lighthouse/i.test(t4) && !/mainland/i.test(t4), 'Stop keeps the pages read so far', t4);

    console.log('When the text reader can’t be downloaded');
    const broken = await newDevice(cdp, 'offline phone', { phone: true, config: { ocrLangPath: appUrl + 'no-such-folder', ocrStall: 15000 } });
    await broken.goto(appUrl);
    const openOn = (dev, buf, name) => dev.eval(`
      const bytes = Uint8Array.from(atob(${JSON.stringify(buf.toString('base64'))}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'application/pdf' }));
      T.$('fileInput').files = dt.files;
      T.$('fileInput').dispatchEvent(new Event('change'));`);
    const mixed = makePdf([
      { lines: Array.from({ length: 10 }, (_, k) => `Typed page one, line ${k + 1}, about the harbor.`) },
      await scanPage(SCAN[0]),
      { lines: Array.from({ length: 10 }, (_, k) => `Typed page three, line ${k + 1}, about the tide.`) },
      await scanPage(SCAN[1]),
    ]);
    await openOn(broken, mixed, 'Mixed.pdf');
    await broken.eval(`await T.wait(() => T.$('ocrSheet').open, 30000, 'the question'); T.$('ocrYesBtn').click();`);
    const tm = await broken.eval(`await T.wait(() => T.R().state.docs.find((d) => d.title === 'Mixed'), 60000, 'the doc'); return T.R().state.docs.find((d) => d.title === 'Mixed').text;`);
    check(/about the harbor/.test(tm) && /about the tide/.test(tm), 'a PDF with typed pages still opens with their text');
    check(/Couldn’t read the pictures/.test(await broken.eval('return T.toast()')), 'and says the pictures couldn’t be read', await broken.eval('return T.toast()'));
    await openOn(broken, scan, 'Only pictures.pdf');
    await broken.eval(`await T.wait(() => /Couldn’t open/.test(T.toast()), 60000, 'an error message');`);
    check(!(await broken.eval(`return T.R().state.docs.some((d) => d.title === 'Only pictures')`)), 'a scan that can’t be read shows a message instead of hanging');
    check(!(await broken.eval(`return /Getting ready/.test(T.toast())`)), 'and the “getting ready” message is gone');

    console.log('Saying no');
    const fresh = await newDevice(cdp, 'fresh phone', { phone: true });
    await fresh.goto(appUrl);
    await fresh.eval(`
      const bytes = Uint8Array.from(atob(${JSON.stringify(scan.toString('base64'))}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'Declined.pdf', { type: 'application/pdf' }));
      T.$('fileInput').files = dt.files;
      T.$('fileInput').dispatchEvent(new Event('change'));
      await T.wait(() => T.$('ocrSheet').open, 30000, 'the question');
      document.querySelector('#ocrSheet [data-close]').click();
      await T.wait(() => /No text to read/.test(T.toast()), 10000, 'the message');
    `);
    check(!(await fresh.eval(`return T.R().state.docs.some((d) => d.title === 'Declined')`)), 'cancelling adds nothing and says why');

    console.log('Console');
    for (const dev of [phone, fresh]) {
      // (the offline phone logs the failed downloads on purpose)
      const bad = dev.logs.filter((l) => l.type === 'exception' || l.type === 'error');
      check(!bad.length, `no errors on the ${dev.name}`, bad);
    }
  } finally {
    cdp.close();
    chrome.proc.kill();
    app.close();
  }
  console.log(`\n${result.checks - result.failures}/${result.checks} PDF and photo checks passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .then(() => {
    if (result.failures) process.exitCode = 1;
  });
