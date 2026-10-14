// End-to-end sync test: two browser "devices" (a laptop and an Android-sized phone)
// sync through a local stand-in for GitHub's gist API. Needs Chrome or Edge.
//   node tests/sync.e2e.mjs            (set CHROME=/path/to/chrome if it isn't found)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/* ---------- a stand-in for the GitHub gist API ---------- */

function fakeGitHub() {
  const tokens = new Map(); // token -> login
  const gists = new Map();
  const blobs = new Map();
  const log = [];
  const api = { tokens, gists, log, faults: [], listSecret: true, base: '', slow: null };
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, Link, Location, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  };
  const send = (res, status, body, headers, slow) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors, headers));
    if (!slow || !data) return res.end(data);
    const buf = Buffer.from(data);
    const size = Math.ceil(buf.length / slow.pieces);
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (i >= slow.pieces) return res.end();
      res.write(buf.subarray(i * size, (i + 1) * size));
      i++;
      setTimeout(next, i === Math.floor(slow.pieces / 2) && slow.stallMs ? slow.stallMs : slow.everyMs);
    };
    next();
  };
  const MB = 1024 * 1024;
  const cut = (s, bytes) => Buffer.from(s).subarray(0, bytes).toString('utf8');
  const gistJson = (g, withContent) => {
    const files = {};
    for (const [name, f] of g.files) {
      const size = Buffer.byteLength(f.content);
      files[name] = { filename: name, type: 'application/json', language: 'JSON', raw_url: `${api.base}/raw/${g.id}/${f.sha}/${encodeURIComponent(name)}`, size };
      if (withContent) Object.assign(files[name], { truncated: size > MB, content: size > MB ? cut(f.content, MB) : f.content, encoding: 'utf-8' });
    }
    return { id: g.id, url: `${api.base}/gists/${g.id}`, description: g.description, public: g.public, owner: { login: g.owner }, files, created_at: g.created_at, updated_at: g.updated_at, truncated: false };
  };
  const setFile = (g, name, content) => {
    const s = sha(content);
    blobs.set(s, content);
    g.files.set(name, { content, sha: s });
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: url.pathname + url.search, status: 0 };
      log.push(entry);
      const done = (status, b, h) => {
        entry.status = status;
        const slow = api.slow && api.slow.match(req.method, url.pathname) ? api.slow : null;
        send(res, status, b, h, slow);
      };
      if (url.pathname.startsWith('/raw/')) {
        // Like gist.githubusercontent.com: plain GETs only, preflights are refused.
        if (req.method === 'OPTIONS') return done(403, 'no');
        const [, , , s] = url.pathname.split('/');
        return blobs.has(s) ? done(200, blobs.get(s), { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=300' }) : done(404, 'missing');
      }
      if (req.method === 'OPTIONS') {
        entry.status = 204;
        res.writeHead(204, Object.assign({}, cors, {
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, If-Modified-Since, X-GitHub-Api-Version',
          'Access-Control-Max-Age': '86400',
        }));
        return res.end();
      }
      const fault = api.faults.find((f) => f.match(req.method, url.pathname));
      if (fault) {
        if (fault.once) api.faults.splice(api.faults.indexOf(fault), 1);
        if (fault.drop) {
          entry.status = 'dropped';
          return req.socket.destroy();
        }
        return done(fault.status, { message: 'injected' }, fault.headers);
      }
      if (req.headers['x-github-api-version'] !== '2026-03-10') return done(400, { message: 'bad api version header' });
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const login = auth && tokens.get(auth[1]);
      if (!login) return done(401, { message: 'Bad credentials' });
      let json = null;
      if (body) {
        try {
          json = JSON.parse(body);
        } catch (e) {
          return done(400, { message: 'Problems parsing JSON' });
        }
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/user') return done(200, { login });
      if (url.pathname === '/gists' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        const per = Number(url.searchParams.get('per_page') || 30);
        const mine = [...gists.values()].filter((g) => g.owner === login && (g.public || api.listSecret));
        return done(200, mine.slice((page - 1) * per, page * per).map((g) => gistJson(g, false)));
      }
      if (url.pathname === '/gists' && req.method === 'POST') {
        if (!json || json.public !== false || !json.files) return done(422, { message: 'Validation Failed' });
        const id = crypto.randomBytes(16).toString('hex');
        const now = new Date().toISOString();
        const g = { id, owner: login, description: json.description, public: false, files: new Map(), created_at: now, updated_at: now };
        for (const [name, f] of Object.entries(json.files)) {
          if (!f || typeof f.content !== 'string' || !f.content) return done(422, { message: 'Validation Failed: content empty' });
          setFile(g, name, f.content);
        }
        gists.set(id, g);
        return done(201, gistJson(g, true));
      }
      if (parts[0] === 'gists' && parts.length === 2) {
        const g = gists.get(parts[1]);
        if (!g) return done(404, { message: 'Not Found' });
        if (req.method === 'GET') {
          const out = JSON.stringify(gistJson(g, true));
          const etag = 'W/"' + sha(out) + '"';
          if (req.headers['if-none-match'] === etag) return done(304, undefined, { ETag: etag });
          return done(200, out, { ETag: etag, 'Cache-Control': 'private, max-age=60, s-maxage=60' });
        }
        if (req.method === 'PATCH') {
          if (g.owner !== login) return done(404, { message: 'Not Found' });
          for (const [name, f] of Object.entries((json && json.files) || {})) {
            // Like GitHub: null, or an object with neither content nor filename, deletes the file.
            if (f === null || (typeof f === 'object' && !('content' in f) && !('filename' in f))) g.files.delete(name);
            else if (typeof f.content === 'string' && f.content) setFile(g, name, f.content);
            else return done(422, { message: 'Validation Failed' });
          }
          if (!g.files.size) return done(422, { message: 'Validation Failed: no files' });
          g.updated_at = new Date().toISOString();
          const out = JSON.stringify(gistJson(g, true));
          return done(200, out, { ETag: 'W/"' + sha(out) + '"' });
        }
      }
      done(404, { message: 'Not Found' });
    });
  });
  api.server = server;
  api.readFiles = (id) => Object.fromEntries([...gists.get(id).files].map(([k, f]) => [k, f.content]));
  api.writeFile = (id, name, content) => setFile(gists.get(id), name, content);
  return api;
}

