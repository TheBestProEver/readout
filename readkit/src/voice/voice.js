// Voices: the catalog, the OPFS model store, and createVoice(), which runs an engine in a
// module worker and turns consecutive segments into one PCM buffer with sample-accurate
// segment marks and (Kokoro) word timings.
import { config } from '../config.js';
import { voiceCatalog, voiceFiles, findVoice, defaultVoice, fallbackVoice, DEFAULT_VOICE } from './catalog.js';
import { voiceStore } from './store.js';
import { createSystemVoice, systemVoices } from './system.js';
import { judge, cacheKey, readCache, writeCache, HF_REFERENCE } from './calibrate.js';
import { concat } from './pcm.js';
import { moduleWorker } from '../worker.js';

export { voiceCatalog, voiceStore, systemVoices, voiceFiles, findVoice, defaultVoice, fallbackVoice, DEFAULT_VOICE };

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function toError(e) {
  if (e && (e.code === 'aborted' || e.name === 'AbortError')) return abortError();
  return Object.assign(new Error((e && e.message) || 'Voice error'), { code: (e && e.code) || 'error' });
}

// Only what the engine needs crosses into the worker.
function slim(seg, i) {
  return {
    index: Number.isInteger(seg.index) ? seg.index : i,
    spoken: String(seg.spoken == null ? seg.text || '' : seg.spoken),
    pauseAfterMs: Math.max(0, +seg.pauseAfterMs || 0),
    align: Array.isArray(seg.align) ? seg.align.map((a) => [a[0], a[1]]) : null,
    phonemes: typeof seg.phonemes === 'string' ? seg.phonemes : undefined,
  };
}

