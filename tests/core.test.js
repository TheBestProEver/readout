// Core helpers and the text pipeline Readout builds on (readkit's plan()): node tests/core.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../core.js');

let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
const shown = (text, segs) => segs.map((s) => text.slice(s.start, s.end));

/* ---------- the speech plan (readkit plan(), as Readout calls it) ---------- */

test('sentences come out with their place in the text', (K) => {
  const t = 'Hello there. How are you? I am fine!';
  assert.deepStrictEqual(shown(t, K.plan(t)), ['Hello there.', 'How are you?', 'I am fine!']);
});

test('segments are ordered, never overlap, and map back to the text', (K) => {
  const t = 'First line here.\n\nSecond paragraph, with a comma. And more.\n- a list item\n- another one';
  const segs = K.plan(t);
  let last = 0;
  for (const s of segs) {
    assert.ok(s.start >= last && s.end > s.start, 'ordered');
    last = s.end;
    for (const a of s.align) assert.ok(a[2] >= s.start && a[3] <= s.end && a[1] <= s.spoken.length, 'align inside the segment');
  }
  assert.deepStrictEqual(shown(t, segs), ['First line here.', 'Second paragraph, with a comma.', 'And more.', 'a list item', 'another one']);
  assert.deepStrictEqual(segs.map((s) => s.kind), ['sentence', 'sentence', 'sentence', 'item', 'item']);
});

test('a hard-wrapped sentence is one segment, spoken without the line break', (K) => {
  const t = 'This sentence was wrapped by an email client because it is fairly\nlong and keeps going onto a second line.';
  const segs = K.plan(t);
  assert.strictEqual(segs.length, 1);
  assert.ok(shown(t, segs)[0].includes('\n') && !segs[0].spoken.includes('\n'));
});

test('abbreviations do not split and are spoken in full', (K) => {
  const t = 'I met Dr. Smith at 5 p.m. yesterday. Then we left.';
  const segs = K.plan(t);
  assert.deepStrictEqual(shown(t, segs), ['I met Dr. Smith at 5 p.m. yesterday.', 'Then we left.']);
  assert.strictEqual(segs[0].spoken, 'I met Doctor Smith at five P M yesterday.');
});

