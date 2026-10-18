// End-to-end sync test: two browser "devices" (a laptop and an Android-sized phone)
// sync through a local stand-in for GitHub's gist API. Needs Chrome or Edge.
//   node tests/sync.e2e.mjs            (set CHROME=/path/to/chrome if it isn't found)
import os from 'node:os';
import path from 'node:path';
import { connect, launchChrome, newDevice, staticServer } from './browser.mjs';
import { fakeGitHub } from './fixtures/github.mjs';
let checks = 0;
let failures = 0;
function check(ok, what, detail) {
  checks++;
  if (ok) console.log('  ok  ' + what);
  else {
    failures++;
    console.log('  FAIL ' + what + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : ''));
  }
}

/* ---------- the scenarios ---------- */

const TOKEN = 'github_pat_' + 'TEST0readout0e2e0'.repeat(5);
const OTHER = 'github_pat_' + 'OTHER0readout0e2e'.repeat(5);
const STRANGER = 'github_pat_' + 'STRANGER0readout0'.repeat(5);

async function main() {
  const gh = fakeGitHub();
  const app = staticServer();
  await new Promise((r) => gh.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  gh.base = `http://127.0.0.1:${gh.server.address().port}`;
  const appUrl = `http://127.0.0.1:${app.address().port}/`;
  gh.tokens.set(TOKEN, 'thebestproever');
  gh.tokens.set(OTHER, 'thebestproever');
  const chrome = await launchChrome();
  const cdp = await connect(chrome.url);
  const shots = process.env.SHOTS || os.tmpdir();
  try {
    const laptop = await newDevice(cdp, 'laptop', { config: { githubApi: gh.base, netWait: 4000, netStall: 2500 } });
    const phone = await newDevice(cdp, 'phone', { config: { githubApi: gh.base, netWait: 4000, netStall: 2500 }, phone: true });
    await laptop.goto(appUrl);
    await phone.goto(appUrl);

    console.log('Setup');
    check((await laptop.eval('return T.docs().map(d => d.id)')).join() === 'welcome', 'a fresh device starts with the shared welcome text');
    await laptop.eval(`await T.connect('not a token')`);
    check(/doesn’t look like/.test(await laptop.eval(`return T.$('syncSetupMsg').textContent`)), 'rejects text that is not a token');
    await laptop.eval(`await T.connect('github_pat_${'x'.repeat(60)}')`);
    check(/didn’t accept/.test(await laptop.eval(`return T.$('syncSetupMsg').textContent`)), 'explains a token GitHub rejects');
    await laptop.eval(`await T.connect(${JSON.stringify(TOKEN)})`);
    check(await laptop.eval(`return !T.$('syncConfirm').hidden && !T.R().sync.cfg`), 'with no sync gist yet, asks before creating one');
    await laptop.eval(`T.$('syncCreateBtn').click(); await T.wait(() => T.R().sync.cfg); await T.idle();`);
    const gistId = await laptop.eval('return T.R().sync.cfg.gistId');
    const created = gh.gists.get(gistId);
    check(created && created.public === false, 'creates a secret gist');
    check(/Synced with GitHub as thebestproever/.test(await laptop.eval(`return T.$('syncStatus').textContent`)), 'shows who it syncs as', await laptop.eval(`return T.$('syncStatus').textContent`));
    check(Object.keys(gh.readFiles(gistId)).every((n) => /^readout-(index|prefs|docs-[0-9a-f])\.json$/.test(n)), 'writes only Readout files');

    console.log('Adding and editing');
    const noteA = await laptop.eval(`const id = T.newNote('Shopping list. Milk, eggs, and bread.'); T.done(); return id;`);
    await laptop.eval('await T.idle()');
    const remoteHas = (text) => Object.values(gh.readFiles(gistId)).some((c) => c.includes(text));
    check(remoteHas('Shopping list. Milk, eggs, and bread.'), 'a new note reaches GitHub on its own after a short pause');
    const syncKey = await laptop.eval('return T.R().Core.makeSyncKey(T.R().sync.cfg.gistId, T.R().sync.cfg.token)');

    console.log('Second device');
    gh.listSecret = false; // fine-grained tokens may not list secret gists
    await phone.eval(`await T.connect(${JSON.stringify(OTHER)})`);
    check(await phone.eval(`return !T.$('syncConfirm').hidden`), 'a plain token on a second device asks before starting a separate sync');
    await phone.eval(`T.$('syncCancelBtn').click()`);
    await phone.eval(`await T.connect(${JSON.stringify(syncKey)})`);
    check(await phone.eval(`return !!T.R().sync.cfg && T.R().sync.cfg.gistId === ${JSON.stringify(gistId)}`), 'the sync key joins the same gist');
    const phoneDocs = await phone.eval('return T.docs()');
    check(phoneDocs.some((d) => d.text === 'Shopping list. Milk, eggs, and bread.'), 'the laptop’s note shows up on the phone');
    check(phoneDocs.filter((d) => /Welcome to Readout/.test(d.title)).length === 1, 'the two welcome texts become one', phoneDocs.map((d) => d.title));
    check(gh.gists.size === 1, 'still only one sync gist');

    console.log('Changes flow both ways');
    await laptop.eval(`T.open(${JSON.stringify(noteA)})`);
    await phone.eval(`T.open(${JSON.stringify(noteA)}); T.$('modeBtn').click(); T.typeMore(' Also apples.'); T.done(); await T.idle();`);
    await laptop.eval('await T.syncNow()');
    check((await laptop.eval(`return T.R().state.current.text`)) === 'Shopping list. Milk, eggs, and bread. Also apples.', 'an edit on the phone updates the open text on the laptop');
    check(await laptop.eval(`return document.getElementById('reader').textContent.includes('Also apples.')`), 'and the laptop’s reader shows it');
    const before = gh.log.filter((e) => e.method === 'PATCH').length;
    await laptop.eval('await T.syncNow()');
    check(gh.log.filter((e) => e.method === 'PATCH').length === before, 'nothing new means nothing written');
    check(gh.log.slice(-1)[0].status === 304, 'and the check is a free 304', gh.log.slice(-2));

    console.log('Reading place');
    await phone.eval(`T.open(${JSON.stringify(noteA)}); const sc = T.$('scrub'); sc.value = '1'; sc.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1700)); await T.syncNow();`);
    await laptop.eval('await T.syncNow()');
    check((await laptop.eval('return T.R().state.idx')) === 1, 'the laptop moves to where the phone stopped', await laptop.eval('return T.R().state.idx'));
    const synced = JSON.parse(gh.readFiles(gistId)['readout-index.json']).positions.find((p) => p.id === noteA);
    check(synced && Object.keys(synced).join() === 'id,offset,progress,done,at' && synced.offset === 'Shopping list. '.length && !synced.done, 'the place is kept per sentence, in the same format as before', synced);
    check(await laptop.eval(`return document.querySelector('.chunk.is-current').textContent === 'Milk, eggs, and bread.'`), 'and the laptop highlights that sentence');

    console.log('Pronunciations');
    await laptop.eval(`T.$('settingsBtn').click(); T.$('lexWord').value = 'Milk'; T.$('lexSay').value = 'fresh milk'; T.$('lexAddBtn').click(); T.closeSheets(); await T.idle();`);
    check(!!gh.readFiles(gistId)['readout-prefs.json'], 'the pronunciation list goes to the gist in its own file');
    check(await laptop.eval(`return T.R().state.segs.some((s) => /fresh milk/i.test(s.spoken))`), 'and the open text is read with it at once');
    await phone.eval('await T.syncNow()');
    check((await phone.eval(`return JSON.stringify(T.R().state.settings.lexicon)`)) === JSON.stringify([['Milk', 'fresh milk']]), 'the other device gets the list');
    check(await phone.eval(`return T.R().state.segs.some((s) => /fresh milk/i.test(s.spoken)) && document.querySelector('.chunk[data-i="1"]').textContent === 'Milk, eggs, and bread.'`), 'and reads its open text with it, without changing what is shown');

    console.log('Pin and rename');
    await phone.eval(`T.$('moreBtn').click(); document.querySelector('[data-act="pin"]').click(); await T.idle();`);
    await laptop.eval(`const t = T.$('docTitle'); t.value = 'Groceries'; t.dispatchEvent(new Event('input')); await T.idle();`);
    await phone.eval('await T.syncNow()');
    await laptop.eval('await T.syncNow()');
    const pinned = (await laptop.eval('return T.docs()')).find((d) => d.id === noteA);
    const pinned2 = (await phone.eval('return T.docs()')).find((d) => d.id === noteA);
    check(pinned.pinned && pinned.title === 'Groceries' && pinned2.pinned && pinned2.title === 'Groceries', 'a pin on one device and a rename on the other both stick', [pinned, pinned2]);
    check((await laptop.eval('return T.docs().length')) === 2, 'no extra copies from that', await laptop.eval('return T.docs()'));

    console.log('Editing the same note on both at once');
    await laptop.eval(`T.$('modeBtn').click(); T.typeMore(' Laptop line.'); T.done();`);
    await phone.eval(`T.$('modeBtn').click(); T.typeMore(' Phone line.'); T.done();`);
    await laptop.eval('await T.syncNow()');
    await phone.eval('await T.syncNow()');
    await laptop.eval('await T.syncNow()');
    const lt = (await laptop.eval('return T.docs()')).map((d) => d.text);
    const pt = (await phone.eval('return T.docs()')).map((d) => d.text);
    check(lt.some((t) => t.endsWith('Laptop line.')) && lt.some((t) => t.endsWith('Phone line.')), 'both versions are kept', lt);
    check(JSON.stringify(lt.sort()) === JSON.stringify(pt.sort()), 'and both devices agree');
    check((await laptop.eval('return T.docs().map(d => d.title)')).some((t) => /\(other copy\)$/.test(t)), 'the extra version is labeled as a copy');

    console.log('Deleting');
    const copyId = await laptop.eval(`return T.docs().find(d => /\\(other copy\\)$/.test(d.title)).id`);
    await laptop.eval(`T.open(${JSON.stringify(copyId)}); T.$('moreBtn').click(); document.querySelector('[data-act="delete"]').click(); await T.idle();`);
    await phone.eval('await T.syncNow()');
    check(!(await phone.eval('return T.docs()')).some((d) => d.id === copyId), 'a deletion on the laptop removes it from the phone');
    await laptop.eval(`T.open('welcome'); T.$('moreBtn').click(); document.querySelector('[data-act="delete"]').click(); await new Promise(r => setTimeout(r, 50)); T.$('toastAction').click(); await T.idle();`);
    await phone.eval('await T.syncNow()');
    check((await phone.eval('return T.docs()')).some((d) => d.id === 'welcome'), 'undo after a delete keeps the text everywhere');
    await phone.eval(`T.open('welcome'); T.$('moreBtn').click(); document.querySelector('[data-act="delete"]').click(); await T.idle();`);
    await laptop.eval('await T.syncNow()');
    check(!(await laptop.eval('return T.docs()')).some((d) => d.id === 'welcome'), 'deleting the welcome text on the phone removes it on the laptop');

    console.log('Typing while a change arrives');
    await laptop.eval(`T.closeSheets(); T.open(${JSON.stringify(noteA)}); T.$('modeBtn').click(); T.$('editor').focus(); if (document.activeElement !== T.$('editor')) throw new Error('editor not focused'); T.typeMore(' From laptop.');`);
    await phone.eval(`T.open(${JSON.stringify(noteA)}); T.$('modeBtn').click(); T.typeMore(' From phone.'); T.done(); await T.idle();`);
    await laptop.eval('await T.syncNow()');
    check(!(await laptop.eval(`return T.$('editor').value`)).includes('From phone.'), 'the text being typed in isn’t replaced mid-typing');
    await laptop.eval(`T.done(); await T.wait(() => T.R().sync.timer || T.R().sync.running, 3000, 'a sync after Done'); await T.idle();`);
    check(gh.log.slice(-3).some((e) => e.method === 'PATCH'), 'typing that waited is sent after Done, without Sync now');
    await phone.eval('await T.syncNow()');
    const lt2 = (await laptop.eval('return T.docs()')).map((d) => d.text);
    check(lt2.some((t) => t.includes('From phone.')) && lt2.some((t) => t.includes('From laptop.')), 'after typing, both versions are kept', lt2);

    console.log('An open but idle editor');
    await laptop.eval(`T.open(${JSON.stringify(noteA)}); T.$('modeBtn').click(); const ed = T.$('editor'); ed.focus(); ed.setSelectionRange(5, 5); T.R().editing.lastAt = 0;`);
    await phone.eval(`T.open(${JSON.stringify(noteA)}); T.$('modeBtn').click(); T.typeMore(' Idle check.'); T.done(); await T.idle();`);
    await laptop.eval('await T.syncNow()');
    check((await laptop.eval(`return T.$('editor').value`)).endsWith('Idle check.'), 'a note left open in the editor still gets the other device’s edit');
    check((await laptop.eval(`return T.$('editor').selectionStart`)) === 5, 'without moving the cursor');
    check(!(await laptop.eval('return T.docs()')).some((d) => /Idle check\.$/.test(d.text) && /\(other copy\)/.test(d.title)), 'and without making a copy');
    await laptop.eval(`T.done(); await T.idle();`);

    console.log('Reading place while a note is open in the editor');
    await laptop.eval(`T.open(${JSON.stringify(noteA)}); const sc = T.$('scrub'); sc.value = '0'; sc.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1700)); await T.syncNow(); T.$('modeBtn').click(); T.R().editing.lastAt = 0;`);
    await phone.eval(`await T.syncNow(); T.open(${JSON.stringify(noteA)}); const sc = T.$('scrub'); sc.value = '1'; sc.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1700)); await T.syncNow();`);
    await laptop.eval('await T.syncNow()');
    check((await laptop.eval('return T.R().state.mode + ":" + T.R().state.idx')) === 'edit:1', 'an open editor still takes the other device’s reading place', await laptop.eval('return T.R().state.mode + ":" + T.R().state.idx'));
    const atEdit = await laptop.eval(`return T.R().state.positions.get(${JSON.stringify(noteA)}).at`);
    await laptop.eval(`window.dispatchEvent(new Event('pagehide')); await new Promise(r => setTimeout(r, 100)); T.done(); await T.idle();`);
    check((await laptop.eval(`return T.R().state.positions.get(${JSON.stringify(noteA)}).at`)) === atEdit, 'so leaving the app doesn’t push an old place back');

    console.log('Reading place is not re-stamped by leaving the app');
    await phone.eval(`T.open(${JSON.stringify(noteA)}); const sc = T.$('scrub'); sc.value = '0'; sc.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1700)); await T.syncNow();`);
    await laptop.eval(`await T.syncNow(); T.open(${JSON.stringify(noteA)}); const sc = T.$('scrub'); sc.value = '2'; sc.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 1700)); await T.syncNow();`);
    const atBefore = await phone.eval(`return T.R().state.positions.get(${JSON.stringify(noteA)}).at`);
    await phone.eval(`window.dispatchEvent(new Event('pagehide')); await new Promise(r => setTimeout(r, 100));`);
    check((await phone.eval(`return T.R().state.positions.get(${JSON.stringify(noteA)}).at`)) === atBefore, 'hiding the app without moving keeps the old time');
    await phone.eval('await T.idle(); await T.syncNow()');
    check((await phone.eval('return T.R().state.idx')) === 2, 'so the phone takes the laptop’s newer place', await phone.eval('return T.R().state.idx'));

    console.log('Backups and sync');
    const snap = await laptop.eval(`return T.backup([${JSON.stringify(noteA)}])`);
    await laptop.eval(`T.open(${JSON.stringify(noteA)}); T.$('moreBtn').click(); document.querySelector('[data-act="pin"]').click(); await T.idle(); T.$('moreBtn').click(); document.querySelector('[data-act="delete"]').click(); await T.idle();`);
    await phone.eval('await T.syncNow()');
    check(!(await phone.eval('return T.docs()')).some((d) => d.id === noteA), 'deleted on both devices');
    await laptop.eval(`await T.importBackup(${JSON.stringify(snap)}); await T.idle(); await T.syncNow();`);
    check((await laptop.eval('return T.docs()')).some((d) => d.id === noteA), 'importing a backup brings a deleted text back');
    await phone.eval('await T.syncNow()');
    check((await phone.eval('return T.docs()')).some((d) => d.id === noteA), 'on the other device too');
    await laptop.eval('await T.syncNow()');
    check((await laptop.eval('return T.docs()')).some((d) => d.id === noteA), 'and it stays after more syncs');
    // Notes copied between devices with backups before sync existed (no sync history).
    const legacy = (text) => ({ app: 'readout', version: 1, docs: [{ id: 'oldnote1', title: 'Trip', titleLocked: true, text, createdAt: 1, updatedAt: 2, pinned: false }], positions: [] });
    await laptop.eval(`await T.importBackup(${JSON.stringify(legacy('Trip plans.'))}); await T.idle();`);
    await phone.eval(`await T.importBackup(${JSON.stringify(legacy('Trip plans. Tuesday notes.'))}); await T.idle();`);
    await laptop.eval(`T.open('oldnote1'); T.$('moreBtn').click(); document.querySelector('[data-act="pin"]').click(); await T.idle(); await T.syncNow();`);
    await phone.eval('await T.syncNow()');
    await laptop.eval('await T.syncNow()');
    const trip = (await phone.eval('return T.docs()')).filter((d) => d.id.startsWith('oldnote1')).map((d) => d.text).sort();
    check(JSON.stringify(trip) === JSON.stringify(['Trip plans.', 'Trip plans. Tuesday notes.']), 'old copies that drifted apart are both kept', trip);

    console.log('Two tabs on one device');
    const tab2 = await newDevice(cdp, 'laptop tab 2', { config: { githubApi: gh.base, netWait: 4000, netStall: 2500 }, context: laptop.context });
    await tab2.goto(appUrl);
    await tab2.eval('await T.idle()');
    const ids = [await laptop.eval('return T.R().sync.device'), await tab2.eval('return T.R().sync.device')];
    check(ids[0] && ids[1] && ids[0] !== ids[1], 'each open copy of Readout gets its own sync id', ids);
    check(!!(await tab2.eval('return T.R().sync.cfg')), 'and the second tab syncs too');

    console.log('Big texts');
    const big = 'This is a long sentence that repeats to make a big book. '.repeat(22000); // ~1.25 MB
    const bigId = await laptop.eval(`const id = T.newNote(${JSON.stringify(big)}); T.done(); await T.idle(); return id;`);
    const shardSize = Math.max(...Object.values(gh.readFiles(gistId)).map((c) => Buffer.byteLength(c)));
    check(shardSize > 1024 * 1024, 'the test text is over GitHub’s 1 MB inline limit', shardSize);
    await phone.eval('await T.syncNow()');
    check((await phone.eval(`return (T.R().state.docs.find(d => d.id === ${JSON.stringify(bigId)}) || {text: ''}).text.length`)) === big.length, 'the phone still gets all of it');
    check(gh.log.some((e) => e.path.startsWith('/raw/') && e.status === 200), 'by fetching the full file');

    console.log('Problems');
    gh.faults.push({ match: () => true, drop: true });
    await laptop.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    check((await laptop.eval('return T.R().sync.error')) === 'offline', 'offline is noticed');
    check(/Offline/.test(await laptop.eval(`return T.$('syncStatus').textContent`)), 'and explained');
    gh.faults.length = 0;
    await laptop.eval('await T.syncNow()');
    check((await laptop.eval('return T.R().sync.error')) === '', 'it recovers when back online');
    gh.faults.push({ match: (m) => m === 'GET', status: 403, headers: { 'Retry-After': '120' }, once: true });
    await laptop.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    check((await laptop.eval('return T.R().sync.error')) === 'busy', 'GitHub’s “slow down” is respected');
    check((await laptop.eval('return T.R().sync.retryAt - Date.now()')) > 100000, 'with the wait GitHub asked for');
    await laptop.eval('await T.syncNow()');
    gh.writeFile(gistId, 'readout-index.json', JSON.stringify({ app: 'readout', schema: 99, positions: [], tombs: {} }));
    await phone.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    check((await phone.eval('return T.R().sync.error')) === 'newer', 'a sync file from a newer Readout is left alone');
    check(!JSON.parse(gh.readFiles(gistId)['readout-index.json']).positions.length, 'and not overwritten');
    gh.writeFile(gistId, 'readout-index.json', JSON.stringify({ app: 'readout', schema: 1, positions: [], tombs: {} }));
    await phone.eval('await T.syncNow()');
    gh.tokens.delete(OTHER);
    gh.tokens.delete(TOKEN);
    await phone.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    check((await phone.eval('return T.R().sync.error')) === 'auth', 'a revoked token stops sync');
    check(await phone.eval(`return !T.$('syncFixBtn').hidden`), 'and offers to use a new token');
    check(/GitHub no longer accepts the token/.test(await phone.eval('return T.toast()')), 'with a message', await phone.eval('return T.toast()'));
    gh.tokens.set(TOKEN, 'thebestproever');
    await phone.eval(`T.$('syncFixBtn').click(); await T.connect(${JSON.stringify(syncKey)});`);
    check((await phone.eval('return T.R().sync.error')) === '' && (await phone.eval('return !!T.R().sync.cfg')), 'reconnecting with a key fixes it');

    console.log('Recovering');
    gh.listSecret = false;
    const OTHER2 = 'github_pat_' + 'NEW0token0readout'.repeat(5);
    gh.tokens.set(OTHER2, 'thebestproever');
    gh.tokens.delete(TOKEN);
    await phone.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    await phone.eval(`T.$('syncFixBtn').click(); await new Promise(r => setTimeout(r, 50)); await T.connect(${JSON.stringify(OTHER2)});`);
    check((await phone.eval('return T.R().sync.cfg && T.R().sync.cfg.gistId')) === gistId, 'a new token rejoins the same gist without the sync key', await phone.eval('return T.R().sync.cfg'));
    gh.tokens.set(TOKEN, 'thebestproever');
    gh.gists.delete(gistId);
    await laptop.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    check((await laptop.eval('return T.R().sync.error')) === 'missing', 'a deleted sync gist is noticed');
    await laptop.eval(`T.$('settingsBtn').click(); T.$('syncFixBtn').click(); await T.wait(() => !T.$('syncConfirm').hidden || T.R().sync.cfg);`);
    check(gh.gists.size === 0 && (await laptop.eval(`return !T.$('syncConfirm').hidden`)), 'and isn’t replaced without asking');
    await laptop.eval(`T.$('syncCreateBtn').click(); await T.wait(() => T.R().sync.cfg); await T.idle();`);
    const newGist = await laptop.eval('return T.R().sync.cfg.gistId');
    gh.listSecret = true;
    await phone.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error); await T.idle().catch(() => {});`);
    await phone.eval(`T.$('settingsBtn').click(); T.$('syncFixBtn').click(); await T.wait(() => !T.$('syncConfirm').hidden || (T.R().sync.cfg && !T.R().sync.running)); await T.idle();`);
    check((await phone.eval('return T.R().sync.cfg && T.R().sync.cfg.gistId')) === newGist && gh.gists.size === 1, 'the other device joins the new gist instead of making another');
    check((await phone.eval('return T.docs().length')) === (await laptop.eval('return T.docs().length')), 'with everything still there');
    gh.listSecret = false;
    await tab2.goto(appUrl);

    console.log('Another GitHub account on the same browser');
    gh.tokens.set(STRANGER, 'someoneelse');
    await phone.eval(`T.$('syncOffBtn').click(); await T.connect(${JSON.stringify(STRANGER)});`);
    check((await phone.eval(`return !T.R().sync.cfg && !T.$('syncConfirm').hidden`)), 'a token from a different account isn’t attached to this account’s gist');
    const freshKey = await laptop.eval('return T.R().Core.makeSyncKey(T.R().sync.cfg.gistId, T.R().sync.cfg.token)');
    await phone.eval(`T.$('syncCancelBtn').click(); await T.connect(${JSON.stringify(freshKey)});`);
    check((await phone.eval('return T.R().sync.cfg && T.R().sync.cfg.gistId')) === newGist, 'and the right sync key still joins');

    console.log('Slow connections');
    await laptop.eval(`T.newNote('Slow line test.'); T.done(); await T.idle();`);
    gh.slow = { match: (m, p) => m === 'GET' && p.startsWith('/gists/'), pieces: 10, everyMs: 700 };
    await phone.eval('await T.syncNow()');
    check((await phone.eval('return T.R().sync.error')) === '' && (await phone.eval('return T.docs()')).some((d) => d.text === 'Slow line test.'), 'a slow but steady download finishes, even past the wait for a reply', await phone.eval('return T.R().sync.error'));
    await laptop.eval(`T.newNote('Stall test.'); T.done(); await T.idle();`);
    gh.slow = { match: (m, p) => m === 'GET' && p.startsWith('/gists/'), pieces: 4, everyMs: 100, stallMs: 5000 };
    await phone.eval(`T.$('syncNowBtn').click(); await T.wait(() => T.R().sync.error, 15000); await T.idle().catch(() => {});`);
    check((await phone.eval('return T.R().sync.error')) === 'offline', 'a download that stops part way is given up on', await phone.eval('return T.R().sync.error'));
    gh.slow = null;
    await phone.eval('await T.syncNow()');
    check((await phone.eval('return T.docs()')).some((d) => d.text === 'Stall test.'), 'and the next try gets it');

    console.log('After a reload');
    await phone.goto(appUrl);
    await phone.eval('await T.idle()');
    check((await phone.eval('return !!T.R().sync.cfg')) && (await phone.eval('return T.docs().length')) === (await laptop.eval('return T.docs().length')), 'sync stays on and the library is intact');

    console.log('Phone layout');
    await phone.eval(`T.closeSheets(); T.$('settingsBtn').click(); await new Promise(r => setTimeout(r, 300)); T.$('syncNowBtn').scrollIntoView();`);
    const overflow = await phone.eval(`const w = innerWidth; return [...document.querySelectorAll('#settingsSheet *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > w + 0.5 || r.left < -0.5); }).map(e => e.id || e.className || e.tagName).slice(0, 5)`);
    check(!overflow.length, 'the sync settings fit a 360 px phone screen', overflow);
    await phone.screenshot(path.join(shots, 'readout-sync-phone.png'));
    await phone.eval(`T.$('syncOffBtn').click()`);
    await phone.eval(`T.closeSheets(); T.$('settingsBtn').click(); await new Promise(r => setTimeout(r, 300)); T.$('syncInput').scrollIntoView({block: 'center'});`);
    await phone.screenshot(path.join(shots, 'readout-sync-setup-phone.png'));
    check((await phone.eval('return T.docs().length')) > 0, 'turning sync off keeps the texts');

    console.log('Console');
    for (const dev of [laptop, phone]) {
      const bad = dev.logs.filter((l) => l.type === 'exception' || l.type === 'error');
      check(!bad.length, `no errors on the ${dev.name}`, bad);
    }
    const versions = gh.log.filter((e) => e.status === 400);
    check(!versions.length, 'every request sent the API version header', versions);
  } finally {
    cdp.close();
    await chrome.close();
    gh.server.close();
    app.close();
  }
  console.log(`\n${checks - failures}/${checks} end-to-end checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
