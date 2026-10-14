// Shared helpers for the browser tests: a static server for the app, and Chrome
// driven over the DevTools protocol with no dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function checker() {
  const c = { checks: 0, failures: 0 };
  c.check = (ok, what, detail) => {
    c.checks++;
    if (ok) console.log('  ok  ' + what);
    else {
      c.failures++;
      console.log('  FAIL ' + what + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : ''));
    }
  };
  return c;
}

/* ---------- static server for the app ---------- */

export function staticServer() {
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

export function findChrome() {
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

export async function launchChrome() {
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

export function connect(url) {
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
export const PAGE_HELPERS = `
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

// opts: { config (window.READOUT_CONFIG), phone, context (share a browser profile) }
export async function newDevice(cdp, name, opts) {
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
  await s('Page.addScriptToEvaluateOnNewDocument', { source: `window.READOUT_CONFIG = ${JSON.stringify(opts.config || {})};` });
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
