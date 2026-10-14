const assert = require('assert');
const C = require('../core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    console.error(e);
    process.exitCode = 1;
  }
}
const slices = (text, chunks) => chunks.map((c) => text.slice(c.start, c.end));

test('basic sentences', () => {
  const t = 'Hello there. How are you? I am fine!';
  assert.deepStrictEqual(slices(t, C.chunkText(t)), ['Hello there.', 'How are you?', 'I am fine!']);
});

test('offsets map to original text and never overlap', () => {
  const t = 'First line here.\n\nSecond paragraph, with a comma. And more.\n- a list item\n- another one';
  const ch = C.chunkText(t);
  let last = 0;
  for (const c of ch) {
    assert.ok(c.start >= last && c.end > c.start, 'ordered');
    last = c.end;
  }
  assert.deepStrictEqual(slices(t, ch), ['First line here.', 'Second paragraph, with a comma.', 'And more.', '- a list item', '- another one']);
});

test('hard-wrapped sentence is read as one chunk', () => {
  const t = 'This sentence was wrapped by an email client because it is fairly\nlong and keeps going onto a second line.';
  const ch = C.chunkText(t);
  assert.strictEqual(ch.length, 1);
  assert.ok(slices(t, ch)[0].includes('\n'));
});

test('heading line stays separate', () => {
  const t = 'Chapter Five\nThe city grows as people settle.';
  assert.deepStrictEqual(slices(t, C.chunkText(t)), ['Chapter Five', 'The city grows as people settle.']);
});

test('long sentence is split under the max', () => {
  const t = 'word '.repeat(200).trim() + '.';
  const ch = C.chunkText(t);
  assert.ok(ch.length > 4);
  for (const c of ch) assert.ok(c.end - c.start <= C.MAX_CHUNK, 'chunk too long: ' + (c.end - c.start));
  // all words covered
  const joined = slices(t, ch).join(' ');
  assert.strictEqual(C.wordCount(joined), 200);
});

test('long sentence prefers clause breaks', () => {
  const t = 'A'.repeat(10) + ' ' + 'alpha beta gamma delta, '.repeat(12) + 'end.';
  const ch = C.chunkText(t);
  for (const s of slices(t, ch).slice(0, -1)) assert.ok(/,$/.test(s), 'should end at comma: ' + s.slice(-20));
});

test('abbreviations do not split', () => {
  const t = 'I met Dr. Smith at 5 p.m. yesterday. Then we left.';
  const s = slices(t, C.chunkText(t));
  assert.strictEqual(s[s.length - 1], 'Then we left.');
  assert.ok(s[0].startsWith('I met Dr. Smith'));
});

test('symbol-only lines are skipped', () => {
  const t = 'Before.\n* * *\n---\nAfter.';
  assert.deepStrictEqual(slices(t, C.chunkText(t)), ['Before.', 'After.']);
});

test('empty and whitespace text', () => {
  assert.deepStrictEqual(C.chunkText(''), []);
  assert.deepStrictEqual(C.chunkText('   \n\n  '), []);
});

test('speakable keeps length and drops markdown and urls', () => {
  const s = '## Title with **bold** and a link https://example.com/a?b=c here — ok';
  const out = C.speakable(s);
  assert.strictEqual(out.length, s.length);
  assert.ok(!out.includes('#') && !out.includes('*') && !out.includes('https'));
  assert.ok(out.includes('link'));
  const q = '> quoted line\n> more';
  assert.strictEqual(C.speakable(q).length, q.length);
  assert.ok(!C.speakable(q).includes('>'));
  assert.ok(C.speakable('Wait... what').includes('...'));
});

test('prefixLengths and findChunkIndex', () => {
  const t = 'One. Two two. Three three three.';
  const ch = C.chunkText(t);
  const cum = C.prefixLengths(ch);
  assert.strictEqual(cum.length, ch.length + 1);
  assert.strictEqual(cum[ch.length], ch.reduce((n, c) => n + c.end - c.start, 0));
  assert.strictEqual(C.findChunkIndex(ch, 0), 0);
  assert.strictEqual(C.findChunkIndex(ch, ch[1].start), 1);
  assert.strictEqual(C.findChunkIndex(ch, ch[1].start + 2), 1);
  assert.strictEqual(C.findChunkIndex(ch, ch[2].end + 50), 2);
  assert.strictEqual(C.findChunkIndex([], 10), 0);
});