// opts: { id, onProgress, signal, source: 'auto' | 'store' | 'network', phonemizer: 'auto' |
// 'g2p' | 'espeak' | 'none', threads (Piper), device (Kokoro: 'webgpu', or 'wasm' for
// reference renders only; slower than real time) }. source 'auto' reads an installed copy
// from OPFS and otherwise streams the model from the network without storing it.
export async function createVoice(opts = {}) {
  const id = opts.id || DEFAULT_VOICE;
  const entry = findVoice(id);
  if (!entry) throw Object.assign(new Error('Unknown voice: ' + id), { code: 'unknown-voice' });
  if (entry.engine === 'system') return createSystemVoice(entry);
  const { onProgress, signal } = opts;
  if (signal && signal.aborted) throw abortError();

  const worker = entry.engine === 'kokoro'
    ? moduleWorker(new URL('./kokoro.worker.js', import.meta.url))
    : moduleWorker(new URL('./piper.worker.js', import.meta.url));
  const pending = new Map();
  let seq = 0;
  let dead = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const kill = (err) => {
    if (dead) return;
    dead = err;
    worker.terminate();
    readyReject(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (onProgress) onProgress(m.p);
      return;
    }
    if (m.type === 'ready') return readyResolve(m);
    if (m.type === 'error' && m.job === 0) return kill(toError(m.error));
    const p = pending.get(m.job);
    if (!p) return;
    if (m.type === 'chunk') return p.chunk(m);
    pending.delete(m.job);
    if (m.type === 'done' || m.type === 'calibrated') p.resolve(m);
    else if (m.type === 'error') p.reject(toError(m.error));
  };
  worker.onerror = (e) => {
    if (e.preventDefault) e.preventDefault();
    kill(Object.assign(new Error('Voice worker crashed: ' + (e.message || 'unknown error')), { code: 'worker-crashed' }));
  };
  const onAbortLoad = () => kill(abortError());
  if (signal) signal.addEventListener('abort', onAbortLoad, { once: true });

  worker.postMessage({
    type: 'init',
    config: JSON.parse(JSON.stringify(config)),
    voice: { id, engine: entry.engine, dialect: entry.dialect },
    files: voiceFiles(id),
    source: opts.source || 'auto',
    phonemizer: opts.phonemizer || 'auto',
    threads: opts.threads || 0,
    device: opts.device || 'webgpu',
  });
  let info;
  try {
    info = await ready;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbortLoad);
  }
  const sampleRate = info.sampleRate;

  function request(msg, handlers = {}) {
    if (dead) return Promise.reject(dead);
    const job = ++seq;
    return new Promise((resolve, reject) => {
      const { signal: sig } = handlers;
      const onAbort = () => {
        if (!pending.has(job)) return;
        pending.delete(job);
        worker.postMessage({ type: 'cancel', job });
        reject(abortError());
      };
      if (sig) {
        if (sig.aborted) return reject(abortError());
        sig.addEventListener('abort', onAbort, { once: true });
      }
      const cleanup = () => sig && sig.removeEventListener('abort', onAbort);
      pending.set(job, {
        chunk: handlers.chunk || (() => {}),
        resolve: (m) => {
          cleanup();
          resolve(m);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      worker.postMessage({ ...msg, job });
    });
  }

  const voice = {
    id,
    engine: entry.engine,
    dialect: entry.dialect,
    sampleRate,
    device: info.device,
    info: {
      adapter: info.adapter,
      deviceKey: info.deviceKey,
      threads: info.threads,
      phonemizer: info.phonemizer,
      hasDurations: info.hasDurations,
      loadMs: info.loadMs,
      warmupMs: info.warmupMs,
      crossOriginIsolated: typeof self !== 'undefined' && !!self.crossOriginIsolated,
    },

    // { ok, rt, device, reason, message, cached, stats }; rt is audio seconds per compute
    // second at speed 1. opts: { speed (the listening speed to judge for), force, signal }.
    async calibrate(o = {}) {
      const speed = +o.speed || 1;
      const key = cacheKey(entry.engine, info.deviceKey);
      const test = o._corrupt || null;
      let stats = !o.force && !test ? readCache(key) : null;
      const cached = !!stats;
      if (!stats) {
        const m = await request({ type: 'calibrate', corrupt: test }, { signal: o.signal });
        stats = { ...m.stats, voice: id, device: info.device, at: Date.now() };
        if (!test) writeCache(key, stats);
      }
      // The spectrum reference belongs to the voice that rendered the cached sentence.
      const hfRef = entry.engine === 'kokoro' && HF_REFERENCE[stats.voice] != null ? HF_REFERENCE[stats.voice] : null;
      const v = judge(stats, { speed, hfRef });
      return { ok: v.ok, rt: v.rt, device: info.device, reason: v.reason, message: v.message, cached, stats };
    },

    // segments: consecutive Segment[]; opts: { speed, signal, onChunk, fastStart }.
    // onChunk({ sampleRate, start, pcm, marks, words }) streams audio as each model call
    // finishes (a copy; positions are relative to the whole result). fastStart (default:
    // on when streaming) makes the first call 40-60 tokens so audio starts sooner.
    async synth(segments, o = {}) {
      const list = Array.from(segments || [], slim);
      const speed = +o.speed || 1;
      if (!list.length) return { sampleRate, pcm: new Float32Array(0), marks: [], words: info.hasDurations || entry.engine === 'piper' ? [] : null, wordsEstimated: entry.engine === 'piper', speed, stats: { audioS: 0, computeMs: 0, rt: 0, calls: 0, speed } };
      const streaming = typeof o.onChunk === 'function';
      const chunks = [];
      const marks = [];
      const words = [];
      const m = await request(
        { type: 'synth', segments: list, speed, stream: streaming, fastStart: o.fastStart === undefined ? streaming : !!o.fastStart },
        {
          signal: o.signal,
          chunk: (c) => {
            chunks.push(c.pcm);
            marks.push(...c.marks);
            if (c.words) words.push(...c.words);
            try {
              o.onChunk({ sampleRate, start: c.start, pcm: c.pcm.slice(), marks: c.marks, words: c.words || null });
            } catch (e) {
              /* a listener's bug must not break synthesis */
            }
          },
        },
      );
      const pcm = streaming ? concat(chunks) : m.pcm;
      marks.push(...m.marks);
      if (m.words) words.push(...m.words);
      return {
        sampleRate: m.sampleRate,
        pcm,
        marks,
        words: m.words === null ? null : words,
        wordsEstimated: entry.engine === 'piper',
        // The speed the audio was generated at (engines clamp it); a player covers the rest
        // with playbackRate = requested / speed.
        speed: m.stats.speed,
        stats: m.stats,
      };
    },

    dispose() {
      kill(abortError());
    },
  };
  return voice;
}
