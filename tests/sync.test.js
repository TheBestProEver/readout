// Sync merge tests: node tests/sync.test.js
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

// vv counts every change per device, tv only text changes.
const doc = (id, text, changedAt, vv, tv, extra) =>
  Object.assign({ id, title: '', text, createdAt: 1, updatedAt: changedAt, changedAt, pinned: false, vv: vv || {}, tv: tv || vv || {} }, extra);
const texts = (m) => Object.fromEntries(m.docs.map((d) => [d.id, d.text]));
const merge = (local, remote, opts) => C.mergeSync(local, remote, opts);

test('compareVV', () => {
  assert.strictEqual(C.compareVV({}, {}), 0);
  assert.strictEqual(C.compareVV({ a: 2 }, { a: 1 }), 1);
  assert.strictEqual(C.compareVV({ a: 1 }, { a: 1, b: 1 }), -1);
  assert.strictEqual(C.compareVV({ a: 2 }, { a: 1, b: 1 }), 2);
  assert.deepStrictEqual(C.bumpVV({ b: 1 }, 'a'), { a: 1, b: 1 });
});

test('a version that includes the other wins, whatever the clocks say', () => {
  // The laptop's clock is behind, but its version was made after seeing the phone's.
  const m = merge({ docs: [doc('a', 'phone', 50, { p: 1 })] }, { docs: [doc('a', 'phone then laptop', 10, { p: 1, l: 1 })] });
  assert.deepStrictEqual(texts(m), { a: 'phone then laptop' });
  assert.deepStrictEqual(m.copies, []);
});

test('docs only on one side are kept', () => {
  const m = merge({ docs: [doc('a', 'A', 1, { x: 1 })] }, { docs: [doc('b', 'B', 1, { y: 1 })] });
  assert.deepStrictEqual(texts(m), { a: 'A', b: 'B' });
});

test('empty texts never sync', () => {
  assert.deepStrictEqual(merge({ docs: [doc('a', '  \n', 5, { x: 1 })] }, {}).docs, []);
});

test('the same text edited on two devices keeps both versions', () => {
  const m = merge({ docs: [doc('a', 'phone edit', 5, { p: 1 }, null, { title: 'Note', titleLocked: true })] }, { docs: [doc('a', 'laptop edit', 7, { l: 1 }, null, { title: 'Note', titleLocked: true })] });
  const byText = Object.fromEntries(m.docs.map((d) => [d.text, d]));
  assert.strictEqual(byText['laptop edit'].id, 'a', 'newer edit keeps the original');
  assert.ok(byText['phone edit'], 'the other edit is kept as a copy');
  assert.notStrictEqual(byText['phone edit'].id, 'a');
  assert.strictEqual(byText['phone edit'].title, 'Note (other copy)');
  assert.deepStrictEqual(byText['laptop edit'].vv, { l: 1, p: 1 });
  assert.strictEqual(m.copies.length, 1);
});

test('both devices that spot a clash make the same copy', () => {
  const x = { docs: [doc('a', 'x text', 5, { x: 1 })] };
  const y = { docs: [doc('a', 'y text', 7, { y: 1 })] };
  assert.deepStrictEqual(C.buildSyncFiles(merge(x, y)), C.buildSyncFiles(merge(y, x)));
  // ...and merging again with the copy already present doesn't add another.
  const once = merge(x, y);
  const twice = merge(once, y);
  assert.strictEqual(twice.docs.length, 2);
});

test('pin on one device and an edit on another merge without a copy', () => {
  const base = { p: 1 };
  const pinned = doc('a', 'original', 9, { p: 1, x: 1 }, base, { pinned: true });
  const edited = doc('a', 'original, edited', 6, { p: 1, y: 1 }, { p: 1, y: 1 });
  const m = merge({ docs: [pinned] }, { docs: [edited] });
  assert.strictEqual(m.docs.length, 1);
  assert.strictEqual(m.docs[0].text, 'original, edited');
  assert.strictEqual(m.docs[0].pinned, true);
  assert.deepStrictEqual(m.copies, []);
});

