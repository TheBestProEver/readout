// Readout 2.0 end to end, in headless Chrome with Android's freezing rule emulated:
//   scan      a synthetic scanned book (scanner's hidden text layer, margin notes, footnotes,
//             running heads) opened as a file -> clean text; the notes setting
//   private   your own PDFs in READKIT_PRIVATE (with readkit golden files), read in place,
//             scored in Node, deleted again; only numbers are printed
//   plan      plan()-based highlighting: spans, spoken text, tap, headings list, pronunciations
//   device    the device voice before anything is downloaded, and the offer to download
//   piper     Standard (Piper en_US-ryan-medium): download dialog, playing in a hidden page for
//             over a minute with highlighting, Media Session controls, tap/scrub/speed, Save
//             audio, resume from the saved place, a voice failure falling back to the device voice
//   sleep     sleep timer with the page hidden (fade, stop), Play next text, End of text
//   kokoro    Natural (Kokoro am_michael on WebGPU) the same way, hidden for over a minute
//   layout    settings and sheets fit a 360 px screen; no console errors
//   nokit     readkit blocked: Readout still starts, keeps texts and reads them line by line
//   old       1.x features: dictation (a stand-in recognizer), search, themes, install, backup
//   sw        the service worker on a server without headers: one reload to cross-origin
//             isolation, COOP/COEP on responses, readkit cached, Google Fonts, pdf.js, Tesseract,
//             onnxruntime from jsDelivr, gist sync, the share sheet's POST, ?text=, offline
//   node tests/v2.e2e.mjs [section,...]
// Env: READKIT_SCRATCH (local model copies, see tests/fixtures/servers.mjs; without it the voice
// sections skip), READKIT_ASSETS, V2_HIDDEN_S (seconds hidden per voice, default 65), SHOTS.
// sw needs the internet (jsDelivr, Google Fonts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE_HELPERS, checker, connect, launchChrome, newDevice, sleep } from './browser.mjs';
import { appServer, modelServer, assetConfig, have } from './fixtures/servers.mjs';
import { fakeGitHub } from './fixtures/github.mjs';
import { all as otherFiles } from './fixtures/docs.mjs';

const only = process.argv[2] || '';
const want = (s) => !only || only.split(',').includes(s);
const HIDDEN_S = +process.env.V2_HIDDEN_S || 65;
const FREEZE = '--enable-features=stop-in-background:DelayForBackgroundTabFreezingMills/5000';
const shots = process.env.SHOTS || os.tmpdir();
const c = checker();
const check = c.check;

// The user's own documents, read in place (never copied, quoted or named): every <name>.pdf in
// READKIT_PRIVATE with a <name>.golden.json beside it (readkit's golden format).
const PRIVATE = process.env.READKIT_PRIVATE ? path.resolve(process.env.READKIT_PRIVATE) : null;
const privateDocs = PRIVATE && fs.existsSync(PRIVATE) ? fs.readdirSync(PRIVATE).filter((n) => /\.pdf$/i.test(n) && fs.existsSync(path.join(PRIVATE, n.replace(/\.pdf$/i, '.golden.json')))).sort() : [];

// In every page: a 20 ms timer probe and freeze events (a frozen page stops its timers), a spy
// on the Media Session (the lock screen's buttons call these handlers), downloads captured,
// and every toast logged.
const PROBE = `
window.__probe = { log: [], events: [] };
(() => { let last = performance.now(); const tick = () => { const n = performance.now(); __probe.log.push([n, n - last]); if (__probe.log.length > 40000) __probe.log.shift(); last = n; setTimeout(tick, 20); }; tick(); })();
for (const e of ['freeze', 'resume', 'visibilitychange']) document.addEventListener(e, () => __probe.events.push({ e, t: performance.now(), vis: document.visibilityState }));
__probe.maxGap = (since) => { let m = 0; for (const [t, d] of __probe.log) if (t >= since && d > m) m = d; return m; };
window.__ms = { handlers: {}, positions: 0, last: null };
if (navigator.mediaSession) {
  const ms = navigator.mediaSession;
  const set = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (a, fn) => { __ms.handlers[a] = fn; try { set(a, fn); } catch (e) {} };
  if (ms.setPositionState) { const sp = ms.setPositionState.bind(ms); ms.setPositionState = (s) => { __ms.positions++; __ms.last = s || null; try { sp(s); } catch (e) {} }; }
}
window.__downloads = [];
const aClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () { if (this.download) { __downloads.push({ name: this.download, href: this.href }); return; } return aClick.call(this); };
window.__toasts = [];
document.addEventListener('DOMContentLoaded', () => {
  const m = document.getElementById('toastMsg');
  if (m) new MutationObserver(() => __toasts.push(m.textContent)).observe(m, { childList: true, characterData: true, subtree: true });
});
true;
`;

// What the app is doing, for a failed wait.
const SNAPSHOT = `const R = window.__readout; if (!R) return null; const p = R.au.player; return { doc: R.state.current && R.state.current.title, idx: R.state.idx, segs: R.state.segs.length, playing: R.tts.playing, engine: R.tts.engine, player: p && p.state, voice: R.au.voice && R.au.voice.id, loading: !!R.au.loading, broken: R.au.broken, waiting: R.au.waiting, toasts: (window.__toasts || []).slice(-4) };`;

// Samples what is heard and what is highlighted, every 100 ms (runs while hidden too).
const WATCH = `
window.__watch && clearInterval(window.__watch.timer);
window.__watch = { rows: [], timer: setInterval(() => {
  const R = window.__readout; const p = R.au.player; const ct = R.au.el.currentTime;
  const at = p && p.timeline.at(ct * 1e6);
  const cur = document.querySelector('.chunk.is-current');
  __watch.rows.push([performance.now(), R.state.idx, at ? at.index : null, at ? at.kind : null, cur ? +cur.dataset.i : -1, ct, document.visibilityState, R.au.el.volume, R.tts.playing]);
}, 100) };
true;`;

