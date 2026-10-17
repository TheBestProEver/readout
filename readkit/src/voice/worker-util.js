// Helpers shared by the engine workers: loading model files (installed copy in OPFS, else
// the network), errors that survive postMessage, and a one-at-a-time job queue
// (an ORT session runs one inference at a time).
import { storedFile } from './opfs.js';

export function voiceError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

export function serializeError(e) {
  if (!e || typeof e !== 'object') return { name: 'Error', message: String(e), code: 'error' };
  return { name: e.name || 'Error', message: String(e.message || e), code: e.code || (e.name === 'AbortError' ? 'aborted' : 'error') };
}

// Bytes of one catalog file. source: 'auto' (OPFS when installed, else network),
// 'store' (installed copy only) or 'network'.
export async function loadFile(file, source, onProgress) {
  if (source !== 'network') {
    const f = await storedFile(file.name).catch(() => null);
    if (f) {
      onProgress && onProgress(f.size, f.size, 'opfs');
      return new Uint8Array(await f.arrayBuffer());
    }
    if (source === 'store') throw voiceError('not-installed', 'Voice file is not installed: ' + file.name);
  }
  const res = await fetch(file.url, { credentials: 'omit' });
  if (!res.ok) throw voiceError('network', `HTTP ${res.status} for ${file.url}`);
  const len = +res.headers.get('Content-Length') || file.bytes || 0;
  if (!res.body || !len) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress && onProgress(buf.length, buf.length, 'network');
    return buf;
  }
  // Preallocate so a 325 MB model is not held twice while it streams in.
  let out = new Uint8Array(len);
  let n = 0;
  const reader = res.body.getReader();
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, n + value.length));
      bigger.set(out.subarray(0, n));
      out = bigger;
    }
    out.set(value, n);
    n += value.length;
    const now = Date.now();
    if (onProgress && now - last > 200) {
      last = now;
      onProgress(n, len, 'network');
    }
  }
  onProgress && onProgress(n, len, 'network');
  if (file.bytes && n !== file.bytes) throw voiceError('network', `Expected ${file.bytes} bytes from ${file.url}, got ${n}`);
  return n === out.length ? out : out.subarray(0, n);
}

// Runs posted jobs one at a time; cancel(job) drops a queued job and makes isCancelled()
// true for a running one, which the engine checks between model calls.
export function jobQueue(handlers, post) {
  const queue = [];
  const cancelled = new Set();
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const m = queue.shift();
      if (cancelled.has(m.job)) {
        cancelled.delete(m.job);
        continue;
      }
      try {
        await handlers[m.type](m, () => cancelled.has(m.job));
      } catch (e) {
        if (!cancelled.has(m.job)) post({ type: 'error', job: m.job, error: serializeError(e) });
      }
      cancelled.delete(m.job);
    }
    busy = false;
  }
  return {
    push(m) {
      queue.push(m);
      pump();
    },
    cancel(job) {
      cancelled.add(job);
    },
  };
}