test('a pin on one device and a rename on another both stick', () => {
  const pinned = doc('a', 'same text', 9, { p: 1, x: 1 }, { p: 1 }, { pinned: true, pinAt: 9 });
  const renamed = doc('a', 'same text', 12, { p: 1, y: 1 }, { p: 1 }, { title: 'Groceries', titleLocked: true, titleAt: 12 });
  for (const [l, r] of [[pinned, renamed], [renamed, pinned]]) {
    const d = merge({ docs: [l] }, { docs: [r] }).docs[0];
    assert.strictEqual(d.pinned, true);
    assert.strictEqual(d.title, 'Groceries');
    assert.ok(d.titleLocked);
  }
});

test('untitled docs take their title from the winning text', () => {
  const m = merge({ docs: [doc('a', 'Old first line', 9, { x: 1 }, {}, { title: 'Old first line', pinned: true })] }, { docs: [doc('a', 'New first line', 6, { y: 1 }, { y: 1 }, { title: 'New first line' })] });
  assert.strictEqual(m.docs[0].title, 'New first line');
});

test('a deletion removes the versions it had seen', () => {
  const m = merge({ docs: [doc('a', 'A', 3, { x: 1 })] }, { docs: [], tombs: { a: { at: 10, vv: { x: 1, y: 2 } } } });
  assert.deepStrictEqual(m.docs, []);
  assert.deepStrictEqual(Object.keys(m.tombs), ['a']);
});

test('a doc changed somewhere the deletion did not know about survives it', () => {
  const m = merge({ docs: [doc('a', 'edited offline', 6, { x: 2 })] }, { docs: [], tombs: { a: { at: 10, vv: { x: 1 } } } });
  assert.deepStrictEqual(texts(m), { a: 'edited offline' });
  assert.deepStrictEqual(m.tombs, {});
});

test('an untouched built-in text stays deleted everywhere', () => {
  const m = merge({ docs: [doc('welcome', 'Welcome', 1, {})] }, { docs: [], tombs: { welcome: { at: 10, vv: {} } } });
  assert.deepStrictEqual(m.docs, []);
});

test('identical built-in texts on two devices become one', () => {
  const m = merge({ docs: [doc('welcome', 'Welcome', 1, {}, {}, { updatedAt: 111 })] }, { docs: [doc('welcome', 'Welcome', 1, {}, {}, { updatedAt: 222 })] });
  assert.strictEqual(m.docs.length, 1);
  assert.deepStrictEqual(m.copies, []);
});

test('old deletions are pruned', () => {
  const m = merge({ tombs: { a: { at: 5, vv: {} }, b: { at: 50, vv: {} } } }, {}, { pruneBefore: 10 });
  assert.deepStrictEqual(Object.keys(m.tombs), ['b']);
});

test('positions: latest wins, and only for docs that exist', () => {
  const m = merge(
    { docs: [doc('a', 'A', 1, { x: 1 })], positions: [{ id: 'a', offset: 5, progress: 0.1, at: 10 }, { id: 'gone', offset: 1, at: 99 }] },
    { docs: [], positions: [{ id: 'a', offset: 50, progress: 0.9, at: 20 }] }
  );
  assert.deepStrictEqual(m.positions, [{ id: 'a', offset: 50, progress: 0.9, done: false, at: 20 }]);
});

test('very long texts are left out of sync', () => {
  const m = merge({ docs: [doc('a', 'x'.repeat(50), 1, { x: 1 }), doc('b', 'ok', 1, { x: 1 })] }, {}, { maxText: 10 });
  assert.deepStrictEqual(texts(m), { b: 'ok' });
});

test('files round-trip, and the diff touches only what changed', () => {
  const m = merge({ docs: [doc('a', 'A', 1, { x: 1 }), doc('b', 'B', 2, { x: 1 })], positions: [{ id: 'a', offset: 3, at: 4 }], tombs: { z: { at: 9, vv: {} } } }, {});
  const files = C.buildSyncFiles(m);
  assert.ok(files[C.SYNC_INDEX]);
  const back = C.parseSyncFiles(files);
  assert.deepStrictEqual(C.buildSyncFiles(merge(back, {})), files);
  assert.strictEqual(C.diffSyncFiles(files, files), null);
  const edited = C.buildSyncFiles(merge({ docs: [doc('a', 'A2', 5, { x: 2 }), doc('b', 'B', 2, { x: 1 })], positions: back.positions, tombs: back.tombs }, {}));
  assert.deepStrictEqual(Object.keys(C.diffSyncFiles(edited, files)), [C.shardName('a')]);
});

