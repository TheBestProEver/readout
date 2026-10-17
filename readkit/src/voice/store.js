// voiceStore: install, inspect and remove voices in OPFS. Downloads run in store.worker.js;
// status and remove are cheap OPFS calls done here. Files shared between voices (all
// Kokoro voices use one model) download once and are removed with the last voice using them.
import { voiceCatalog, voiceFiles, findVoice } from './catalog.js';
import { fileState, removeFile } from './opfs.js';
import { moduleWorker } from '../worker.js';

const inflight = new Map(); // file name -> { promise, waiters, job, listeners }
let worker = null;
let seq = 0;
const jobs = new Map();
let idleTimer = 0;

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function getWorker() {
  clearTimeout(idleTimer);
  if (worker) return worker;
  worker = moduleWorker(new URL('./store.worker.js', import.meta.url));
  worker.onmessage = (e) => {
    const m = e.data;
    const j = jobs.get(m.job);
    if (!j) return;
    if (m.type === 'progress') j.onProgress(m);
    else {
      jobs.delete(m.job);
      if (m.type === 'done') j.resolve(m);
      else {
        const err = m.error.code === 'aborted' || m.error.name === 'AbortError' ? abortError() : Object.assign(new Error(m.error.message), { code: m.error.code });
        j.reject(err);
      }
      idle();
    }
  };
  worker.onerror = (e) => {
    const err = new Error('Voice download worker failed: ' + (e.message || 'unknown error'));
    for (const j of jobs.values()) j.reject(err);
    jobs.clear();
    worker = null;
  };
  return worker;
}

// Free the worker a while after the last download.
function idle() {
  clearTimeout(idleTimer);
  if (jobs.size) return;
  idleTimer = setTimeout(() => {
    if (!jobs.size && worker) {
      worker.terminate();
      worker = null;
    }
  }, 10000);
}

// One download per file, however many installs wait on it; it is aborted only when
// every waiter has given up.
function ensureFile(file, onProgress, signal) {
  let f = inflight.get(file.name);
  if (!f) {
    const job = ++seq;
    f = { job, waiters: 0, listeners: new Set() };
    f.promise = new Promise((resolve, reject) => {
      jobs.set(job, { resolve, reject, onProgress: (p) => f.listeners.forEach((l) => l(p)) });
      getWorker().postMessage({ type: 'download', job, file: { name: file.name, url: file.url, bytes: file.bytes, sha256: file.sha256 } });
    }).finally(() => inflight.delete(file.name));
    inflight.set(file.name, f);
  }
  f.waiters++;
  f.listeners.add(onProgress);
  return new Promise((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return false;
      left = true;
      f.listeners.delete(onProgress);
      f.waiters--;
      if (signal) signal.removeEventListener('abort', onAbort);
      return true;
    };
    function onAbort() {
      if (!leave()) return;
      if (f.waiters === 0 && inflight.get(file.name) === f && worker) worker.postMessage({ type: 'abort', job: f.job });
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    f.promise.then(
      (r) => leave() && resolve(r),
      (e) => leave() && reject(e),
    );
  });
}

function known(id) {
  const v = findVoice(id);
  if (!v) throw Object.assign(new Error('Unknown voice: ' + id), { code: 'unknown-voice' });
  return v;
}

async function status(id) {
  const v = known(id);
  if (v.engine === 'system') return { installed: true, bytes: 0, total: 0, files: [], downloading: false };
  const files = voiceFiles(id);
  const states = await Promise.all(files.map((f) => fileState(f.name)));
  return {
    installed: states.every((s) => s.complete),
    bytes: states.reduce((n, s) => n + s.size, 0),
    total: files.reduce((n, f) => n + f.bytes, 0),
    files: files.map((f, i) => ({ name: f.name, role: f.role, bytes: states[i].size, total: f.bytes, complete: states[i].complete })),
    downloading: files.some((f) => inflight.has(f.name)),
  };
}

async function install(id, { signal, onProgress } = {}) {
  const v = known(id);
  if (signal && signal.aborted) throw abortError();
  if (v.engine === 'system') return { installed: true, bytes: 0, persisted: null };
  const files = voiceFiles(id);
  const states = await Promise.all(files.map((f) => fileState(f.name)));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const need = files.reduce((n, f, i) => n + (states[i].complete ? 0 : f.bytes - states[i].size), 0);
  let persisted = null;
  if (need > 0 && typeof navigator !== 'undefined' && navigator.storage) {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate().catch(() => null);
      if (est && est.quota && est.quota - est.usage < need) {
        throw Object.assign(new Error(`Not enough storage: ${Math.round(need / 1e6)} MB needed, ${Math.round((est.quota - est.usage) / 1e6)} MB free`), { name: 'QuotaExceededError', code: 'quota' });
      }
    }
    // persist() exists on the main thread only; ask before a large download so the
    // browser does not evict the model under storage pressure.
    if (navigator.storage.persist) persisted = await navigator.storage.persist().catch(() => false);
  }
  // Small files first, so the big one is the last thing a resume has to finish.
  const order = files.map((f, i) => i).sort((a, b) => files[a].bytes - files[b].bytes);
  const doneBytes = new Array(files.length).fill(0);
  const report = (stage, message) => {
    const done = doneBytes.reduce((n, b) => n + b, 0);
    if (onProgress) onProgress({ stage, done, total, message });
  };
  for (const i of order) {
    if (states[i].complete) {
      doneBytes[i] = files[i].bytes;
      continue;
    }
    await ensureFile(files[i], (p) => {
      doneBytes[i] = p.done;
      report(p.stage, p.message);
    }, signal);
    doneBytes[i] = files[i].bytes;
    report('download', 'Downloaded ' + files[i].role);
  }
  report('done', 'Installed');
  return { installed: true, bytes: total, persisted };
}

async function remove(id) {
  const v = known(id);
  if (v.engine === 'system') return { removed: [] };
  const mine = voiceFiles(id);
  // Files another installed (or installing) voice still uses are kept.
  const keep = new Set();
  for (const other of voiceCatalog) {
    if (other.id === id || other.engine !== v.engine) continue;
    const files = voiceFiles(other.id);
    const own = files.filter((f) => !mine.some((g) => g.name === f.name));
    if (!own.length) continue;
    const states = await Promise.all(own.map((f) => fileState(f.name)));
    if (states.some((s) => s.size > 0) || own.some((f) => inflight.has(f.name))) for (const f of files) keep.add(f.name);
  }
  const removed = [];
  for (const f of mine) {
    if (keep.has(f.name)) continue;
    const fl = inflight.get(f.name);
    if (fl && worker) {
      worker.postMessage({ type: 'abort', job: fl.job });
      await fl.promise.catch(() => {});
    }
    await removeFile(f.name);
    removed.push(f.name);
  }
  return { removed };
}

export const voiceStore = { status, install, remove };

// Lower-level: download one file spec { name, url, bytes, sha256 } into OPFS with the same
// streaming, resume and checks (used by tests, and by apps storing their own model files).
export function downloadFile(file, { signal, onProgress } = {}) {
  if (signal && signal.aborted) return Promise.reject(abortError());
  return ensureFile(file, (p) => onProgress && onProgress({ stage: p.stage, done: p.done, total: p.total, message: p.message }), signal);
}
