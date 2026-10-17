// Piper medium (VITS) voices on onnxruntime-web 1.30.0 WASM, threaded when the page is
// cross-origin isolated. Phonemes come from readkit's g2p (espeak IPA with heteronym
// fixes) when it loads, otherwise from piper_phonemize (espeak-ng, GPL, loaded at runtime
// from config.piperPhonemize), created once per worker. Same private protocol as
// kokoro.worker.js. Piper has no durations, so word times are spread by character share.
import { configure, config } from '../config.js';
import { ipaToSentences, sentenceIds, splitPhonemizeIds, splitLongIds } from './piper-text.js';
import { levels, sanitize, voicedRange, quietEdges, fadeOut, msToSamples, concat, gapSamples, SENTENCE_GAP_MS } from './pcm.js';
import { spokenWords, alignEntries, charShareTimes } from './words.js';
import { CALIBRATION, renderStats, corrupt } from './calibrate.js';
import { loadFile, voiceError, serializeError, jobQueue } from './worker-util.js';

let ort = null;
let session = null;
let cfg = null;
let SR = 22050;
let dialect = 'en-US';
let g2p = null;
let phonemize = null;
let phonemizer = null;
let threads = 1;
// Silence a listener hears between two sentences (the voice's own tail + inserted silence
// + the next sentence's lead), at speed 1. Piper's CLI adds a fixed 0.2 s on top of the
// voice's tail, which gave 210-370 ms with ryan (rushed) and 400-600 ms with hfc_male, and
// paragraph breaks of 1.1-1.2 s once plan()'s 700 ms was added as well. Kokoro's own
// sentence pause is 550-700 ms. Planned pauses follow the shared rule in pcm.js
// (gapSamples): paragraph breaks ~1.1 s, headings ~0.93 s, list items ~0.8 s, as with Kokoro.
// Between the pieces of one sentence too long for a single call (cut at a word break).
const CLAUSE_GAP_MS = 120;
// Typical leading silence of this voice's sentences, for the gap after a segment (the
// next segment is not rendered yet). Measured on the warm-up render, then tracked.
let leadEst = 0;

const post = (m, transfer) => self.postMessage(m, transfer || []);
const progress = (stage, done, total, message) => post({ type: 'progress', p: { stage, done, total, message } });
const queue = jobQueue({ synth: synthJob, calibrate: calibrateJob }, post);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m).then((r) => post({ type: 'ready', ...r }), (err) => post({ type: 'error', job: 0, error: serializeError(err) }));
  else if (m.type === 'cancel') queue.cancel(m.job);
  else queue.push(m);
};

// piper_phonemize is a classic Emscripten script, not a module: evaluate it once, keep
// the instance, and call its main() per text (runtime stays alive between calls).
async function createPiperPhonemize(base) {
  const res = await fetch(base + 'piper_phonemize.js', { credentials: 'omit' });
  if (!res.ok) throw voiceError('network', `HTTP ${res.status} for piper_phonemize.js`);
  const factory = new Function(await res.text() + '\n;return createPiperPhonemize;')();
  let printed = [];
  const errors = [];
  const mod = await factory({
    print: (s) => printed.push(s),
    printErr: (s) => errors.push(s),
    locateFile: (f) => base + f,
  });
  return (text, voice) => {
    printed = [];
    errors.length = 0;
    mod.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    const line = printed.find((s) => s.startsWith('{'));
    if (!line) throw voiceError('phonemizer', 'piper_phonemize gave no output' + (errors.length ? ': ' + errors.join(' ') : ''));
    return JSON.parse(line);
  };
}

// piper_phonemize is created at most once per worker: up front when g2p is unavailable,
// otherwise on demand the first time g2p cannot phonemize a segment.
let phonemizeLoading = null;
function getPhonemize() {
  if (!phonemizeLoading) {
    phonemizeLoading = createPiperPhonemize(config.piperPhonemize).then((f) => (phonemize = f));
    phonemizeLoading.catch(() => (phonemizeLoading = null));
  }
  return phonemizeLoading;
}