test('diff deletes shards that became empty and never touches other files', () => {
  const before = C.buildSyncFiles(merge({ docs: [doc('a', 'A', 1, { x: 1 })] }, {}));
  const after = C.buildSyncFiles(merge({ tombs: { a: { at: 5, vv: { x: 1 } } } }, {}));
  const patch = C.diffSyncFiles(after, Object.assign({ 'notes.txt': 'not ours' }, before));
  assert.strictEqual(patch[C.shardName('a')], null);
  assert.ok(patch[C.SYNC_INDEX].content.length > 2);
  assert.ok(!('notes.txt' in patch));
});

test('parse flags unreadable and newer files', () => {
  const r = C.parseSyncFiles({ [C.SYNC_INDEX]: '{"app":"readout","schema":99}', 'readout-docs-0.json': '{trunc', 'other.md': 'x' });
  assert.ok(r.newer);
  assert.deepStrictEqual(r.bad, ['readout-docs-0.json']);
});

test('shards spread docs over at most 16 files', () => {
  const names = new Set();
  for (let i = 0; i < 2000; i++) names.add(C.shardName(C.uid() + i));
  assert.strictEqual(names.size, 16);
});

test('sync keys', () => {
  const tok = 'github_pat_' + 'A1b2'.repeat(20);
  const key = C.makeSyncKey('0123456789abcdef0123456789abcdef', tok);
  assert.deepStrictEqual(C.parseSyncKey('  ' + key + '\n'), { gistId: '0123456789abcdef0123456789abcdef', token: tok });
  assert.deepStrictEqual(C.parseSyncKey(tok), { gistId: null, token: tok });
  assert.deepStrictEqual(C.parseSyncKey('ghp_' + 'x'.repeat(36)), { gistId: null, token: 'ghp_' + 'x'.repeat(36) });
  assert.strictEqual(C.parseSyncKey('hello'), null);
  assert.strictEqual(C.parseSyncKey('readout-sync:nothex:' + tok), null);
});

test('docs from before sync: identical copies merge, drifted copies keep both', () => {
  const legacy = (text) => ({ id: 'k1', title: '', text, createdAt: 1, updatedAt: 5 });
  const a = legacy('Essay draft');
  const b = legacy('Essay draft');
  assert.ok(C.seedVV(a) && C.seedVV(b));
  assert.ok(!C.seedVV(a), 'only seeds once');
  assert.strictEqual(merge({ docs: [a] }, { docs: [b] }).docs.length, 1);
  // One device edited its copy before the update; the other pins its copy after it.
  const phone = legacy('Essay draft\nPhone paragraph');
  const laptop = legacy('Essay draft');
  C.seedVV(phone);
  C.seedVV(laptop);
  laptop.vv = C.bumpVV(laptop.vv, 'L');
  laptop.pinned = true;
  const m = merge({ docs: [phone] }, { docs: [laptop] });
  assert.deepStrictEqual(m.docs.map((d) => d.text).sort(), ['Essay draft', 'Essay draft\nPhone paragraph']);
  // Deleting an untouched copy on one device doesn't delete the other device's different copy.
  const other = legacy('Essay draft, edited elsewhere');
  C.seedVV(other);
  assert.strictEqual(merge({ docs: [other] }, { tombs: { k1: { at: 9, vv: b.vv } } }).docs.length, 1);
});

test('maxVV tolerates missing vectors', () => {
  assert.deepStrictEqual(C.maxVV(undefined, { a: 2 }), { a: 2 });
  assert.deepStrictEqual(C.maxVV({ a: 1, b: 3 }, null), { a: 1, b: 3 });
  assert.deepStrictEqual(C.maxVV({ a: 1 }, { a: 4, c: 1 }), { a: 4, c: 1 });
});

test('backup import respects sync stamps', () => {
  const r = C.mergeDocs([{ id: 'a', text: 'pinned later', updatedAt: 1, changedAt: 9 }], [{ id: 'a', text: 'backup', updatedAt: 5 }]);
  assert.strictEqual(r.docs[0].text, 'pinned later');
});

