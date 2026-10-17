// Kokoro-82M on onnxruntime-web 1.30.0, WebGPU, fp32 only (fp16 gives NaN and q8/q4 are
// unintelligible on WebGPU). The timestamped export returns per-token durations, which
// place every segment and word in the audio. Private protocol with voice.js:
//   in:  init, synth { job, segments, speed, fastStart, stream }, calibrate { job, corrupt }, cancel { job }
//   out: progress, ready, chunk, done, calibrated, error
import { configure, config } from '../config.js';
import { prepareSegments, groupUnits, callIds, tokenPositions, posAt, trimBounds, quietCut, styleRow, tokenize, SAMPLE_RATE, STYLE_DIM, STYLE_ROWS, MAX_TOKENS, STEP_SAMPLES } from './kokoro-text.js';
import { levels, sanitize, fadeIn, fadeOut, msToSamples, concat, quietEdges, gapSamples, SENTENCE_GAP_MS } from './pcm.js';
import { CALIBRATION, renderStats, corrupt } from './calibrate.js';
import { espeakKokoro, loadPhonemizer } from './espeak.js';
import { loadFile, voiceError, serializeError, jobQueue } from './worker-util.js';

const SR = SAMPLE_RATE;
const FADE = Math.round(0.004 * SR);
let ort = null;
let session = null;
let style = null;
let dialect = 'en-US';
let hasDurations = false;
let g2p = null;
let espeak = null;
let phonemizer = null;
let device = 'webgpu';
// Typical silence before a segment's first sound (for the pause after a segment, before the
// next one is rendered): a few ms inside a call, ~50 ms at a call's trimmed start. Tracked.
let leadEst = Math.round(0.03 * SR);
let threads = 1;
let lost = null;

const post = (m, transfer) => self.postMessage(m, transfer || []);
const progress = (stage, done, total, message) => post({ type: 'progress', p: { stage, done, total, message } });

const queue = jobQueue({ synth: synthJob, calibrate: calibrateJob }, post);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m).then((r) => post({ type: 'ready', ...r }), (err) => post({ type: 'error', job: 0, error: serializeError(err) }));
  else if (m.type === 'cancel') queue.cancel(m.job);
  else queue.push(m);
};

async function initPhonemes(mode) {
  if (mode === 'none') return;
  if (mode !== 'espeak') {
    try {
      const mod = await import('../g2p/g2p.js');
      g2p = await mod.createG2P({ dialect });
      phonemizer = 'g2p';
      return;
    } catch (e) {
      if (mode === 'g2p') throw voiceError('no-g2p', 'g2p failed to load: ' + (e && e.message));
    }
  }
  try {
    espeak = await loadPhonemizer(config.phonemizer);
    phonemizer = 'espeak';
  } catch (e) {
    // Segments that carry their own phonemes still work.
    phonemizer = null;
  }
}