test('reflow joins wrapped lines and keeps paragraphs', () => {
  const t = 'The Muqaddimah describes how dynasties rise and how, over\ngenerations, they lose the solidarity that built them. It is a\nsweeping argument.\n\nA new paragraph starts here and it continues for a while\nonto another line.';
  const r = C.reflow(t);
  assert.ok(!/over\ngenerations/.test(r));
  assert.ok(r.includes('\n\n'));
  assert.strictEqual(r.split('\n\n').length, 2);
  assert.strictEqual(C.reflow('infor-\nmation is key'), 'information is key');
});

test('stripRepeats removes running headers, footers, and page numbers', () => {
  const words = ['apples', 'rivers', 'lanterns', 'harbors', 'meadows', 'engines', 'violins', 'glaciers'];
  const pages = words.map((w, i) => {
    const n = i + 1;
    const body = Array.from({ length: 10 }, (_, k) => `Line ${k + 1} of the page about ${w}, which should stay put.`);
    return [n % 2 ? `The Art of Reading  ${n}` : `${n}  Chapter 2: Slow Books`, ...body, `Page ${n} of 8`].join('\n');
  });
  const out = C.stripRepeats(pages);
  words.forEach((w, i) => {
    assert.strictEqual(out[i].split('\n').length, 10, 'keeps all body lines: ' + out[i]);
    assert.ok(out[i].includes(`Line 1 of the page about ${w}`) && out[i].includes(`Line 10 of the page about ${w}`));
    assert.ok(!/Page \d of 8|Art of Reading|Slow Books/.test(out[i]), 'drops running heads and page numbers: ' + out[i]);
  });
  // A heading on only one page stays, and so does everything in a short document.
  const two = C.stripRepeats(['Introduction\nWhy we read.', 'Methods\nHow we read.\n2']);
  assert.deepStrictEqual(two, ['Introduction\nWhy we read.', 'Methods\nHow we read.']);
  assert.deepStrictEqual(C.stripRepeats(['iv\nPreface text.']), ['Preface text.']);
});

test('stripRepeats keeps numbered headings, words, and years', () => {
  const pages = [1, 2, 3, 4, 5, 6].map((n) =>
    [`Problem ${n} (10 points)`, ...Array.from({ length: 9 }, (_, k) => `Work line ${k} for problem ${n} goes here.`), `Smith ${n}`].join('\n')
  );
  const out = C.stripRepeats(pages);
  out.forEach((p, i) => {
    assert.ok(p.startsWith(`Problem ${i + 1} (10 points)`), 'keeps the heading: ' + p.slice(0, 40));
    assert.ok(!/Smith/.test(p), 'drops the running foot');
  });
  for (const line of ['civil', 'ill', 'Mix', '2024']) assert.strictEqual(C.stripRepeats([line + '\nBody.'])[0], line + '\nBody.', line);
  for (const line of ['12', '- 12 -', 'Page 3 of 9', 'iv', 'XL']) assert.strictEqual(C.stripRepeats([line + '\nBody.'])[0], 'Body.', line);
});

test('cleanOcr drops symbol junk and keeps words, dates, and numbers', () => {
  assert.strictEqual(C.cleanOcr('Real sentence here.\n|| — ~ ||\n= =\nI think so.\n'), 'Real sentence here.\nI think so.');
  assert.strictEqual(C.cleanOcr('on July 20, 1969.\nTotal due: $1,250.00\ny = 3x + 2\n«— | ;'), 'on July 20, 1969.\nTotal due: $1,250.00\ny = 3x + 2');
  assert.strictEqual(C.letterCount('a1 b2 c'), 3);
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

test('big text performance', () => {
  const para = 'Ibn Khaldun argued that group feeling binds people together. Over time, luxury weakens it, and the dynasty declines. ';
  const t = (para.repeat(8) + '\n\n').repeat(700); // ~650k chars
  const t0 = Date.now();
  const ch = C.chunkText(t);
  const ms = Date.now() - t0;
  assert.ok(ch.length > 10000);
  assert.ok(ms < 3000, 'too slow: ' + ms + 'ms');
  console.log(`  chunked ${t.length} chars into ${ch.length} chunks in ${ms} ms`);
});

console.log(`${passed} core tests passed`);