test('markup, rules and links are not read out symbol by symbol', (K) => {
  const segs = K.plan('## Title with **bold** and a link https://example.com/a?b=c here\n\n* * *\n\n> quoted line');
  const spoken = segs.map((s) => s.spoken).join(' ');
  assert.ok(!/[#*>]|https/.test(spoken), spoken);
  assert.ok(/example dot com/.test(spoken), spoken);
  assert.strictEqual(segs[0].kind, 'heading');
});

test('citations are skipped by default, and read when asked', (K) => {
  const t = 'As shown before (Lee et al., 2020), the effect holds [3].';
  assert.strictEqual(K.plan(t)[0].spoken, 'As shown before, the effect holds.');
  assert.ok(/Lee and others/.test(K.plan(t, { skip: { citations: false } })[0].spoken));
});

test('a long sentence is split into readable pieces that cover every word', (K) => {
  const t = 'word '.repeat(200).trim() + '.';
  const segs = K.plan(t);
  assert.ok(segs.length > 2);
  for (const s of segs) assert.ok(s.spoken.length <= 320, 'piece too long: ' + s.spoken.length);
  assert.strictEqual(C.wordCount(segs.map((s) => s.spoken).join(' ')), 200);
});

test('the pronunciation list changes what is said, not what is shown', (K) => {
  const t = 'Readout reads it. So does readout.';
  const segs = K.plan(t, { lexicon: C.lexiconMap([['readout', 'read out']]) });
  assert.deepStrictEqual(shown(t, segs), ['Readout reads it.', 'So does readout.']);
  assert.ok(/^read out reads it/i.test(segs[0].spoken) && /read out\.$/.test(segs[1].spoken), segs.map((s) => s.spoken));
});

test('symbol-only lines are skipped and empty text has no segments', (K) => {
  const t = 'Before.\n* * *\n---\nAfter.';
  assert.deepStrictEqual(shown(t, K.plan(t)), ['Before.', 'After.']);
  assert.deepStrictEqual(K.plan(''), []);
  assert.deepStrictEqual(K.plan('   \n\n  '), []);
});

test('headings list for jumping within a text', (K) => {
  const t = '# Part One\n\nText here.\n\n## Chapter 2\n\nMore text.\n\nCHAPTER III\n\nEnd.';
  const segs = K.plan(t);
  const h = C.headingsOf(segs, t);
  assert.deepStrictEqual(h.map((x) => [x.title, x.level]), [['Part One', 1], ['Chapter 2', 2], ['CHAPTER III', 1]]);
  assert.strictEqual(shown(t, [segs[h[1].index]])[0], 'Chapter 2');
});

test('docToText leaves out running heads, footnotes and margin notes', (K) => {
  const doc = {
    blocks: [
      { type: 'p', text: 'THE BOOK 12', skip: 'header' },
      { type: 'note', text: 'A side note.', skip: 'margin' },
      { type: 'p', text: 'Body text.' },
      { type: 'note', text: '1 A footnote.', skip: 'footnote' },
    ],
  };
  assert.strictEqual(K.docToText(doc), 'Body text.');
  assert.strictEqual(K.docToText(doc, { keepSkipped: true }), 'THE BOOK 12\n\nA side note.\n\nBody text.\n\n1 A footnote.');
});

/* ---------- segment helpers ---------- */

test('prefixLengths and findSegment', (K) => {
  const t = 'One. Two two. Three three three.';
  const segs = K.plan(t);
  const cum = C.prefixLengths(segs);
  assert.strictEqual(cum.length, segs.length + 1);
  assert.strictEqual(cum[segs.length], segs.reduce((n, s) => n + s.end - s.start, 0));
  assert.strictEqual(C.findSegment(segs, 0), 0);
  assert.strictEqual(C.findSegment(segs, segs[1].start), 1);
  assert.strictEqual(C.findSegment(segs, segs[1].start + 2), 1);
  assert.strictEqual(C.findSegment(segs, segs[2].end + 50), 2);
  assert.strictEqual(C.findSegment([], 10), 0);
});

test('word positions: resume mid-sentence and highlight the word being said', (K) => {
  const t = 'Intro. The fee was $5 today.';
  const seg = K.plan(t)[1];
  assert.strictEqual(seg.spoken, 'The fee was five dollars today.');
  const within = t.indexOf('$5') - seg.start;
  const from = C.spokenStartFor(seg, within);
  assert.strictEqual(seg.spoken.slice(from), 'five dollars today.');
  const k = C.alignAtSpoken(seg, seg.spoken.indexOf('dollars'));
  const [a, n] = C.wordRange(seg, k);
  assert.strictEqual(t.slice(seg.start + a, seg.start + a + n), '$5');
  assert.strictEqual(C.spokenStartFor(seg, 0), 0);
  assert.strictEqual(C.alignAtSpoken(seg, 999), -1);
});

test('cleanLexicon and lexiconMap', () => {
  const l = C.cleanLexicon([['  Readout ', ' read out '], ['', 'x'], ['gif', ''], ['--', 'dash'], ['readout', 'reed out'], ['Kokoro', 'koh koh roh']]);
  assert.deepStrictEqual(l, [['Kokoro', 'koh koh roh'], ['readout', 'reed out']]);
  assert.deepStrictEqual(C.lexiconMap({ Ada: 'Ay da' }), { Ada: 'Ay da' });
  assert.deepStrictEqual(C.cleanLexicon(null), []);
});

test('nextInOrder skips finished texts', () => {
  const order = ['a', 'b', 'c', 'd'];
  const done = new Set(['b']);
  assert.strictEqual(C.nextInOrder(order, 'a', (id) => done.has(id)), 'c');
  assert.strictEqual(C.nextInOrder(order, 'd'), null);
  assert.strictEqual(C.nextInOrder(order, 'x'), null);
});

test('fadeGain', () => {
  assert.strictEqual(C.fadeGain(20000, 10000), 1);
  assert.strictEqual(C.fadeGain(5000, 10000), 0.5);
  assert.strictEqual(C.fadeGain(-1, 10000), 0);
});

/* ---------- text helpers kept from 1.x ---------- */

test('reflow joins wrapped lines and keeps paragraphs', () => {
  const t = 'The Muqaddimah describes how dynasties rise and how, over\ngenerations, they lose the solidarity that built them. It is a\nsweeping argument.\n\nA new paragraph starts here and it continues for a while\nonto another line.';
  const r = C.reflow(t);
  assert.ok(!/over\ngenerations/.test(r));
  assert.ok(r.includes('\n\n'));
  assert.strictEqual(r.split('\n\n').length, 2);
  assert.strictEqual(C.reflow('infor-\nmation is key'), 'information is key');
});

test('deriveTitle', () => {
  assert.strictEqual(C.deriveTitle('\n\n# My heading\nbody'), 'My heading');
  assert.strictEqual(C.deriveTitle(''), 'Untitled');
  const long = C.deriveTitle('This is a really long first line that should get cut off somewhere sensible for the title');
  assert.ok(long.length <= 61 && long.endsWith('…'));
});

test('wordCount', () => {
  assert.strictEqual(C.wordCount("It's a well-known fact, isn't it?"), 6);
  assert.strictEqual(C.wordCount(''), 0);
});

test('spoken punctuation', () => {
  assert.strictEqual(C.applySpokenPunctuation('hello comma world period'), 'hello, world.');
  assert.strictEqual(C.applySpokenPunctuation('first new paragraph second'), 'first\n\nsecond');
  assert.strictEqual(C.applySpokenPunctuation('is it question mark'), 'is it?');
  assert.strictEqual(C.applySpokenPunctuation('list colon apples semicolon pears'), 'list: apples; pears');
});

test('formatInsert spacing and capitals', () => {
  assert.strictEqual(C.formatInsert('', 'hello there', ''), 'Hello there');
  assert.strictEqual(C.formatInsert('Hi.', 'next one', ''), ' Next one');
  assert.strictEqual(C.formatInsert('I said', 'more words', ''), ' more words');
  assert.strictEqual(C.formatInsert('Line\n', 'new start', ''), 'New start');
  assert.strictEqual(C.formatInsert('word', ', then', ''), ', then');
  assert.strictEqual(C.formatInsert('a', 'b. c', 'd'), ' b. C ');
  assert.strictEqual(C.formatInsert('x', '   ', ''), '');
});

test('mergeDocs', () => {
  const a = [{ id: '1', text: 'old', updatedAt: 1 }, { id: '2', text: 'keep', updatedAt: 9 }];
  const b = [{ id: '1', text: 'new', updatedAt: 5 }, { id: '2', text: 'older', updatedAt: 3 }, { id: '3', text: 'added', updatedAt: 2 }, { bogus: true }];
  const r = C.mergeDocs(a, b);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.updated, 1);
  const byId = Object.fromEntries(r.docs.map((d) => [d.id, d.text]));
  assert.deepStrictEqual(byId, { 1: 'new', 2: 'keep', 3: 'added' });
});

test('formatDuration and relativeTime', () => {
  assert.strictEqual(C.formatDuration(30), 'under 1 min');
  assert.strictEqual(C.formatDuration(600), '10 min');
  assert.strictEqual(C.formatDuration(3900), '1 h 5 min');
  const now = Date.now();
  assert.strictEqual(C.relativeTime(now - 1000, now), 'just now');
  assert.strictEqual(C.relativeTime(now - 5 * 60000, now), '5 min ago');
  assert.strictEqual(C.relativeTime(now - 26 * 3600000, now), 'yesterday');
});

/* ---------- the service worker's list of readkit files ---------- */

const ROOT = path.join(__dirname, '..');
const kitTool = () => import(require('url').pathToFileURL(path.join(ROOT, 'tools', 'readkit-files.mjs')).href);
const swText = () => fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const kitVersionIn = (text) => (/const KIT_VERSION = '([^']*)';/.exec(text) || [])[1];