async function init(m) {
  configure(m.config);
  dialect = m.voice.dialect;
  const t0 = performance.now();
  // 'wasm' is an explicit opt-in for reference renders and tests: fp32 on the CPU is
  // slower than real time (0.3-0.7x), so it is never chosen automatically.
  device = m.device === 'wasm' ? 'wasm' : 'webgpu';
  let adapter = null;
  let info = null;
  if (device === 'webgpu') {
    if (!self.navigator || !navigator.gpu) throw voiceError('no-webgpu', 'WebGPU is not available in this browser');
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw voiceError('no-webgpu', 'No WebGPU adapter');
    const ai = adapter.info || {};
    info = { vendor: ai.vendor || '', architecture: ai.architecture || '', device: ai.device || '', description: ai.description || '' };
  }
  const phon = initPhonemes(m.phonemizer || 'auto').catch((e) => e);

  const model = m.files.find((f) => f.role === 'model');
  const voiceFile = m.files.find((f) => f.role === 'voice');
  const [modelBytes, voiceBytes] = await Promise.all([
    loadFile(model, m.source, (done, total, from) => progress('download', done, total, from === 'opfs' ? 'Reading the voice model' : 'Downloading the voice model')),
    loadFile(voiceFile, m.source),
  ]);
  if (voiceBytes.byteLength !== STYLE_ROWS * STYLE_DIM * 4) throw voiceError('bad-file', 'Unexpected voice file size ' + voiceBytes.byteLength);
  style = new Float32Array(voiceBytes.buffer, voiceBytes.byteOffset, voiceBytes.byteLength / 4).slice();

  progress('load', 0, 1, 'Starting the voice engine');
  ort = await import(config.ort + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = config.ort;
  // On WebGPU the GPU does the work; more CPU threads measured slower (0.5-0.9x vs 2.1-2.6x).
  const hc = (self.navigator && navigator.hardwareConcurrency) || 2;
  threads = device === 'wasm' && self.crossOriginIsolated ? Math.max(1, Math.min(4, hc - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  // Hand ORT the adapter we asked for, so calibration is keyed to the GPU that runs the model.
  if (adapter) ort.env.webgpu.adapter = adapter;
  try {
    // logSeverityLevel 3: ORT's session warnings ("some nodes were not assigned to the
    // preferred execution providers", expected for shape ops) would print as console errors
    session = await ort.InferenceSession.create(modelBytes, { executionProviders: [device], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  } catch (e) {
    throw voiceError(device === 'webgpu' ? 'no-webgpu' : 'engine', 'Kokoro failed to start: ' + ((e && e.message) || e), e);
  }
  hasDurations = session.outputNames.includes('durations');
  if (device === 'webgpu') {
    // A lost GPU device (driver reset, memory pressure, tab in the background on some
    // phones) makes every later call fail; remember it so synth fails fast and clearly.
    const dev = ort.env.webgpu.device;
    if (dev && dev.lost) dev.lost.then((i) => (lost = (i && i.message) || 'GPU device lost'));
  }
  const loadMs = performance.now() - t0;

  // The first WebGPU call compiles shaders (10-27 s); do it now, not on the first sentence.
  progress('warmup', 0, 1, 'Preparing the voice');
  const t1 = performance.now();
  const w = tokenize(CALIBRATION.warmup).ids;
  await run([0, ...w, 0], 1);
  const warmupMs = performance.now() - t1;
  const phonError = await phon;
  if (phonError instanceof Error) throw phonError;
  progress('warmup', 1, 1, 'Voice ready');
  return {
    sampleRate: SR,
    device,
    adapter: info,
    deviceKey: info ? ['webgpu', info.vendor, info.architecture, info.device, info.description].join('/') : `wasm/${threads}t/${hc}c`,
    threads,
    hasDurations,
    phonemizer,
    loadMs: Math.round(loadMs),
    warmupMs: Math.round(warmupMs),
  };
}

async function run(ids, speed) {
  if (lost) throw voiceError('device-lost', 'Kokoro cannot continue: ' + lost);
  const n = ids.length;
  if (n > MAX_TOKENS) throw voiceError('too-long', `Kokoro call of ${n} tokens (max ${MAX_TOKENS})`);
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, n]),
    style: new ort.Tensor('float32', styleRow(style, n).slice(), [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
  };
  let out;
  try {
    out = await session.run(feeds);
  } catch (e) {
    const msg = String((e && e.message) || e);
    throw voiceError(lost || /device (?:was |is )?lost|lost device|devicelost/i.test(msg) ? 'device-lost' : 'engine', 'Kokoro inference failed: ' + msg, e);
  }
  const wav = new Float32Array(out.waveform.data);
  const dur = out.durations ? Float64Array.from(out.durations.data, Number) : null;
  for (const t of Object.values(out)) if (t && t.dispose) t.dispose();
  return { wav, dur };
}

async function phonemesOf(seg) {
  if (typeof seg.phonemes === 'string') return seg.phonemes;
  const text = String(seg.spoken || '').trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return '';
  if (g2p) {
    try {
      return await g2p.kokoro(text);
    } catch (e) {
      if (!espeak) throw e;
    }
  }
  if (espeak) return espeakKokoro(text, espeak, dialect);
  throw voiceError('no-phonemizer', 'No phonemizer available (g2p and espeak both failed to load)');
}

// One model call: checks the output, then cuts it into per-unit pieces in the silence
// around the space token between units.
async function synthCall(call, speed) {
  const { ids, starts } = callIds(call);
  const { wav, dur } = await run(ids, speed);
  const lv = levels(wav);
  if (lv.nan > wav.length * 0.001) throw voiceError('bad-output', `Kokoro returned ${lv.nan} NaN samples (GPU numerics)`);
  sanitize(wav);
  if (ids.length > 12 && lv.rms < 0.003) throw voiceError('bad-output', 'Kokoro returned silence');
  if (lv.rms > 0.5) throw voiceError('bad-output', 'Kokoro returned noise (RMS ' + lv.rms.toFixed(2) + ')');
  let cum;
  let exact = false;
  if (dur && dur.length === ids.length) {
    const tp = tokenPositions(dur, wav.length);
    cum = tp.cum;
    exact = tp.exact;
  } else {
    cum = new Float64Array(ids.length + 1);
    for (let i = 0; i <= ids.length; i++) cum[i] = (wav.length * i) / ids.length;
  }
  const bounds = trimBounds(wav, cum, SR);
  const pieces = call.units.map((u, k) => {
    const from = k === 0 ? bounds.start : quietCut(wav, cum, starts[k] - 1, SR);
    const to = k === call.units.length - 1 ? bounds.end : quietCut(wav, cum, starts[k] + u.ids.length, SR);
    return { u, pcm: wav.subarray(from, Math.max(from, to)), callFrom: from, callIdx: starts[k], cum };
  });
  return { pieces, exact, samples: wav.length };
}

// Sample position (job-absolute) of a fractional segment token index.
function segSample(s, x, isEnd) {
  const units = s.units;
  let u = null;
  if (isEnd) {
    for (let i = units.length - 1; i >= 0; i--) if (units[i].from < x) { u = units[i]; break; }
    u = u || units[0];
  } else {
    u = units.find((v) => v.to > x) || units[units.length - 1];
  }
  const xc = Math.max(u.from, Math.min(u.to, x));
  const p = u.place;
  const at = p.outStart + (posAt(p.cum, p.callIdx + (xc - u.from)) - p.callFrom);
  return Math.round(Math.max(p.outStart, Math.min(p.outStart + p.len, at)));
}

// The audio runs about two duration steps ahead of the summed durations: shifting word
// times 1200 samples (50 ms) earlier puts starts just before each word's sound rises, and
// almost never in the previous word's decay (measured over 37 comma joins and every word
// boundary of af_heart and am_michael at speeds 1 and 1.5; 1-3 steps all beat 0, 2 best).
// Kokoro's own pipeline shifts by 3 steps. Constant in samples, whatever the speed.
const LEAD = 2 * STEP_SAMPLES;
// Kokoro's durations also give most of a comma or full-stop pause to the last phoneme
// before it, so a word's range can end in 200-400 ms of silence. Pull the end back to the
// last audible 5 ms frame (+20 ms).
const FRAME = Math.round(0.005 * SR);
const TAIL = Math.round(0.02 * SR);
function audibleEnd(s, start, end) {
  const u = s.units.find((v) => v.place && end > v.place.outStart && end <= v.place.outStart + v.place.len);
  if (!u || !u.place.pcm) return end;
  const p = u.place;
  const x = p.pcm;
  const a = Math.max(0, start - p.outStart);
  let k = end - p.outStart;
  const floor = a + Math.round((k - a) * 0.3); // never trim a word to less than 30% of its span
  while (k - FRAME >= floor) {
    let ss = 0;
    for (let i = k - FRAME; i < k; i++) ss += x[i] * x[i];
    if (Math.sqrt(ss / FRAME) > 0.005) break;
    k -= FRAME;
  }
  return Math.min(end, p.outStart + k + TAIL);
}

async function synthJob(m, isCancelled) {
  const speed = Math.min(2, Math.max(0.5, +m.speed || 1));
  const t0 = performance.now();
  const phon = new Map();
  for (const seg of m.segments) phon.set(seg, await phonemesOf(seg));
  const fastStart = !!m.fastStart;
  const { segs, units } = prepareSegments(m.segments, (seg) => phon.get(seg), { fastStart });
  const calls = hasDurations ? groupUnits(units, { fastStart }) : units.map((u) => ({ units: [u], tokens: u.ids.length + 2 }));
  let outPos = 0;
  let segCursor = 0;
  let parts = [];
  let marks = [];
  let words = hasDurations ? [] : null;
  let computeMs = 0;
  const perCall = []; // [tokens, ms, samples] per model call
  let allExact = hasDurations;
  let pendingFadeIn = false;

  const place = (pcm) => {
    if (pendingFadeIn) fadeIn(pcm, 0, FADE);
    pendingFadeIn = false;
    parts.push(pcm);
    outPos += pcm.length;
  };
  // A planned pause tops Kokoro's own pause (the end of this segment's last piece + the
  // next segment's lead, estimated) up to the shared target (pcm.js gapSamples), so breaks
  // sound the same as Piper's: Kokoro already pauses 0.55-0.8 s at a full stop, and adding
  // the whole plan on top made paragraph breaks 1.35-1.45 s.
  const sentenceGap = msToSamples(SENTENCE_GAP_MS / speed, SR);
  const pause = (s) => {
    const planned = msToSamples(s.pauseAfterMs, SR);
    if (!planned) return;
    const prev = parts[parts.length - 1];
    const spoke = s.units.length > 0 && prev && prev.length;
    const n = spoke ? gapSamples({ tail: Math.min(quietEdges(prev, SR).tail, prev.length), lead: leadEst, target: sentenceGap, planned }) : planned;
    if (!n) return;
    if (prev && prev.length) fadeOut(prev, prev.length, FADE);
    parts.push(new Float32Array(n));
    outPos += n;
    pendingFadeIn = true;
  };
  const finishSeg = (s) => {
    s.end = outPos;
    if (words && s.entries.length && s.units.length) {
      let last = s.start;
      for (const e of s.entries) {
        const start = Math.max(last, s.start, segSample(s, e.tokStart, false) - LEAD);
        const end = Math.max(start, audibleEnd(s, start, Math.min(s.end, segSample(s, e.tokEnd, true) - LEAD)));
        words.push({ index: s.index, alignIndex: e.alignIndex, start, end });
        last = start;
      }
    }
    pause(s);
    marks.push({ index: s.index, start: s.start, end: outPos });
  };
  // Segments with nothing to say (empty, punctuation only) are just their pause.
  const flushEmpty = (upTo) => {
    while (segCursor < upTo) {
      const s = segs[segCursor++];
      s.start = outPos;
      finishSeg(s);
    }
  };
  const emit = () => {
    if (!m.stream || (!parts.length && !marks.length)) return;
    const pcm = concat(parts);
    const start = outPos - pcm.length;
    post({ type: 'chunk', job: m.job, start, pcm, marks, words: words && words.splice(0) }, [pcm.buffer]);
    parts = [];
    marks = [];
  };

  for (const call of calls) {
    if (isCancelled()) return;
    const tc = performance.now();
    const { pieces, exact, samples } = await synthCall(call, speed);
    const ms = performance.now() - tc;
    computeMs += ms;
    if (!exact) allExact = false;
    perCall.push([call.tokens, Math.round(ms), samples]);
    if (isCancelled()) return;
    for (const piece of pieces) {
      const s = piece.u.seg;
      const si = segs.indexOf(s, segCursor);
      if (si >= segCursor) {
        // First piece of this segment.
        flushEmpty(si);
        segCursor = si + 1;
        s.start = outPos;
        const lead = quietEdges(piece.pcm, SR).lead;
        if (lead < piece.pcm.length) leadEst = Math.round(0.7 * leadEst + 0.3 * Math.min(lead, Math.round(0.3 * SR)));
      }
      const pcm = piece.pcm.slice();
      piece.u.place = { outStart: outPos, callFrom: piece.callFrom, callIdx: piece.callIdx, cum: piece.cum, len: piece.pcm.length, pcm };
      // Call edges are cut in near-silence (below 0.02), not at zero: fade them so the
      // join with the next call never clicks. Joins inside a call are continuous already.
      if (piece === pieces[0]) fadeIn(pcm, 0, FADE);
      if (piece === pieces[pieces.length - 1]) fadeOut(pcm, pcm.length, FADE);
      place(pcm);
      if (piece.u.last) finishSeg(s);
    }
    emit();
  }
  flushEmpty(segs.length);
  emit();
  const pcm = m.stream ? null : concat(parts);
  const audioS = outPos / SR;
  // durationsExact: every call's audio was exactly 600 samples per rounded duration step,
  // so word and segment positions are sample-exact rather than scaled estimates.
  const stats = { computeMs: Math.round(computeMs), totalMs: Math.round(performance.now() - t0), audioS, rt: computeMs ? audioS / (computeMs / 1000) : 0, calls: calls.length, perCall, speed, durationsExact: allExact && calls.length > 0 };
  post({ type: 'done', job: m.job, sampleRate: SR, length: outPos, pcm, marks, words, stats }, pcm ? [pcm.buffer] : []);
}

async function calibrateJob(m) {
  const ids = [0, ...tokenize(CALIBRATION.phonemes).ids, 0];
  const t0 = performance.now();
  await run(ids, 1);
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  const { wav } = await run(ids, 1);
  const ms = performance.now() - t1;
  corrupt(wav, m.corrupt);
  const stats = renderStats(wav, SR, ms);
  post({ type: 'calibrated', job: m.job, stats: { ...stats, firstMs: Math.round(firstMs), tokens: ids.length } });
}