async function initPhonemes(mode) {
  if (mode === 'none') return;
  if (mode !== 'espeak') {
    try {
      const mod = await import('../g2p/g2p.js');
      // IPA only: Piper does not need the Kokoro lexicon (5 MB) in this worker.
      g2p = await mod.createG2P({ dialect, need: 'ipa' });
      if (typeof g2p.ipa !== 'function') throw new Error('g2p has no ipa()');
      phonemizer = 'g2p';
      return;
    } catch (e) {
      g2p = null;
      if (mode === 'g2p') throw voiceError('no-g2p', 'g2p failed to load: ' + (e && e.message));
    }
  }
  try {
    await getPhonemize();
  } catch (e) {
    throw voiceError('no-phonemizer', 'piper_phonemize failed to load: ' + ((e && e.message) || e), e);
  }
  phonemizer = 'piper_phonemize';
}

async function init(m) {
  configure(m.config);
  dialect = m.voice.dialect;
  const t0 = performance.now();
  const modelFile = m.files.find((f) => f.role === 'model');
  const cfgFile = m.files.find((f) => f.role === 'config');
  const phon = initPhonemes(m.phonemizer || 'auto').catch((e) => e);
  const [cfgBytes, modelBytes] = await Promise.all([
    loadFile(cfgFile, m.source),
    loadFile(modelFile, m.source, (done, total, from) => progress('download', done, total, from === 'opfs' ? 'Reading the voice model' : 'Downloading the voice model')),
  ]);
  cfg = JSON.parse(new TextDecoder().decode(cfgBytes));
  SR = (cfg.audio && cfg.audio.sample_rate) || 22050;
  if (!cfg.phoneme_id_map) throw voiceError('bad-file', 'Piper config has no phoneme_id_map');

  progress('load', 0, 1, 'Starting the voice engine');
  ort = await import(config.ort + 'ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = config.ort;
  const hc = (self.navigator && navigator.hardwareConcurrency) || 2;
  threads = m.threads ? Math.max(1, m.threads | 0) : self.crossOriginIsolated ? Math.max(1, Math.min(4, hc - 1)) : 1;
  if (!self.crossOriginIsolated) threads = 1;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  const loadMs = performance.now() - t0;
  const phonError = await phon;
  if (phonError instanceof Error) throw phonError;

  progress('warmup', 0, 1, 'Preparing the voice');
  const t1 = performance.now();
  const warm = await run(sentenceIds(CALIBRATION.warmup, cfg.phoneme_id_map).ids, 1);
  const warmupMs = performance.now() - t1;
  sanitize(warm);
  leadEst = Math.min(quietEdges(warm, SR).lead, Math.round(0.3 * SR));
  progress('warmup', 1, 1, 'Voice ready');
  return {
    sampleRate: SR,
    device: 'wasm',
    adapter: null,
    deviceKey: `wasm/${threads}t/${hc}c`,
    threads,
    hasDurations: false,
    phonemizer,
    espeakVoice: (cfg.espeak && cfg.espeak.voice) || null,
    loadMs: Math.round(loadMs),
    warmupMs: Math.round(warmupMs),
  };
}

async function run(ids, speed) {
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([ids.length], BigInt), [1]),
    scales: new ort.Tensor('float32', new Float32Array([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3]),
  };
  if ((cfg.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  let out;
  try {
    out = await session.run(feeds);
  } catch (e) {
    throw voiceError('engine', 'Piper inference failed: ' + ((e && e.message) || e), e);
  }
  const t = out.output || out[session.outputNames[0]];
  const wav = new Float32Array(t.data);
  for (const x of Object.values(out)) if (x && x.dispose) x.dispose();
  return wav;
}

// Per-sentence ids for a segment.
async function sentencesOf(seg) {
  const map = cfg.phoneme_id_map;
  if (typeof seg.phonemes === 'string') return ipaToSentences(seg.phonemes, map).sentences;
  const text = String(seg.spoken || '').trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return [];
  if (g2p) {
    try {
      const r = ipaToSentences(await g2p.ipa(text), map);
      // Mostly unknown symbols means the IPA does not suit this voice; let espeak do it.
      if (r.kept && r.missing <= r.kept * 0.2) return r.sentences;
    } catch (e) {
      /* fall through to piper_phonemize */
    }
  }
  if (!phonemize) {
    try {
      await getPhonemize();
    } catch (e) {
      throw voiceError('no-phonemizer', 'No phonemizer could read: ' + text.slice(0, 40) + ' (' + ((e && e.message) || e) + ')', e);
    }
  }
  const voice = (cfg.espeak && cfg.espeak.voice) || (dialect === 'en-GB' ? 'en-gb-x-rp' : 'en-us');
  return splitPhonemizeIds(phonemize(text, voice).phoneme_ids, map);
}

async function synthJob(m, isCancelled) {
  const speed = Math.min(2.5, Math.max(0.5, +m.speed || 1));
  const t0 = performance.now();
  const sentenceGap = msToSamples(SENTENCE_GAP_MS / speed, SR);
  const clauseGap = msToSamples(CLAUSE_GAP_MS / speed, SR);
  const fade = Math.round(0.004 * SR);
  let outPos = 0;
  let parts = [];
  let marks = [];
  let words = [];
  let computeMs = 0;
  let nSentences = 0;
  const emit = () => {
    if (!m.stream || (!parts.length && !marks.length)) return;
    const pcm = concat(parts);
    post({ type: 'chunk', job: m.job, start: outPos - pcm.length, pcm, marks, words }, [pcm.buffer]);
    parts = [];
    marks = [];
    words = [];
  };
  for (const seg of m.segments) {
    if (isCancelled()) return;
    const start = outPos;
    const pieces = [];
    let prevTail = 0;
    for (const ids of await sentencesOf(seg)) {
      const split = splitLongIds(ids, cfg.phoneme_id_map);
      for (let k = 0; k < split.length; k++) {
        const tc = performance.now();
        const wav = await run(split[k], speed);
        computeMs += performance.now() - tc;
        if (isCancelled()) return;
        const lv = levels(wav);
        if (lv.nan > wav.length * 0.001) throw voiceError('bad-output', `Piper returned ${lv.nan} NaN samples`);
        sanitize(wav);
        const edges = quietEdges(wav, SR);
        if (edges.lead < wav.length) leadEst = Math.round(0.7 * leadEst + 0.3 * Math.min(edges.lead, Math.round(0.3 * SR)));
        if (pieces.length) pieces.push(new Float32Array(gapSamples({ tail: prevTail, lead: edges.lead, target: k ? clauseGap : sentenceGap })));
        pieces.push(wav);
        prevTail = edges.tail;
        nSentences++;
      }
    }
    const speech = concat(pieces);
    if (speech.length) {
      const [vs, ve] = voicedRange(speech, 0.01);
      const spoken = String(seg.spoken || '');
      const sw = spokenWords(spoken);
      const at = charShareTimes(spoken, vs, ve);
      for (const e of alignEntries(seg, sw)) {
        const s0 = Math.round(at(sw[e.from].start));
        words.push({ index: seg.index, alignIndex: e.alignIndex, start: start + s0, end: start + Math.max(s0, Math.round(at(sw[e.to - 1].end))) });
      }
    }
    const planned = msToSamples(seg.pauseAfterMs, SR);
    const pauseN = speech.length ? gapSamples({ tail: prevTail, lead: leadEst, target: sentenceGap, planned }) : planned;
    if (pauseN && speech.length) {
      fadeOut(speech, speech.length, fade);
    }
    if (speech.length) {
      parts.push(speech);
      outPos += speech.length;
    }
    if (pauseN) {
      parts.push(new Float32Array(pauseN));
      outPos += pauseN;
    }
    marks.push({ index: seg.index, start, end: outPos });
    emit();
  }
  const pcm = m.stream ? null : concat(parts);
  const audioS = outPos / SR;
  const stats = { computeMs: Math.round(computeMs), totalMs: Math.round(performance.now() - t0), audioS, rt: computeMs ? audioS / (computeMs / 1000) : 0, calls: nSentences, speed };
  post({ type: 'done', job: m.job, sampleRate: SR, length: outPos, pcm, marks, words, stats }, pcm ? [pcm.buffer] : []);
}

async function calibrateJob(m) {
  const ids = sentenceIds(CALIBRATION.phonemes, cfg.phoneme_id_map).ids;
  const t0 = performance.now();
  await run(ids, 1);
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  const wav = await run(ids, 1);
  const ms = performance.now() - t1;
  corrupt(wav, m.corrupt);
  const stats = renderStats(wav, SR, ms);
  post({ type: 'calibrated', job: m.job, stats: { ...stats, firstMs: Math.round(firstMs), tokens: ids.length } });
}