test('sw.js caches every readkit runtime file, with its fingerprint (tools/readkit-files.mjs keeps the list)', async () => {
  const m = /\/\/ readkit files: begin\r?\n([\s\S]*?)\r?\n\s*\/\/ readkit files: end/.exec(swText());
  assert.ok(m, 'the list markers are in sw.js');
  const listed = JSON.parse('[' + m[1].replace(/,\s*$/, '') + ']');
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name]));
  const actual = [...fs.readdirSync(path.join(ROOT, 'readkit')).filter((n) => /\.js$/.test(n)).map((n) => 'readkit/' + n), ...walk('readkit/src'), ...walk('readkit/data').filter((f) => !/\.md$/.test(f))].sort();
  assert.deepStrictEqual(listed.map((e) => e[0]).sort(), actual);
  // readkit's supported entry points (Readout imports these, not src/ files)
  for (const f of ['readkit/index.js', 'readkit/voice.js', 'readkit/player.js']) assert.ok(actual.includes(f), f);
  const { fingerprint, kitManifest } = await kitTool();
  for (const [f, h] of listed) assert.strictEqual(h, fingerprint(fs.readFileSync(path.join(ROOT, f))), 'fingerprint of ' + f);
  assert.strictEqual(kitVersionIn(swText()), kitManifest().kitVersion, 'KIT_VERSION in sw.js');
});