/* ---------- simulation: devices syncing through one gist, with races ---------- */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mirrors what app.js does: read the gist, merge, keep the result, write only changed files.
function simulate(seed, opts) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  let clock = 1000;
  let ids = 0;
  const gist = { files: {} };
  const devices = Array.from({ length: opts.devices }, (_, i) => ({ name: 'd' + i, docs: new Map(), positions: new Map(), tombs: {}, seen: null, skew: (i - 1) * 7 }));
  const versions = new Set();

  const state = (dv) => ({ docs: [...dv.docs.values()], positions: [...dv.positions.values()], tombs: dv.tombs });
  const keep = (dv, m) => {
    dv.docs = new Map(m.docs.map((d) => [d.id, JSON.parse(JSON.stringify(d))]));
    dv.positions = new Map(m.positions.map((p) => [p.id, Object.assign({}, p)]));
    dv.tombs = JSON.parse(JSON.stringify(m.tombs));
  };
  const touch = (dv, d, textChanged) => {
    d.changedAt = clock + dv.skew;
    d.vv = C.bumpVV(d.vv, dv.name);
    if (textChanged) {
      d.tv = C.bumpVV(d.tv, dv.name);
      d.updatedAt = d.changedAt;
    }
  };
  const read = (dv) => (dv.seen = gist.files);
  const write = (dv) => {
    const m = C.mergeSync(state(dv), C.parseSyncFiles(dv.seen), {});
    keep(dv, m);
    const patch = C.diffSyncFiles(C.buildSyncFiles(m), dv.seen);
    dv.seen = null;
    if (!patch) return;
    // Like a gist PATCH: files we send replace what's there now, even if it changed since we read.
    const files = Object.assign({}, gist.files);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete files[k];
      else files[k] = v.content;
    }
    gist.files = files;
  };

  const ops = ['edit', 'edit', 'create', 'pin', 'rename', 'pos', 'read', 'write', 'sync', 'sync'];
  if (opts.deletes) ops.push('delete', 'delete');
  for (let step = 0; step < opts.steps; step++) {
    const dv = pick(devices);
    const op = pick(ops);
    clock += 1 + Math.floor(rand() * 3);
    const list = [...dv.docs.values()];
    if (op === 'create') {
      const id = dv.name + 'n' + ++ids;
      const d = { id, title: '', text: id, createdAt: clock, updatedAt: clock, pinned: false, vv: {}, tv: {} };
      touch(dv, d, true);
      dv.docs.set(id, d);
      versions.add(d.text);
    } else if (op === 'edit' && list.length) {
      const d = pick(list);
      d.text += '|' + dv.name + 'e' + ++ids;
      touch(dv, d, true);
      versions.add(d.text);
    } else if (op === 'pin' && list.length) {
      const d = pick(list);
      d.pinned = !d.pinned;
      d.pinAt = clock + dv.skew;
      touch(dv, d, false);
    } else if (op === 'rename' && list.length) {
      const d = pick(list);
      d.title = 'T' + ++ids;
      d.titleLocked = true;
      d.titleAt = clock + dv.skew;
      touch(dv, d, false);
    } else if (op === 'pos' && list.length) {
      const d = pick(list);
      dv.positions.set(d.id, { id: d.id, offset: Math.floor(rand() * 10), progress: rand(), done: false, at: clock + dv.skew });
    } else if (op === 'delete' && list.length) {
      const d = pick(list);
      dv.docs.delete(d.id);
      dv.positions.delete(d.id);
      dv.tombs[d.id] = { at: clock + dv.skew, vv: d.vv };
    } else if (op === 'read' && !dv.seen) {
      read(dv);
    } else if (op === 'write' && dv.seen) {
      write(dv); // other devices may have written since this one read: a race
    } else if (op === 'sync') {
      if (dv.seen) write(dv);
      read(dv);
      write(dv);
    }
  }
  for (const dv of devices) if (dv.seen) write(dv);
  for (let r = 0; r < 3; r++) for (const dv of devices) (read(dv), write(dv));
  return { devices, gist, versions };
}

function checkConverged(seed, devices, gist) {
  const want = JSON.stringify(C.buildSyncFiles(C.mergeSync(C.parseSyncFiles(gist.files), {})));
  for (const dv of devices) {
    const got = JSON.stringify(C.buildSyncFiles(C.mergeSync({ docs: [...dv.docs.values()], positions: [...dv.positions.values()], tombs: dv.tombs }, {})));
    assert.strictEqual(got, want, `seed ${seed}: ${dv.name} differs from the gist`);
  }
}