async function main() {
  const models = await modelServer();
  const app = await appServer({ isolate: true, files: Object.fromEntries(privateDocs.map((n, i) => ['/_private/' + i, path.join(PRIVATE, n)])) });
  const chrome = await launchChrome({ gpu: true, extra: ['--enable-unsafe-webgpu', '--disable-audio-output', FREEZE, '--autoplay-policy=document-user-activation-required'] });
  const cdp = await connect(chrome.url);
  const devices = [];
  const url = app.base + '/?local=' + encodeURIComponent(models.base);
  try {
    const phone = await newDevice(cdp, 'phone', { phone: true, touch: false, config: { readkit: assetConfig(models.base) }, init: PROBE });
    devices.push(phone);
    const ev = (expr) => phone.eval(expr);
    const waitFor = (expr, ms, what) => ev(`await T.wait(() => (${expr}), ${ms || 15000}, ${JSON.stringify(what || expr)}); return true;`).catch(async (e) => { throw new Error(e.message + ' -- state: ' + JSON.stringify(await ev(SNAPSHOT).catch(() => null))); });
    const prep = () => ev(`T.docById = (id) => T.R().state.docs.find((d) => d.id === id); T.cur = () => T.R().state.current; return 1`);
    await phone.goto(url);
    await prep();
    const openFile = (b64, name, type) =>
      ev(`const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })); T.$('fileInput').files = dt.files; T.$('fileInput').dispatchEvent(new Event('change')); return 1`);

    /* ---------- scan ---------- */
    if (want('scan')) {
      console.log('A scanned course reading (hidden OCR layer, margin notes, footnotes, running heads)');
      const book = await ev(`
        const { scannedBook } = await import('/tests/fixtures/scanbook.mjs');
        const b = await scannedBook();
        window.BOOK = b;
        let s = ''; for (let i = 0; i < b.bytes.length; i += 32768) s += String.fromCharCode(...b.bytes.subarray(i, i + 32768));
        return { b64: btoa(s), truth: b.truth };`);
      const before = await ev('return T.R().state.docs.length');
      await openFile(book.b64, 'scan0001.pdf', 'application/pdf');
      await waitFor(`T.$('ocrSheet').open`, 60000, 'the OCR question');
      check(/scan0001\.pdf” is scanned pages/.test(await ev(`return T.$('ocrSheet').textContent`)), 'asks once before reading the pictures, and says why');
      await phone.click('#ocrYesBtn');
      await waitFor(`T.R().state.docs.length > ${before} && T.cur() && /Eastford/.test(T.cur().text)`, 300000, 'the scan to open');
      const r = await ev(`
        const { wer } = await import('/tests/fixtures/wer.mjs');
        const t = T.cur().text; const B = BOOK.truth;
        const flat = t.replace(/\\s+/g, ' ');
        return { title: T.cur().title, text: t, bodyWer: wer(B.paras.join('\\n'), t.split('\\n\\n').filter((p) => !/^CHAPTER|^OF THE RIVER/i.test(p)).join('\\n')),
          notes: B.notes.filter((n) => flat.includes(n)), foots: B.footnotes.filter((f) => flat.includes(f.slice(0, 30))), head: flat.includes(B.heads[0]),
          runOn: B.runOn.every((i) => t.split('\\n\\n').some((p) => wer(B.paras[i], p) <= 2)),
          pageNums: /(^|\\n)\\d{1,3}(\\n|$)/.test(t), spokenDigits: T.R().state.segs.some((s) => /\\d/.test(s.spoken)), first: T.R().state.segs[0] && T.R().state.segs[0].kind };`);
      check(r.bodyWer <= 2, `the body text comes out right (word error rate ${r.bodyWer.toFixed(2)}%)`, r.text.slice(0, 300));
      check(!r.notes.length && !r.foots.length && !r.head && !r.pageNums, 'without margin notes, footnotes, running heads or page numbers', r);
      check(r.runOn, 'a sentence broken by a page break reads on as one');
      check(/chapter/i.test(r.title), `titled from the chapter heading, not “scan0001” (${r.title})`, r.title);
      check(r.first === 'heading' && !r.spokenDigits, 'the plan opens with the heading and speaks every number as words', r);
      // the setting keeps the notes (next file opened)
      await ev(`T.$('settingsBtn').click(); return 1`);
      await phone.click('#notesToggle + .switch');
      check(await ev(`return T.R().state.settings.includeNotes === true`), 'Settings: “Include footnotes and margin notes” turns on');
      await ev(`T.closeSheets(); return 1`);
      const n2 = await ev('return T.R().state.docs.length');
      await openFile(book.b64, 'scan0001.pdf', 'application/pdf');
      await waitFor(`T.R().state.docs.length > ${n2} && T.cur() && /Eastford/.test(T.cur().text)`, 300000, 'the scan, with notes');
      const r2 = await ev(`const flat = T.cur().text.replace(/\\s+/g, ' '); const B = BOOK.truth; return { notes: B.notes.filter((n) => flat.includes(n)).length, foots: B.footnotes.filter((f) => flat.includes(f.slice(0, 30))).length, head: flat.includes(B.heads[0]), all: B.notes.length + B.footnotes.length };`);
      check(r2.notes + r2.foots >= r2.all - 1 && !r2.head, `with it on, the notes are read too (${r2.notes + r2.foots} of ${r2.all}), running heads still left out`, r2);
      await ev(`T.$('settingsBtn').click(); return 1`);
      await phone.click('#notesToggle + .switch');
      await ev(`T.closeSheets(); return 1`);
    }

    /* ---------- private ---------- */
    if (want('private')) {
      if (!privateDocs.length) console.log('Your own documents: skipped (READKIT_PRIVATE not set, or no <name>.pdf + <name>.golden.json in it)');
      const norm = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
      const words = (s) => norm(s).split(' ').filter(Boolean);
      for (let i = 0; i < privateDocs.length; i++) {
        console.log(`Your own document ${i + 1} (read in place; only numbers are reported)`);
        const golden = JSON.parse(fs.readFileSync(path.join(PRIVATE, privateDocs[i].replace(/\.pdf$/i, '.golden.json')), 'utf8'));
        const before = await ev('return T.R().state.docs.length');
        await ev(`const b = await (await fetch('/_private/${i}')).arrayBuffer(); const dt = new DataTransfer(); dt.items.add(new File([b], 'document-${i + 1}.pdf', { type: 'application/pdf' })); T.$('fileInput').files = dt.files; T.$('fileInput').dispatchEvent(new Event('change')); return 1`);
        // (no snapshot on these waits: it would show the document's title)
        const asked = await ev(`try { await T.wait(() => T.$('ocrSheet').open || T.R().state.docs.length > ${before}, 120000); } catch (e) { return false; } return T.$('ocrSheet').open`);
        if (asked) await phone.click('#ocrYesBtn');
        const t0 = Date.now();
        const done = await ev(`try { await T.wait(() => T.R().state.docs.length > ${before}, 1200000); } catch (e) { return false; } return true`);
        check(done, `document ${i + 1} opens (${Math.round((Date.now() - t0) / 1000)} s)`);
        if (!done) continue;
        const text = await ev('return T.R().state.docs[T.R().state.docs.length - 1].text');
        const bag = new Map();
        for (const w of words(text)) bag.set(w, (bag.get(w) || 0) + 1);
        let found = 0;
        let total = 0;
        for (const p of golden.pages) {
          for (const w of words(p.body)) {
            total++;
            const n = bag.get(w) || 0;
            if (n > 0) {
              found++;
              bag.set(w, n - 1);
            }
          }
        }
        const flat = ' ' + norm(text) + ' ';
        const has = (s) => !!s && flat.includes(' ' + s + ' ');
        const notes = golden.pages.flatMap((p) => p.margin_notes || []).map(norm).filter((n) => n.split(' ').length >= 2);
        const foots = golden.pages.flatMap((p) => p.footnotes || []).map((x) => words(String(x).replace(/^\s*\d+\.?\s*/, '')).slice(0, 8).join(' ')).filter((x) => x.split(' ').length >= 3);
        const heads = [...new Set(golden.pages.map((p) => norm(p.running_header)).filter(Boolean))];
        const headWords = new Set(golden.pages.flatMap((p) => (p.headings || []).map(norm)));
        const count = (s) => flat.split(' ' + s + ' ').length - 1;
        const r = { body: total ? (100 * found) / total : 0, words: total, notesIn: notes.filter(has).length, notes: notes.length, footsIn: foots.filter(has).length, foots: foots.length, headsIn: heads.filter((h) => !headWords.has(h)).reduce((n, h) => n + count(h), 0) };
        console.log(`   body words found ${r.body.toFixed(1)}% of ${r.words}; margin notes left out ${r.notes - r.notesIn}/${r.notes}; footnotes left out ${r.foots - r.footsIn}/${r.foots}; running heads read ${r.headsIn}`);
        check(r.body >= 98, `document ${i + 1}: the body text is all there (${r.body.toFixed(1)}% of the golden words)`, { body: r.body });
        check(r.notesIn === 0 && r.footsIn === 0 && r.headsIn === 0, `document ${i + 1}: no margin notes, footnotes or running heads in it`, { notesIn: r.notesIn, footsIn: r.footsIn, headsIn: r.headsIn });
        // the document stays only in this test's temporary browser profile
        await ev(`const R = T.R(); const d = R.state.docs[R.state.docs.length - 1]; T.open(d.id); T.$('moreBtn').click(); document.querySelector('[data-act="delete"]').click(); T.closeSheets(); T.$('toast').hidden = true; __toasts.length = 0; return 1`);
      }
    }

    /* ---------- plan ---------- */
    if (want('plan')) {
      console.log('Highlighting from the speech plan');
      const text = '# Prices\n\nDr. Patel paid $5 on 3/4/2021 (Lee et al., 2020). Then he left.\n\n## Notes\n\nThe end came at 5 p.m. sharp.';
      const id = await ev(`const id = T.newNote(${JSON.stringify(text)}); T.done(); return id;`);
      const p = await ev(`const R = T.R(); const t = R.state.current.text; return { segs: R.state.segs.map((s) => ({ shown: t.slice(s.start, s.end), spoken: s.spoken, kind: s.kind })), spans: [...document.querySelectorAll('#reader .chunk')].map((s) => s.textContent) };`);
      check(p.spans.length === p.segs.length && p.spans.every((s, i) => s === p.segs[i].shown), 'each segment is a span over its own text', p);
      check(p.segs[1] && p.segs[1].shown.includes('$5') && /Doctor Patel paid five dollars/.test(p.segs[1].spoken) && !/Lee/.test(p.segs[1].spoken), 'the page shows the text; the voice says it in words, citations skipped', p.segs[1]);
      check(p.segs[0].kind === 'heading' && p.segs[0].shown === 'Prices', 'headings are their own segments, without the # marks', p.segs[0]);
      await ev(`document.querySelector('#reader .chunk[data-i="2"]').click(); return 1`);
      await waitFor(`T.R().state.idx === 2 && document.querySelector('.chunk.is-current').dataset.i === '2'`, 5000, 'tap to jump');
      check(true, 'tapping a sentence goes there');
      await ev(`T.R().tts.playing && T.$('playBtn').click(); return 1`);
      await ev(`T.$('moreBtn').click(); document.querySelector('[data-act="chapters"]').click(); return 1`);
      const toc = await ev(`return [...document.querySelectorAll('#chaptersList .menu-item')].map((b) => [b.textContent, b.dataset.level])`);
      check(JSON.stringify(toc) === JSON.stringify([['Prices', '1'], ['Notes', '2']]), 'the headings list shows the text’s headings', toc);
      await ev(`[...document.querySelectorAll('#chaptersList .menu-item')][1].click(); return 1`);
      await waitFor(`document.querySelector('.chunk.is-current').textContent === 'Notes'`, 5000, 'jump to a heading');
      check(!(await ev(`return T.$('chaptersSheet').open`)), 'and jumps to one');
      const saved = await ev(`await new Promise((r) => setTimeout(r, 1700)); const R = T.R(); const pos = R.state.positions.get(${JSON.stringify(id)}); return { pos, start: R.state.segs[R.state.idx].start };`);
      check(saved.pos && saved.pos.offset === saved.start && Object.keys(saved.pos).join() === 'id,offset,progress,done,at', 'the place is saved per segment, in the format sync uses', saved);
      await ev(`T.$('settingsBtn').click(); T.$('lexWord').value = 'Patel'; T.$('lexSay').value = 'Puh tell'; T.$('lexAddBtn').click(); return 1`);
      check(await ev(`return T.R().state.segs.some((s) => /Puh tell/.test(s.spoken)) && document.querySelector('#reader').textContent.includes('Patel')`), 'a pronunciation changes what is said, not what is shown');
      check(await ev(`return [...document.querySelectorAll('#lexList li')].some((li) => /Patel/.test(li.textContent))`), 'and is listed in Settings');
      await ev(`document.querySelector('#lexList li .icon-btn').click(); T.closeSheets(); return 1`);
      check(await ev(`return !T.R().state.settings.lexicon.length`), 'and can be removed');
      const us = await ev(`return T.R().state.segs[1].spoken`);
      await phone.click('#speedBtn');
      await phone.click('#accentGroup input[value="en-GB"] + span');
      await waitFor(`T.$('voiceSheet').open`, 10000, 'the UK voice question');
      const uk = await ev(`return { title: T.$('voiceSheetTitle').textContent, spoken: T.R().state.segs[1].spoken, options: [...T.$('kitVoiceSelect').options].map((o) => o.value) }`);
      check(uk.title === 'Download George?' && JSON.stringify(uk.options) === JSON.stringify(['bm_george', 'bf_emma']), 'British offers George and Emma', uk);
      check(uk.spoken !== us && /third of April/.test(uk.spoken) && /March fourth|March the fourth/.test(us), 'and reads dates the British way', { us, uk: uk.spoken });
      await ev(`document.querySelector('#voiceSheet [data-close]').click(); return 1`);
      await phone.click('#accentGroup input[value="en-US"] + span');
      // (Michael isn't downloaded either, so the question comes again, a moment later)
      await waitFor(`T.$('voiceSheet').open && T.$('voiceSheetTitle').textContent === 'Download Michael?'`, 10000, 'the US voice question');
      await ev(`T.closeSheets(); return 1`);
      check((await ev(`return T.R().state.segs[1].spoken`)) === us, 'back to American');
    }

    // The long text the voices read (Frankenstein, chapter 5, public domain; from readkit's lab).
    const passage = await ev(`return await (await fetch('readkit/lab/passage.txt')).text()`);
    const longId = await ev(`const id = T.newNote(${JSON.stringify(passage)}); T.done(); return id;`);

    /* ---------- device ---------- */
    if (want('device')) {
      console.log('Before any download: the device voice');
      check((await ev(`return T.R().chooseEngine().kind`)) === 'device', 'with nothing downloaded, the device voice reads');
      // (the taps above may have shown the one-time offer already)
      await ev(`T.R().state.settings.offeredVoice = false; T.R().au.offerShown = false; __toasts.length = 0; return 1`);
      check(!(await ev(`return !!document.querySelector('dialog[open]')`)), 'no sheet left open', await ev(`return [...document.querySelectorAll('dialog[open]')].map((d) => d.id)`));
      await phone.click('#playBtn');
      await waitFor(`T.R().tts.playing && T.R().tts.engine === 'device'`, 5000, 'device engine');
      check(true, 'play starts at once with the device voice');
      await waitFor(`__toasts.some((t) => /download Michael \\(326 MB, once\\)/.test(t))`, 8000, 'the offer');
      check(true, 'and Readout offers the natural voice once, with its size');
      await ev(`T.R().tts.playing && T.$('playBtn').click(); return 1`);
    }

    /* ---------- piper ---------- */
    const hiddenRun = async (label, id) => {
      await ev(`T.open(${JSON.stringify(longId)}); return 1`);
      await waitFor(`T.R().au.voice && T.R().au.voice.id === ${JSON.stringify(id)} && !T.R().au.loading`, 240000, 'the voice to load');
      const v = await ev(`const a = T.R().au.voice; return { id: a.id, device: a.device, threads: a.info.threads, coi: crossOriginIsolated }`);
      await phone.click('#playBtn');
      const t0 = Date.now();
      await waitFor(`T.R().au.player && T.R().au.player.state === 'playing'`, 60000, 'playing');
      const first = Date.now() - t0;
      await sleep(1500);
      await ev(WATCH);
      const since = await ev('return performance.now()');
      const ct0 = await ev('return T.R().au.el.currentTime');
      const show = await phone.hide();
      const vis = await ev(`await T.wait(() => document.visibilityState === 'hidden', 3000).catch(() => {}); return document.visibilityState`);
      await sleep(HIDDEN_S * 1000);
      const end = await ev(`const p = T.R().au.player; return { ct: T.R().au.el.currentTime, state: p.state, vis: document.visibilityState, idx: T.R().state.idx }`);
      await show();
      const r = await ev(`
        clearInterval(__watch.timer);
        const rows = __watch.rows.filter((x) => x[0] >= ${since});
        const speech = rows.filter((x) => x[3] === 'speech');
        let lagged = 0; let changeAt = 0; let prevHear = null;
        for (const x of speech) { if (x[2] !== prevHear) { changeAt = x[0]; prevHear = x[2]; } if (x[1] !== x[2] && x[0] - changeAt > 400) lagged++; }
        const idxs = []; for (const x of rows) if (!idxs.length || idxs[idxs.length - 1] !== x[1]) idxs.push(x[1]);
        const p = T.R().au.player;
        return { rows: rows.length, speech: speech.length, lagged, idxs, spanOk: rows.every((x) => x[4] === x[1]), maxGap: __probe.maxGap(${since}), freezes: __probe.events.filter((e) => e.e === 'freeze' && e.t >= ${since}).length, stats: p.stats, errors: T.R().au.broken };`);
      console.log(`   ${label}: ${v.device}${v.threads > 1 ? ', ' + v.threads + ' threads' : ''}; first audio ${first} ms after the tap; ${(end.ct - ct0).toFixed(1)} s heard while hidden; segments ${r.idxs[0]}..${r.idxs[r.idxs.length - 1]}; longest timer gap ${r.maxGap.toFixed(0)} ms; fillers ${r.stats.fillers}`);
      check(vis === 'hidden' && end.vis === 'hidden', `${label}: the page was hidden (screen off) for ${HIDDEN_S} s`);
      check(r.freezes === 0 && r.maxGap < 1000, `${label}: never frozen (longest 20 ms-timer gap ${r.maxGap.toFixed(0)} ms)`, { freezes: r.freezes, maxGap: r.maxGap });
      check(end.ct - ct0 >= 60 && end.state === 'playing', `${label}: kept playing with the screen off (${(end.ct - ct0).toFixed(1)} s of audio)`, end);
      check(r.idxs.length >= 6 && r.idxs.every((x, k) => k === 0 || x === r.idxs[k - 1] + 1), `${label}: the highlight moved sentence by sentence while hidden (${r.idxs.length})`, r.idxs);
      check(r.speech > 300 && r.lagged / r.speech < 0.05, `${label}: the highlighted sentence is the one heard (${r.lagged} of ${r.speech} samples behind)`, r);
      check(r.spanOk, `${label}: the page’s highlighted span follows`);
      check(!r.errors && r.stats.fillers === 0, `${label}: no errors, never ran dry`, r.stats);
      return { v, r };
    };

    if (want('piper')) {
      console.log('Standard voice (Piper en_US-ryan-medium)');
      if (!have.ryan || !have.ort) console.log('  (skipped: no local Ryan / onnxruntime copy; set READKIT_SCRATCH)');
      else {
        await ev(`T.open(${JSON.stringify(longId)}); return 1`);
        await phone.click('#speedBtn');
        await phone.click('#vmodeGroup input[value="standard"] + span');
        await waitFor(`T.$('voiceSheet').open`, 10000, 'the download question');
        const q = await ev(`return { title: T.$('voiceSheetTitle').textContent, size: T.$('voiceSheetSize').textContent, net: T.$('voiceSheetNet').textContent, space: T.$('voiceSheetSpace').textContent, yes: !T.$('voiceSheetYes').disabled }`);
        check(q.title === 'Download Ryan?' && q.size === '63 MB' && q.net && /GB|MB/.test(q.space) && q.yes, 'choosing Standard asks first, with the size, the connection and the free space', q);
        await phone.screenshot(path.join(shots, 'readout-v2-download.png'));
        await phone.click('#voiceSheetYes');
        await waitFor(`T.R().au.installed.has('en_US-ryan-medium')`, 180000, 'the download');
        check(true, 'the voice downloads');
        check(/Ryan is on this device/.test(await ev(`return T.$('voiceHint').textContent`)), 'and the sheet says it is ready', await ev(`return T.$('voiceHint').textContent`));
        await phone.click('#previewBtn');
        await waitFor(`T.R().au.preview && T.R().au.preview.state === 'playing'`, 60000, 'the preview');
        check(true, 'Preview plays a sample with the chosen voice');
        await ev(`T.closeSheets(); return 1`);
        check(await ev(`return !T.R().au.preview`), 'and stops when the sheet closes');
        const { v } = await hiddenRun('Standard', 'en_US-ryan-medium');
        check(v.id === 'en_US-ryan-medium' && v.device === 'wasm' && v.coi && v.threads > 1, `Piper on WASM with ${v.threads} threads`, v);

        console.log('Lock-screen controls (Media Session)');
        const ms = await ev(`const h = __ms.handlers; const md = navigator.mediaSession.metadata; return { actions: ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'].filter((a) => typeof h[a] === 'function'), title: md && md.title, artist: md && md.artist, positions: __ms.positions, last: __ms.last, doc: T.cur().title };`);
        check(ms.actions.length === 7, 'play, pause, previous/next sentence and seeking are on the lock screen', ms.actions);
        check(ms.title === ms.doc && ms.artist === 'Readout' && ms.positions > 0 && ms.last && ms.last.duration > 60, 'with the title and a seek bar', ms);
        const i0 = await ev('return T.R().state.idx');
        await ev(`__ms.handlers.nexttrack(); return 1`);
        await waitFor(`T.R().state.idx === ${i0 + 1}`, 5000, 'next sentence');
        await ev(`__ms.handlers.previoustrack(); return 1`);
        await waitFor(`T.R().state.idx === ${i0}`, 5000, 'previous sentence');
        check(true, 'next and previous sentence work from the lock screen');
        await ev(`__ms.handlers.pause(); return 1`);
        await waitFor(`!T.R().tts.playing && T.R().au.player.state === 'paused' && T.$('playBtn').getAttribute('aria-label') === 'Play'`, 5000, 'pause');
        await ev(`__ms.handlers.play(); return 1`);
        await waitFor(`T.R().tts.playing && T.R().au.player.state === 'playing'`, 15000, 'play');
        check(true, 'pause and play from the lock screen, and the app follows');
        await ev(`__ms.handlers.seekto({ seekTime: T.R().au.player.estimates.start(30) + 0.5 }); return 1`);
        await waitFor(`T.R().state.idx === 30`, 8000, 'seek to 30');
        check(true, 'the lock screen’s seek bar moves to the sentence at that time');

        console.log('Tap, scrub, speed');
        await ev(`document.querySelector('#reader .chunk[data-i="12"]').click(); return 1`);
        await waitFor(`T.R().state.idx === 12 && T.R().au.player.index === 12 && T.R().au.player.state === 'playing'`, 8000, 'tap');
        check(true, 'tapping a sentence plays from there');
        await ev(`const s = T.$('scrub'); s.value = '20'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); return 1`);
        await waitFor(`T.R().state.idx === 20 && T.R().au.player.index === 20`, 8000, 'scrub');
        check(true, 'scrubbing moves the voice too');
        await phone.click('#speedBtn');
        await ev(`document.querySelector('#rateChips [data-rate="1.5"]').click(); return 1`);
        const sp = await ev(`await new Promise((r) => setTimeout(r, 300)); const p = T.R().au.player; return { speed: p.speed, rate: T.R().au.el.playbackRate, label: T.$('speedLabel').textContent, max: T.$('rateSlider').max }`);
        check(sp.speed === 1.5 && sp.rate > 1.1 && sp.label === '1.5×' && sp.max === '3', 'speed changes at once (and goes up to 3× with this voice)', sp);
        await ev(`T.closeSheets(); return 1`);
        await sleep(4000); // regenerated at the new speed after a pause in changes

        console.log('Save audio');
        await ev(`T.$('moreBtn').click(); document.querySelector('[data-act="audio"]').click(); return 1`);
        await waitFor(`__downloads.length > 0`, 60000, 'the Ogg file');
        const dl = await ev(`const d = __downloads[__downloads.length - 1]; const b = new Uint8Array(await (await fetch(d.href)).arrayBuffer()); return { name: d.name, size: b.length, magic: String.fromCharCode(...b.subarray(0, 4)), toast: T.toast() };`);
        check(/\.ogg$/.test(dl.name) && dl.magic === 'OggS' && dl.size > 20000 && /Saved the audio/.test(dl.toast), `Save audio gives an Ogg file of what was read (${Math.round(dl.size / 1024)} KB)`, dl);

        console.log('Resume from the saved place');
        await ev(`T.$('playBtn').click(); return 1`);
        const place = await ev(`await new Promise((r) => setTimeout(r, 400)); const R = T.R(); return { idx: R.state.idx, pos: R.state.positions.get(R.state.current.id), start: R.state.segs[R.state.idx].start }`);
        check(place.pos && place.pos.offset === place.start, 'pausing saves the sentence', place);
        await phone.goto(url);
        await prep();
        await waitFor(`T.R().state.current && T.R().state.current.id === ${JSON.stringify(longId)} && T.R().state.idx === ${place.idx}`, 15000, 'reopened at the place');
        await waitFor(`T.R().au.voice && !T.R().au.loading`, 120000, 'the voice');
        await phone.click('#playBtn');
        await waitFor(`T.R().au.player && T.R().au.player.state === 'playing'`, 30000, 'playing again');
        check((await ev(`return T.R().au.player.index`)) === place.idx, 'after a reload, play goes on from the same sentence');

        console.log('When the voice fails: the device voice takes over');
        // (as when a phone's graphics driver or the voice's worker gives out)
        await ev(`T.R().au.voice.synth = () => Promise.reject(Object.assign(new Error('the voice worker crashed'), { code: 'worker-crashed' })); T.R().seekTo(Math.min(T.R().state.segs.length - 30, T.R().state.idx + 40)); return 1`);
        await waitFor(`T.R().tts.engine === 'device' && __toasts.some((t) => /stopped working, so Readout switched to the device voice/.test(t))`, 40000, 'the fallback');
        check(true, 'a voice that stops working hands over to the device voice, with a message');
        await ev(`T.R().tts.playing && T.$('playBtn').click(); T.R().au.broken = false; return 1`);

      }
    }

    /* ---------- sleep, next text ---------- */
    if (want('sleep') && have.ryan && have.ort) {
      console.log('Sleep timer with the screen off');
      await ev(`T.open(${JSON.stringify(longId)}); return 1`);
      await waitFor(`T.R().au.voice && !T.R().au.loading`, 120000, 'the voice');
      if (!(await ev('return T.R().tts.playing'))) await phone.click('#playBtn');
      await waitFor(`T.R().au.player && T.R().au.player.state === 'playing'`, 30000, 'playing');
      await phone.click('#speedBtn');
      await ev(`document.querySelector('#sleepChips [data-sleep="15"]').click(); return 1`);
      const st = await ev(`return { status: T.$('playerStatus').textContent, value: T.$('sleepValue').textContent }`);
      check(st.status === 'Stops in 15 min' && /15 min left/.test(st.value), 'set to 15 minutes, it shows the time left', st);
      await ev(`T.closeSheets(); T.R().sleep.until = Date.now() + 14000; return 1`); // the last 14 s of the 15 minutes
      await ev(WATCH);
      const show = await phone.hide();
      await sleep(24000);
      // (show the page before looking: once silent, a hidden page is frozen, as on Android)
      await show();
      const s1 = await ev(`const stop = __watch.rows.find((x) => !x[8]); return { playing: T.R().tts.playing, state: T.R().au.player.state, vis: stop ? stop[6] : null }`);
      const s2 = await ev(`clearInterval(__watch.timer); const rows = __watch.rows; const vols = rows.filter((x) => x[8]).map((x) => x[7]); return { min: Math.min(...vols), fading: vols.filter((v) => v < 0.99 && v > 0).length, volume: T.R().au.el.volume, toast: __toasts.includes('Sleep timer: stopped reading.'), status: T.$('playerStatus').textContent };`);
      check(s1.vis === 'hidden' && !s1.playing && s1.state === 'paused', 'it stops the voice while the screen is off', s1);
      check(s2.fading >= 20 && s2.volume === 1 && s2.toast && !s2.status, 'fading out over the last seconds, then back to full volume for next time', s2);

      console.log('Play next text automatically, and “End of text”');
      const ids = await ev(`const ids = []; for (const n of [3, 2, 1]) { ids.push(T.newNote('Short text number ' + n + '. It has a few sentences, so that it takes a little while to read. The lamp was lit at dusk. The boats came in one by one, and the harbour grew quiet. At last the keeper went to bed.')); T.done(); await new Promise((r) => setTimeout(r, 30)); } return ids;`);
      await ev(`T.$('settingsBtn').click(); return 1`);
      await phone.click('#autoNextToggle + .switch');
      await ev(`T.closeSheets(); return 1`);
      check(await ev('return T.R().state.settings.autoNext'), 'the setting turns on');
      await ev(`T.open(${JSON.stringify(ids[2])}); return 1`);
      await phone.click('#playBtn');
      await waitFor(`T.cur().id === ${JSON.stringify(ids[1])} && T.R().tts.playing`, 90000, 'the next text');
      check(true, 'at the end of a text, the next one in the list starts by itself');
      await phone.click('#speedBtn');
      await ev(`document.querySelector('#sleepChips [data-sleep="end"]').click(); T.closeSheets(); return 1`);
      await waitFor(`!T.R().tts.playing && __toasts.includes('Sleep timer: stopped at the end of the text.')`, 90000, 'end of text');
      check((await ev(`return T.cur().id`)) === ids[1], 'the sleep timer’s “End of text” stops there instead of going on');
      await ev(`T.$('settingsBtn').click(); return 1`);
      await phone.click('#autoNextToggle + .switch');
      await ev(`T.closeSheets(); return 1`);
    }

    /* ---------- kokoro ---------- */
    if (want('kokoro')) {
      console.log('Natural voice (Kokoro am_michael, WebGPU)');
      const gpu = await ev(`if (!navigator.gpu) return null; const a = await navigator.gpu.requestAdapter(); return a ? (a.info ? a.info.vendor + ' ' + a.info.architecture : 'adapter') : null;`);
      if (!have.michael || !have.ort) console.log('  (skipped: no local Kokoro model / am_michael copy; set READKIT_SCRATCH)');
      else if (!gpu) console.log('  (skipped: no WebGPU adapter in this headless Chrome)');
      else {
        await ev(`T.open(${JSON.stringify(longId)}); T.R().tts.playing && T.$('playBtn').click(); return 1`);
        await phone.click('#speedBtn');
        await ev(`document.querySelector('#rateChips [data-rate="1"]').click(); return 1`);
        await phone.click('#vmodeGroup input[value="natural"] + span');
        await waitFor(`T.$('voiceSheet').open`, 10000, 'the download question');
        const q = await ev(`return { title: T.$('voiceSheetTitle').textContent, size: T.$('voiceSheetSize').textContent }`);
        check(q.title === 'Download Michael?' && q.size === '326 MB', 'choosing Natural asks before the 326 MB download', q);
        await phone.click('#voiceSheetYes');
        await waitFor(`T.R().au.installed.has('am_michael')`, 300000, 'the download');
        await ev(`T.closeSheets(); return 1`);
        const { v } = await hiddenRun(`Natural (${gpu})`, 'am_michael');
        const cal = await ev(`return JSON.parse(localStorage.getItem('readout-natural-check'))`);
        check(v.id === 'am_michael' && v.device === 'webgpu' && cal && cal.ok, `Michael on WebGPU, checked on this device (${cal && cal.rt ? cal.rt.toFixed(1) + '× real time' : '?'})`, { v, cal });
        check(await ev(`await new Promise((r) => setTimeout(r, 1500)); return CSS.highlights.has('readout-word')`), 'the word being said is highlighted too (onWord)');
        if (await ev(`return T.R().au.installed.has('en_US-ryan-medium')`)) {
          // the natural voice giving out (a graphics driver, say): the standard one takes over
          await ev(`T.R().au.voice.synth = () => Promise.reject(Object.assign(new Error('GPU device lost'), { code: 'gpu-lost' })); T.R().seekTo(Math.min(T.R().state.segs.length - 30, T.R().state.idx + 40)); return 1`);
          await waitFor(`T.R().au.voice && T.R().au.voice.id === 'en_US-ryan-medium' && T.R().au.player && T.R().au.player.state === 'playing' && __toasts.some((t) => /Michael stopped working, so Readout switched to Ryan, the standard voice/.test(t))`, 90000, 'the switch to Standard');
          check(true, 'when the natural voice fails, the standard voice carries on (it also plays with the screen off)');
          await ev(`T.R().au.naturalBroken = false; return 1`);
        }
        await ev(`T.$('playBtn').click(); return 1`);
        if (await ev(`return T.R().au.installed.has('en_US-ryan-medium')`)) {
        console.log('Natural can’t run here: Standard is used, and the sheet says why');
        await ev(`localStorage.setItem('readout-natural-check', JSON.stringify({ chrome: (/Chrome\\/(\\d+)/.exec(navigator.userAgent) || [])[1], ok: false, reason: 'spectrum' })); return 1`);
        const nf = await ev(`const e = T.R().chooseEngine(); T.$('speedBtn').click(); await new Promise((r) => setTimeout(r, 300)); return { e, hint: T.$('voiceHint').textContent, retry: !T.$('voiceRetryBtn').hidden }`);
        check(nf.e.kind === 'audio' && nf.e.id === 'en_US-ryan-medium' && /doesn’t run well on this device/.test(nf.hint) && nf.retry, 'when Natural failed its check on this device, Standard reads instead', nf);
        await ev(`localStorage.removeItem('readout-natural-check'); T.closeSheets(); return 1`);
        }

      }
    }

    /* ---------- layout ---------- */
    if (want('layout')) {
      console.log('Phone layout');
      const overflow = (sel) => ev(`await new Promise((r) => setTimeout(r, 300)); const w = innerWidth; return [...document.querySelectorAll('${sel} *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > w + 0.5 || r.left < -0.5); }).map((e) => e.id || e.className || e.tagName).slice(0, 5);`);
      await ev(`T.closeSheets(); T.$('settingsBtn').click(); return 1`);
      check(!(await overflow('#settingsSheet')).length, 'Settings fit a 360 px phone screen', await overflow('#settingsSheet'));
      for (const at of ['#voiceList', '#lexList']) {
        await ev(`document.querySelector('${at}').scrollIntoView(); return 1`);
        await phone.screenshot(path.join(shots, `readout-v2-settings-${at.slice(1)}.png`));
      }
      await ev(`T.closeSheets(); T.$('speedBtn').click(); return 1`);
      check(!(await overflow('#speedSheet')).length, 'Speed and voice fits too', await overflow('#speedSheet'));
      await phone.screenshot(path.join(shots, 'readout-v2-speed.png'));
      await ev(`T.closeSheets(); T.$('moreBtn').click(); return 1`);
      check(!(await overflow('#moreSheet')).length, 'and the More menu', await overflow('#moreSheet'));
      await ev(`T.closeSheets(); T.$('moreBtn').click(); document.querySelector('[data-act="chapters"]').click(); return 1`);
      check(!(await overflow('#chaptersSheet')).length, 'and the headings list', await overflow('#chaptersSheet'));
      // the download question, with its longest wording
      await ev(`T.closeSheets(); T.$('voiceSheetTitle').textContent = 'Download Northern English Male?'; T.$('voiceSheetWhat').textContent = 'Michael is a natural-sounding American voice. It runs on this device (on its graphics chip), works offline, and keeps reading with the screen off.'; T.$('voiceSheetSize').textContent = '325.5 MB more (326 MB in all)'; T.$('voiceSheetNet').textContent = 'Not known (check that you’re on Wi-Fi)'; T.$('voiceSheetSpace').textContent = '123.4 GB'; T.$('voiceSheetNote').textContent = 'It downloads once and stays on this device. Voice licence: CC-BY-NC-SA-4.0 (RyanSpeech dataset).'; T.$('voiceSheet').showModal(); return 1`);
      check(!(await overflow('#voiceSheet')).length, 'and the voice download question', await overflow('#voiceSheet'));
      await phone.screenshot(path.join(shots, 'readout-v2-download.png'));
      const longName = 'IMG_20261017_142233_scanned_course_reading_week_3_chapter_two.pdf';
      await ev(`T.closeSheets(); T.$('ocrSize').textContent = '7 MB'; T.$('ocrWhat').textContent = '“${longName}” is scanned pages'; T.$('ocrSheet').showModal(); return 1`);
      check(!(await overflow('#ocrSheet')).length, 'and the scanned pages question, with a long file name', await overflow('#ocrSheet'));
      await ev(`T.closeSheets(); T.$('toastMsg').textContent = 'Opening “${longName}”…'; T.$('toastAction').textContent = 'Stop'; T.$('toastAction').hidden = false; T.$('toast').hidden = false; return 1`);
      check(!(await overflow('#toast')).length, 'and a message about it', await overflow('#toast'));
      await ev(`T.$('toast').hidden = true; return 1`);
    }

    console.log('Console');
    const bad = phone.logs.filter((l) => l.type === 'exception' || l.type === 'error');
    check(!bad.length, 'no errors on the phone', bad);

    /* ---------- nokit ---------- */
    if (want('nokit')) {
      console.log('When readkit can’t load (blocked), the rest of Readout still works');
      const nk = await newDevice(cdp, 'no-readkit phone', { phone: true, touch: false, init: PROBE });
      devices.push(nk);
      await nk.send('Network.enable');
      await nk.send('Network.setBlockedURLs', { urls: ['*/readkit/index.js*'] });
      await nk.goto(app.base + '/');
      const st = await nk.eval(`await T.wait(() => T.R().state.current, 10000); const R = T.R(); return { failed: !!R.kit.failed, toasts: __toasts.slice(), segs: R.state.segs.length, spans: document.querySelectorAll('#reader .chunk').length, docs: R.state.docs.length }`);
      check(st.failed && st.toasts.some((t) => /Part of Readout didn’t load/.test(t)), 'it starts anyway and says what is missing', st);
      check(st.docs === 1 && st.segs > 0 && st.spans === st.segs, 'the library and the reader work (line by line)', st);
      const note = await nk.eval(`const id = T.newNote('First line of a note. It has two sentences.\\nA second line.'); T.done(); const R = T.R(); return { segs: R.state.segs.map((s) => s.spoken), id }`);
      check(note.segs.length === 2, 'a new note is read line by line', note.segs);
      await nk.click('#playBtn');
      check(await nk.eval(`await T.wait(() => T.R().tts.playing && T.R().tts.engine === 'device', 5000).then(() => true, () => false); const ok = T.R().tts.playing; T.$('playBtn').click(); return ok`), 'and the device voice reads it');
      await nk.eval(`const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' })); T.$('fileInput').files = dt.files; T.$('fileInput').dispatchEvent(new Event('change')); return 1`);
      check(await nk.eval(`await new Promise((r) => setTimeout(r, 200)); return __toasts.some((t) => /Opening files didn’t load/.test(t))`), 'opening a file says it can’t, instead of failing silently');
      const nbad = nk.logs.filter((l) => (l.type === 'exception' || l.type === 'error') && !/readkit failed to load/.test(l.text));
      check(!nbad.length, 'no other errors', nbad);
      await cdp.send('Target.closeTarget', { targetId: nk.targetId });
    }

    /* ---------- old ---------- */
    if (want('old')) {
      console.log('What 1.x did still works: dictation, search, themes, install, backup');
      // A stand-in speech recognizer: one phrase, heard in two parts (interim, then final).
      const FAKE_SR = `
        window.__sr = { started: 0 };
        class FakeSR {
          start() {
            __sr.started++;
            const r = (t, f) => Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal: f });
            setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [r('hello there comma this is', false)] }), 100);
            setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [r('hello there comma this is a note period', true)] }), 250);
          }
          stop() { setTimeout(() => this.onend && this.onend(), 10); }
          abort() { setTimeout(() => this.onend && this.onend(), 10); }
        }
        window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;`;
      const od = await newDevice(cdp, 'old features phone', { phone: true, touch: false, init: PROBE + FAKE_SR });
      devices.push(od);
      await od.goto(app.base + '/');
      await od.eval(`T.newNote(''); return 1`);
      await od.click('#dictateBtn');
      const heard = await od.eval(`await T.wait(() => /note\\./.test(T.$('editor').value), 5000).catch(() => {}); return { text: T.$('editor').value, on: T.R().dict.on, shown: !T.$('dictation').hidden }`);
      check(/^Hello there, this is a note\.$/.test(heard.text.trim()) && heard.on && heard.shown, 'dictation writes what is said, with spoken punctuation', heard);
      await od.click('#dictStopBtn');
      const after = await od.eval(`await new Promise((r) => setTimeout(r, 300)); T.done(); await new Promise((r) => setTimeout(r, 300)); return { on: T.R().dict.on, text: T.R().state.current.text, mode: T.R().state.mode, segs: T.R().state.segs.length }`);
      check(!after.on && after.text.trim() === heard.text.trim() && after.mode === 'listen' && after.segs === 1, 'stopping keeps the note once, ready to listen to', after);
      const found = await od.eval(`T.$('search').value = 'there, this'; T.$('search').dispatchEvent(new Event('input')); const n = document.querySelectorAll('#docList .doc-item').length; T.$('search').value = ''; T.$('search').dispatchEvent(new Event('input')); return { n, all: document.querySelectorAll('#docList .doc-item').length }`);
      check(found.n === 1 && found.all === 2, 'the library search finds a text by its words', found);
      const theme = await od.eval(`const pick = (g, v) => { const i = document.querySelector('#' + g + ' input[value="' + v + '"]'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }; pick('themeGroup', 'light'); const bg0 = getComputedStyle(document.body).backgroundColor; const fs0 = getComputedStyle(T.$('reader')).fontSize; pick('themeGroup', 'dark'); pick('sizeGroup', 'xl'); await new Promise((r) => setTimeout(r, 100)); const r = { theme: document.documentElement.dataset.theme, bg: [bg0, getComputedStyle(document.body).backgroundColor], fs: [fs0, getComputedStyle(T.$('reader')).fontSize], meta: T.$('themeColor').content }; pick('themeGroup', 'system'); pick('sizeGroup', 'm'); return r`);
      check(theme.theme === 'dark' && theme.bg[0] !== theme.bg[1] && theme.fs[0] !== theme.fs[1] && theme.meta === '#131a2b', 'dark theme and text size apply', theme);
      const inst = await od.eval(`window.__prompted = 0; const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { __prompted++; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); const shown = !T.$('installBtn').hidden; T.$('installBtn').click(); await new Promise((r) => setTimeout(r, 100)); return { shown, prompted: __prompted, hidden: T.$('installBtn').hidden }`);
      check(inst.shown && inst.prompted === 1 && inst.hidden, 'Install app appears when Chrome offers it, and asks', inst);
      const bk = await od.eval(`__downloads.length = 0; T.$('settingsBtn').click(); T.$('exportAllBtn').click(); T.closeSheets(); const d = __downloads[0]; const data = d && JSON.parse(await (await fetch(d.href)).text()); return { name: d && d.name, app: data && data.app, docs: data && data.docs.length, hasNote: !!data && data.docs.some((x) => /this is a note/.test(x.text)) }`);
      check(/^readout-backup-\d{4}-\d\d-\d\d\.json$/.test(bk.name || '') && bk.app === 'readout' && bk.docs === 2 && bk.hasNote, 'Export all texts saves a backup file', bk);
      const obad = od.logs.filter((l) => l.type === 'exception' || l.type === 'error');
      check(!obad.length, 'no errors', obad);
      await cdp.send('Target.closeTarget', { targetId: od.targetId });
    }

    /* ---------- sw ---------- */
    if (want('sw')) await swSection(cdp, devices, models);
  } finally {
    cdp.close();
    await chrome.close();
    await app.close();
    await models.close();
  }
}