test('app.js is made for the readkit sw.js keeps, and loads it only through its entry points', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.strictEqual(kitVersionIn(app), kitVersionIn(swText()), 'KIT_VERSION in app.js and sw.js');
  const imports = [...app.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((x) => x[1]);
  assert.ok(imports.length >= 3, 'readkit imports found');
  for (const i of imports) assert.ok(/^\.\/readkit\/(index|voice|player)\.js$/.test(i), 'import of ' + i);
  // and sw.js keeps the page shell the index.html asks for
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const asset of html.match(/(?:styles\.css|core\.js|app\.js)\?v=\d+/g)) assert.ok(swText().includes(`'${asset}'`), asset + ' in the SHELL list');
});

test('sw.js fingerprints a file as tools/readkit-files.mjs does (CRLF read as LF)', async () => {
  const src = /async function fingerprint\(buf\) \{[\s\S]*?\n\}/.exec(swText());
  assert.ok(src, 'fingerprint() in sw.js');
  const swPrint = new Function('crypto', src[0] + '\nreturn fingerprint;')(globalThis.crypto);
  const { fingerprint } = await kitTool();
  const enc = (s) => new TextEncoder().encode(s);
  const samples = [enc(''), enc('a\r\nb\rc\n'), enc('a\nb\rc\n'), enc('\r'), enc('x\r\n'), fs.readFileSync(path.join(ROOT, 'readkit/index.js'))];
  for (const b of samples) assert.strictEqual(await swPrint(b), fingerprint(b));
  assert.strictEqual(fingerprint(enc('a\r\nb')), fingerprint(enc('a\nb')));
  assert.notStrictEqual(fingerprint(enc('a\rb')), fingerprint(enc('a\nb')));
});

/* ---------- speed ---------- */

test('big text performance', (K) => {
  const para = 'Ibn Khaldun argued that group feeling binds people together. Over time, luxury weakens it, and the dynasty declines. ';
  const t = (para.repeat(8) + '\n\n').repeat(700); // ~650k chars
  const t0 = Date.now();
  const segs = K.plan(t, { dialect: 'en-US' });
  const ms = Date.now() - t0;
  assert.ok(segs.length > 10000);
  assert.ok(ms < 5000, 'too slow: ' + ms + 'ms');
  console.log(`  planned ${t.length} chars into ${segs.length} segments in ${ms} ms`);
});

(async () => {
  const K = await import('../readkit/index.js');
  for (const [name, fn] of tests) {
    try {
      await fn(K);
      passed++;
    } catch (e) {
      console.error('FAIL', name);
      console.error(e);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${tests.length} core tests passed`);
})();