/* ---------- static server for the app ---------- */

function staticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  return http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- Chrome over the DevTools protocol, no dependencies ---------- */

function findChrome() {
  const c = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return c.find((p) => p && fs.existsSync(p));
}

async function launchChrome() {
  const exe = findChrome();
  if (!exe) throw new Error('Chrome not found. Set CHROME to its path.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readout-e2e-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try {
      const [port, wsPath] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      return { proc, dir, url: `ws://127.0.0.1:${port}${wsPath}` };
    } catch (e) {
      await sleep(100);
    }
  }
  throw new Error('Chrome did not start');
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let id = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const cdp = {
    listeners,
    send(method, params, sessionId) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params: params || {}, sessionId }));
      return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
    },
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(cdp);
    ws.onerror = reject;
  });
}

// Helpers loaded into each page.
const PAGE_HELPERS = `
window.T = {
  R: () => window.__readout,
  $: (id) => document.getElementById(id),
  wait: async (fn, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      try { if (await fn()) return true; } catch (e) {}
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('timed out waiting for ' + (what || fn.toString()));
  },
  idle: () => T.wait(() => !T.R().sync.running && !T.R().sync.timer, 20000, 'sync to finish'),
  syncNow: async () => {
    const t = T.R().sync.lastTry;
    T.$('syncNowBtn').click();
    await T.wait(() => T.R().sync.lastTry > t || T.R().sync.error, 5000, 'sync to start');
    await T.idle();
  },
  docs: () => T.R().state.docs.map((d) => ({ id: d.id, title: d.title, text: d.text, pinned: !!d.pinned })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  newNote: (text) => {
    T.$('newBtn').click();
    const ed = T.$('editor');
    ed.focus();
    ed.value = text;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    return T.R().state.current.id;
  },
  typeMore: (text) => {
    const ed = T.$('editor');
    ed.focus();
    ed.value += text;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  },
  done: () => { T.$('editor').blur(); T.$('modeBtn').click(); },
  open: (id) => { const b = document.querySelector('.doc-item[data-id="' + id + '"]'); if (!b) throw new Error('no item ' + id); b.click(); },
  connect: async (value) => {
    T.$('settingsBtn').click();
    T.$('syncInput').value = value;
    T.$('syncConnectBtn').click();
    await T.wait(() => !T.$('syncConnectBtn').disabled && (T.R().sync.cfg || !T.$('syncConfirm').hidden || T.$('syncSetupMsg').textContent), 15000, 'connect');
    if (T.R().sync.cfg) await T.idle();
  },
  closeSheets: () => document.querySelectorAll('dialog[open]').forEach((d) => d.close()),
  toast: () => (T.$('toast').hidden ? '' : T.$('toastMsg').textContent),
  backup: (ids) => ({ app: 'readout', version: 1, docs: T.R().state.docs.filter((d) => !ids || ids.includes(d.id)).map((d) => JSON.parse(JSON.stringify(d))), positions: [] }),
  importBackup: async (data) => {
    const input = T.$('backupInput');
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(data)], 'backup.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));
  },
};
true;
`;

async function newDevice(cdp, name, opts) {
  const browserContextId = opts.context || (await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  const logs = [];
  cdp.listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') logs.push({ type: msg.params.type, text: msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description)).join(' ') });
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push({ type: 'exception', text: (d.exception && d.exception.description) || d.text });
    }
  });
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setFocusEmulationEnabled', { enabled: true });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: `window.READOUT_CONFIG = { githubApi: ${JSON.stringify(opts.api)}, netWait: 4000, netStall: 2500 };` });
  if (opts.phone) {
    await s('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 3, mobile: true });
    await s('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
    await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  }
  const dev = {
    name,
    logs,
    context: browserContextId,
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${name}: ` + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async goto(url) {
      await s('Page.navigate', { url });
      for (let i = 0; i < 200; i++) {
        await sleep(50);
        try {
          if (await dev.eval('return !!(window.__readout && document.readyState === "complete")')) break;
        } catch (e) {
          /* still loading */
        }
      }
      await dev.eval(PAGE_HELPERS);
    },
    async screenshot(file) {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
  };
  return dev;
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
    const laptop = await newDevice(cdp, 'laptop', { api: gh.base });
    const phone = await newDevice(cdp, 'phone', { api: gh.base, phone: true });
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
    check(Object.keys(gh.readFiles(gistId)).every((n) => /^readout-(index|docs-[0-9a-f])\.json$/.test(n)), 'writes only Readout files');

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
    const tab2 = await newDevice(cdp, 'laptop tab 2', { api: gh.base, context: laptop.context });
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
    chrome.proc.kill();
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