async function swSection(cdp, devices, models) {
  console.log('Service worker on a host without headers (like GitHub Pages)');
  const host = await appServer({ isolate: false });
  const gh = fakeGitHub();
  await new Promise((r) => gh.server.listen(0, '127.0.0.1', r));
  gh.base = `http://127.0.0.1:${gh.server.address().port}`;
  const TOKEN = 'github_pat_' + 'COEP0readout0v2xx'.repeat(5);
  gh.tokens.set(TOKEN, 'thebestproever');
  // jsDelivr for pdf.js, Tesseract, onnxruntime and espeak; only the voice model is local
  const dev = await newDevice(cdp, 'pages phone', { phone: true, touch: false, config: { swOnLocalhost: true, githubApi: gh.base, netWait: 8000, readkit: { piper: models.base + '/piper/' } }, init: PROBE });
  devices.push(dev);
  const ev = (expr) => dev.eval(expr);
  const waitFor = (expr, ms, what) => ev(`await T.wait(() => (${expr}), ${ms || 15000}, ${JSON.stringify(what || expr)}); return true;`).catch(async (e) => { throw new Error(e.message + ' -- state: ' + JSON.stringify(await ev(SNAPSHOT).catch(() => null))); });
  // After a navigation the page may reload itself (the first visit, to be controlled by the
  // service worker): wait for the page that stays, and give it the test helpers.
  const settle = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const st = await ev(`return { ready: !!window.__readout && document.readyState === 'complete', T: !!window.T, iso: crossOriginIsolated, ctl: !!(navigator.serviceWorker && navigator.serviceWorker.controller) }`);
        if (st.ready && !st.T) await ev(PAGE_HELPERS + '\nT.cur = () => T.R().state.current; true;');
        if (st.ready && st.iso && st.ctl) {
          await sleep(400);
          if (await ev('return !!window.T && !!window.__readout')) return true;
        }
      } catch (e) {
        /* the page is reloading */
      }
      await sleep(250);
    }
    return false;
  };
  try {
    await dev.goto(host.base + '/');
    const ok = await settle(30000);
    check(ok, 'the first visit reloads once and is then cross-origin isolated');
    const h = await ev(`const a = await fetch('readkit/index.js'); const b = await fetch('./'); return { kit: [a.headers.get('cross-origin-opener-policy'), a.headers.get('cross-origin-embedder-policy')], page: [b.headers.get('cross-origin-opener-policy'), b.headers.get('cross-origin-embedder-policy')], reload: sessionStorage.getItem('readout-coi-reload') }`);
    check(h.kit.join() === 'same-origin,credentialless' && h.page.join() === 'same-origin,credentialless', 'the service worker adds COOP same-origin and COEP credentialless', h);
    await waitFor(`(async () => { const ks = await caches.keys(); const k = ks.find((x) => x.startsWith('readout-kit-')); return k && (await (await caches.open(k)).keys()).length >= 109; })()`, 90000, 'readkit cached');
    check(true, 'readkit’s runtime files are kept for offline use');

    const online = await ev(`try { await fetch('https://fonts.googleapis.com/css2?family=Literata', { mode: 'no-cors' }); return true; } catch (e) { return false; }`);
    if (!online) console.log('  (no internet: the jsDelivr and Google Fonts checks are skipped)');
    else {
      const fonts = await ev(`await document.fonts.ready; await new Promise((r) => setTimeout(r, 500)); return { literata: document.fonts.check('16px Literata'), sans: document.fonts.check('16px "Instrument Sans"'), status: [...document.fonts].filter((f) => /Literata|Instrument/.test(f.family)).map((f) => f.status).slice(0, 4) }`);
      check(fonts.literata && fonts.sans, 'Google Fonts load under COEP credentialless', fonts);

      console.log('jsDelivr under COEP: pdf.js, Tesseract, onnxruntime + espeak');
      const pdf = await ev(`
        const { makePdf } = await import('/tests/fixtures/mkpdf.mjs');
        const lines = ['A PDF from the cloud of jsDelivr.', 'Its text layer is read by pdf.js.'];
        const content = lines.map((l, i) => 'BT /F1 12 Tf 72 ' + (700 - i * 18) + ' Td (' + l + ') Tj ET').join('\\n');
        const bytes = makePdf({ pages: [{ w: 612, h: 792, content }] });
        const dt = new DataTransfer(); dt.items.add(new File([bytes], 'Cloud test.pdf', { type: 'application/pdf' })); T.$('fileInput').files = dt.files; T.$('fileInput').dispatchEvent(new Event('change'));
        await T.wait(() => T.R().state.docs.some((d) => d.title === 'Cloud test'), 90000, 'the PDF');
        return T.R().state.docs.find((d) => d.title === 'Cloud test').text;`);
      check(/text layer is read by pdf\.js/.test(pdf), 'pdf.js from jsDelivr reads a PDF', pdf);
      await ev(`
        const c = document.createElement('canvas'); c.width = 1400; c.height = 700; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1400, 700); x.fillStyle = '#111'; x.font = '44px Georgia, serif';
        ['The harbour lights came on at dusk.', 'Boats rocked gently at the quay.', 'A gull called twice and was gone.'].forEach((l, i) => x.fillText(l, 80, 150 + i * 90));
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'Harbour photo.png', { type: 'image/png' })); T.$('fileInput').files = dt.files; T.$('fileInput').dispatchEvent(new Event('change'));
        await T.wait(() => T.$('ocrSheet').open, 60000, 'the OCR question'); T.$('ocrYesBtn').click(); return 1`);
      const ocr = await ev(`await T.wait(() => T.R().state.docs.some((d) => d.title === 'Harbour photo'), 180000, 'the photo'); return T.R().state.docs.find((d) => d.title === 'Harbour photo').text`);
      check(/harbour lights/i.test(ocr) && /gull/i.test(ocr), 'Tesseract from jsDelivr reads a photo', ocr);
      if (have.ryan) {
        await ev(`T.open(T.R().state.docs.find((d) => d.title === 'Harbour photo').id); T.R().state.settings.voiceMode = 'standard'; return 1`);
        await ev(`T.$('speedBtn').click(); return 1`);
        await dev.click('#voiceGetBtn');
        await waitFor(`T.$('voiceSheet').open`, 10000, 'the question');
        await dev.click('#voiceSheetYes');
        await waitFor(`T.R().au.installed.has('en_US-ryan-medium')`, 180000, 'the download');
        await ev(`T.closeSheets(); return 1`);
        await waitFor(`T.R().au.voice && !T.R().au.loading`, 180000, 'the voice (onnxruntime and espeak from jsDelivr)');
        await dev.click('#playBtn');
        await waitFor(`T.R().au.player && T.R().au.player.state === 'playing'`, 60000, 'playing');
        const v = await ev(`const a = T.R().au.voice; return { threads: a.info.threads, coi: a.info.crossOriginIsolated, phonemizer: a.info.phonemizer }`);
        check(v.coi && v.threads > 1, `onnxruntime from jsDelivr runs Piper with ${v.threads} threads on the service-worker-isolated page`, v);
        await ev(`T.$('playBtn').click(); return 1`);
      }
    }

    console.log('Gist sync under COEP');
    await ev(`await T.connect(${JSON.stringify(TOKEN)}); return 1`);
    if (await ev(`return !T.$('syncConfirm').hidden`)) await ev(`T.$('syncCreateBtn').click(); await T.wait(() => T.R().sync.cfg); await T.idle(); return 1`);
    const sy = await ev(`return { cfg: !!T.R().sync.cfg, error: T.R().sync.error, status: T.$('syncStatus').textContent }`);
    const gist = [...gh.gists.values()][0];
    check(sy.cfg && !sy.error && /Synced with GitHub/.test(sy.status) && gist && gist.files.size > 1, 'sync with the GitHub gist API works on the isolated page', sy);
    await ev(`T.closeSheets(); return 1`);

    console.log('Android share sheet (POST to the service worker)');
    const n0 = await ev('return T.R().state.docs.length');
    await ev(`
      const f = document.createElement('form'); f.method = 'post'; f.enctype = 'multipart/form-data'; f.action = 'share-target';
      const t = document.createElement('input'); t.name = 'title'; t.value = 'Shared from another app'; f.append(t);
      const inp = document.createElement('input'); inp.type = 'file'; inp.name = 'files'; inp.multiple = true;
      const dt = new DataTransfer();
      dt.items.add(new File(['Shared words arrive here. Readout reads them aloud.'], 'Shared note.txt', { type: 'text/plain' }));
      dt.items.add(new File(['# Shared list\\n\\n- bread\\n- tea\\n'], 'Shared list.md', { type: 'text/markdown' }));
      inp.files = dt.files; f.append(inp); document.body.append(f); setTimeout(() => f.submit(), 50); return 1`);
    await sleep(1500);
    await settle(20000);
    await waitFor(`T.R().state.docs.length >= ${n0 + 2}`, 30000, 'the shared files');
    const sh = await ev(`return { titles: T.R().state.docs.map((d) => d.title), cur: T.cur() && T.cur().title, url: location.search, toast: __toasts.slice(-3), note: (T.R().state.docs.find((d) => d.title === 'Shared note') || {}).text }`);
    check(sh.titles.includes('Shared note') && sh.titles.includes('Shared list') && /Shared words arrive here/.test(sh.note || ''), 'shared files are opened as texts', sh);
    check(sh.url === '' && sh.toast.some((t) => /Added 2 files/.test(t)), 'from ./?shared=1, which is then cleared', sh);
    await ev(`
      const f = document.createElement('form'); f.method = 'post'; f.enctype = 'multipart/form-data'; f.action = 'share-target';
      for (const [k, v] of [['title', 'A quote'], ['text', 'Shared text without a file comes through too.']]) { const i = document.createElement('input'); i.name = k; i.value = v; f.append(i); }
      document.body.append(f); setTimeout(() => f.submit(), 50); return 1`);
    await sleep(1500);
    await settle(20000);
    await waitFor(`T.R().state.docs.some((d) => d.text === 'Shared text without a file comes through too.')`, 20000, 'the shared text');
    check((await ev(`return T.cur().title`)) === 'A quote', 'shared text (no file) opens as a text with its title');
    await dev.goto(host.base + '/?title=Old%20way&text=Shared%20the%201.x%20way.');
    await settle(20000);
    await waitFor(`T.R().state.docs.some((d) => d.text === 'Shared the 1.x way.')`, 20000, 'GET share');
    check(true, 'the old GET ?text= share still works');

    // a file of the app opened as a page (an iframe navigation) is not kept as the offline app
    const kept = await ev(`const f = document.createElement('iframe'); f.src = 'manifest.webmanifest'; document.body.append(f); await new Promise((r) => { f.onload = r; setTimeout(r, 5000); }); f.remove(); await new Promise((r) => setTimeout(r, 300)); const k = (await caches.keys()).find((x) => x.startsWith('readout-shell-')); const r = k && (await (await caches.open(k)).match('./')); return r ? r.headers.get('Content-Type') : null`);
    check(/text\/html/.test(kept || ''), 'the offline copy of the app page stays the app page', kept);

    console.log('Offline');
    await host.close();
    await dev.goto(host.base + '/');
    const off = await settle(20000);
    const o = off ? await ev(`await T.wait(() => T.R().state.current, 10000); return { spans: document.querySelectorAll('#reader .chunk').length, kit: !!T.R().kit.K, segs: T.R().state.segs.length }`) : null;
    check(off && o && o.kit && o.spans > 0 && o.spans === o.segs, 'with the server gone, Readout still opens, with readkit, from the cache', o);
    const md = await ev(`const dt = new DataTransfer(); dt.items.add(new File(['# Offline\\n\\nWritten on the train.'], 'Train notes.md', { type: 'text/markdown' })); T.$('fileInput').files = dt.files; T.$('fileInput').dispatchEvent(new Event('change')); await T.wait(() => T.R().state.docs.some((d) => d.title === 'Train notes'), 15000); return T.R().state.docs.find((d) => d.title === 'Train notes').text`);
    check(/Written on the train/.test(md), 'and opens files offline', md);
    const bad = dev.logs.filter((l) => (l.type === 'exception' || l.type === 'error') && !/Failed to fetch|ERR_CONNECTION_REFUSED|net::/.test(l.text));
    check(!bad.length, 'no errors on the isolated page', bad);
  } finally {
    gh.server.close();
    await host.close().catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error(e);
    c.check(false, 'the test ran to the end: ' + (e && e.message));
  })
  .then(() => {
    console.log(`\n${c.checks - c.failures}/${c.checks} Readout 2.0 checks passed`);
    if (c.failures) process.exitCode = 1;
  });