test('simulation: devices agree and no edit is ever lost (no deletions)', () => {
  let copies = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { devices, gist, versions } = simulate(seed, { devices: 3, steps: 140, deletes: false });
    checkConverged(seed, devices, gist);
    const finals = [...devices[0].docs.values()].map((d) => d.text);
    copies += [...devices[0].docs.keys()].filter((id) => /-/.test(id)).length;
    for (const v of versions) {
      // Edits only append, so a version survives if a final text equals it or continues it.
      assert.ok(finals.some((t) => t === v || t.startsWith(v + '|')), `seed ${seed}: lost "${v}"`);
    }
  }
  assert.ok(copies > 0, 'the simulation should hit some clashes');
});

test('simulation: devices agree with deletions too', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { devices, gist } = simulate(seed, { devices: 3, steps: 160, deletes: true });
    checkConverged(seed, devices, gist);
  }
});

/* ---------- 2.0: the pronunciation list syncs in its own file ---------- */

test('pronunciations: the newer list wins, and a side without one keeps the other', () => {
  const older = { lexicon: [['Kokoro', 'koh koh roh']], at: 100 };
  const newer = { lexicon: [['Kokoro', 'ko ko ro'], ['GIF', 'jif']], at: 200 };
  assert.deepStrictEqual(merge({ docs: [], prefs: older }, { docs: [], prefs: newer }).prefs, { lexicon: [['GIF', 'jif'], ['Kokoro', 'ko ko ro']], at: 200 });
  assert.deepStrictEqual(merge({ docs: [], prefs: newer }, { docs: [], prefs: older }).prefs.at, 200);
  assert.deepStrictEqual(merge({ docs: [], prefs: older }, { docs: [] }).prefs, older);
  assert.strictEqual(merge({ docs: [] }, { docs: [] }).prefs, null);
  // an emptied list is a change too
  assert.deepStrictEqual(merge({ docs: [], prefs: { lexicon: [], at: 300 } }, { docs: [], prefs: newer }).prefs, { lexicon: [], at: 300 });
});

test('pronunciations: round-trip through the gist, and versions before 2.0 leave the file alone', () => {
  const m = merge({ docs: [doc('a', 'Text.', 5, { d1: 1 })], prefs: { lexicon: [['Readout', 'read out']], at: 9 } }, {});
  const files = C.buildSyncFiles(m);
  assert.ok(C.SYNC_PREFS in files && C.isSyncFile(C.SYNC_PREFS));
  assert.deepStrictEqual(C.parseSyncFiles(files).prefs, { lexicon: [['Readout', 'read out']], at: 9 });
  // no list ever set: no file, so a 1.x gist looks the same as before
  assert.ok(!(C.SYNC_PREFS in C.buildSyncFiles(merge({ docs: [doc('a', 'Text.', 5, { d1: 1 })] }, {}))));
  // what a 1.x device writes (no prefs in its merge) never deletes the file: its diff only
  // removes index and shard files, so the old rule is checked here
  const oldIsSyncFile = (name) => name === 'readout-index.json' || /^readout-docs-[0-9a-f]\.json$/.test(name);
  assert.ok(!oldIsSyncFile(C.SYNC_PREFS));
  // and a 2.0 device reading a gist without the file keeps its own list
  const again = merge({ docs: [], prefs: { lexicon: [['x', 'ex']], at: 4 } }, C.parseSyncFiles(C.buildSyncFiles(merge({ docs: [] }, {}))));
  assert.deepStrictEqual(again.prefs, { lexicon: [['x', 'ex']], at: 4 });
});

test('positions keep the 1.x format (offset, progress, done, at)', () => {
  const m = merge({ docs: [doc('a', 'One. Two.', 5, { d1: 1 })], positions: [{ id: 'a', offset: 5, progress: 0.5, done: false, at: 7, extra: 'x' }] }, {});
  assert.deepStrictEqual(m.positions, [{ id: 'a', offset: 5, progress: 0.5, done: false, at: 7 }]);
});

console.log(`${passed} sync tests passed`);
