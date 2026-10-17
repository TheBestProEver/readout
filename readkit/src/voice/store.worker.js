// Downloads voice files into OPFS: streamed straight to disk through a sync access
// handle, hashed as it streams (sha256), resumed with HTTP Range after a dropped
// connection or a reload, and marked complete only after the hash matches.
// Never Cache Storage: a Cache.put of the 325 MB Kokoro model fails in Chrome.
//   in:  download { job, file: { name, url, bytes, sha256 } }, abort { job }
//   out: progress { job, done, total, stage, message }, done { job, bytes, sha256 }, error { job, error }
import { voicesDir, fileState, writeMarker } from './opfs.js';
import { createSha256 } from './sha256.js';
import { serializeError } from './worker-util.js';

const RETRIES = 6;
const controllers = new Map();
const post = (m) => self.postMessage(m);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'download') {
    const ac = new AbortController();
    controllers.set(m.job, ac);
    download(m.job, m.file, ac.signal)
      .then((r) => post({ type: 'done', job: m.job, ...r }), (err) => post({ type: 'error', job: m.job, error: serializeError(err) }))
      .finally(() => controllers.delete(m.job));
  } else if (m.type === 'abort') {
    const ac = controllers.get(m.job);
    if (ac) ac.abort();
  }
};

function fail(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

function abortError() {
  return new DOMException('Download aborted', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError());
    }, { once: true });
  });
}

async function download(job, file, signal) {
  const dir = await voicesDir(true);
  const st = await fileState(file.name);
  if (st.complete) return { bytes: st.size, sha256: st.marker.sha256, cached: true };
  // A stale marker (size mismatch) must not survive into a new download.
  try {
    await dir.removeEntry(file.name + '.ok');
  } catch (e) {
    /* none */
  }
  const handle = await dir.getFileHandle(file.name, { create: true });
  const access = await handle.createSyncAccessHandle();
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      access.close();
    }
  };
  try {
    let result = await fetchInto(job, file, access, signal);
    if (file.sha256 && result.sha256 !== file.sha256) {
      // A resumed partial may hold bytes from a crash mid-write: retry once from zero.
      access.truncate(0);
      access.flush();
      if (result.resumed) result = await fetchInto(job, file, access, signal);
      if (result.sha256 !== file.sha256) {
        access.truncate(0);
        access.flush();
        close();
        await dir.removeEntry(file.name).catch(() => {});
        throw fail('sha256-mismatch', `Checksum mismatch for ${file.name}: got ${result.sha256}`);
      }
    }
    access.flush();
    close();
    await writeMarker(dir, file.name, { bytes: result.bytes, sha256: result.sha256, url: file.url, at: Date.now() });
    return { bytes: result.bytes, sha256: result.sha256, resumed: result.resumed, requests: result.requests };
  } finally {
    try {
      access.flush();
    } catch (e) {
      /* closed */
    }
    close();
  }
}

async function fetchInto(job, file, access, signal) {
  let pos = access.getSize();
  if (file.bytes && pos > file.bytes) {
    access.truncate(0);
    pos = 0;
  }
  let hasher = createSha256();
  const resumed = pos > 0;
  let total = file.bytes || 0;
  let last = 0;
  const report = (stage, message, force) => {
    const now = Date.now();
    if (!force && now - last < 150) return;
    last = now;
    post({ type: 'progress', job, done: pos, total, stage, message });
  };
  if (pos > 0) {
    // Resume: hash what is already on disk first (the hash cannot be saved mid-stream).
    const buf = new Uint8Array(8 << 20);
    for (let at = 0; at < pos; ) {
      if (signal.aborted) throw abortError();
      const n = access.read(buf.subarray(0, Math.min(buf.length, pos - at)), { at });
      if (n <= 0) {
        pos = at;
        access.truncate(pos);
        break;
      }
      hasher.update(buf.subarray(0, n));
      at += n;
    }
    report('verify', 'Checked the partial download', true);
  }
  let attempts = 0;
  let requests = 0;
  const restart = () => {
    access.truncate(0);
    pos = 0;
    hasher = createSha256();
  };
  while (!(file.bytes && pos === file.bytes)) {
    if (signal.aborted) throw abortError();
    try {
      requests++;
      const res = await fetch(file.url, { headers: pos ? { Range: `bytes=${pos}-` } : {}, signal, credentials: 'omit', cache: 'no-store' });
      if (res.status === 416 && pos) {
        if (!file.bytes) break; // size unknown: the partial was already complete
        restart();
        continue;
      }
      if (!res.ok) throw fail('http', `HTTP ${res.status} for ${file.url}`, { status: res.status });
      if (res.status === 206) {
        const raw = res.headers.get('Content-Range');
        const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(raw || '');
        // A cross-origin mirror may not expose Content-Range (Hugging Face does, with
        // expose-headers *); Content-Length is always readable, so a body of exactly the
        // missing bytes is accepted as the requested range.
        const len = +res.headers.get('Content-Length');
        const blindOk = !raw && file.bytes && len === file.bytes - pos;
        if (!blindOk && (!cr || +cr[1] !== pos)) {
          await res.body.cancel().catch(() => {});
          restart();
          continue;
        }
        if (cr && cr[3] !== '*') total = +cr[3];
      } else {
        if (pos) restart(); // the server ignored Range: start over
        const len = +res.headers.get('Content-Length');
        if (len && !res.headers.get('Content-Encoding')) total = len;
      }
      if (file.bytes && total && total !== file.bytes) throw fail('size-mismatch', `${file.url} is ${total} bytes, expected ${file.bytes}`);
      report('download', 'Downloading', true);
      const reader = res.body.getReader();
      let sinceFlush = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.length) off += access.write(value.subarray(off), { at: pos + off });
        hasher.update(value);
        pos += value.length;
        sinceFlush += value.length;
        if (sinceFlush > 32 << 20) {
          access.flush();
          sinceFlush = 0;
        }
        attempts = 0;
        report('download', 'Downloading');
      }
      access.flush();
      if (!total || pos >= total) break;
      throw fail('network', 'Connection closed early');
    } catch (e) {
      access.flush();
      if (signal.aborted || (e && e.name === 'AbortError')) throw abortError();
      if (e.code === 'size-mismatch' || (e.code === 'http' && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
      if (++attempts > RETRIES) throw e;
      report('retry', `Connection lost, retrying (${attempts}/${RETRIES})`, true);
      await sleep(Math.min(500 * 2 ** (attempts - 1), 15000), signal);
    }
  }
  if (file.bytes && pos !== file.bytes) throw fail('size-mismatch', `Downloaded ${pos} bytes, expected ${file.bytes}`);
  report('verify', 'Verifying', true);
  return { bytes: pos, sha256: hasher.digest(), resumed, requests };
}
