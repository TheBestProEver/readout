// readkit lab: tests readkit on a real phone and writes a short report to paste into chat.
// Runs from any static host (GitHub Pages included): every URL is relative, and sw.js makes
// the page cross-origin isolated without server headers.
//
// Dev override (never on by default): ?local=<http://127.0.0.1:port> points onnxruntime,
// espeak and the voice models at a local server with the test layout of
// tests/fixtures/voice/server.mjs. It only works when both the lab and that server are on
// this machine (loopback), so a link can never make a published lab load code from elsewhere.
import { configure, config } from '../src/config.js';
import { plan } from '../src/speech/plan.js';
import { createVoice, voiceStore, findVoice } from '../src/voice/voice.js';
import { createPlayer, playerSupport } from '../src/audio/player.js';
import { opusSupport } from '../src/audio/opus.js';

export const LAB_VERSION = 1;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;
const mb = (b) => Math.round(b / 1e6);

/* ---------- dev override ---------- */

const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const localParam = new URLSearchParams(location.search).get('local');
let localBase = null;
if (localParam) {
  try {
    const u = new URL(localParam);
    if (LOOPBACK.test(u.hostname) && LOOPBACK.test(location.hostname) && /^https?:$/.test(u.protocol)) localBase = u.origin;
  } catch (e) {
    /* not a URL: ignored */
  }
}
if (localBase) configure({ ort: localBase + '/ort/', phonemizer: localBase + '/phonemizer.js', piperPhonemize: localBase + '/piperph/', kokoro: { base: localBase + '/kokoro/' }, piper: localBase + '/piper/' });

/* ---------- results (kept for the report, and across reloads) ---------- */

const results = JSON.parse(localStorage.getItem('readkit-lab-results') || '{}');
function save() {
  localStorage.setItem('readkit-lab-results', JSON.stringify(results));
  // a report already on screen follows the results, so it is never copied stale
  const box = document.getElementById('report');
  if (box && !box.hidden) {
    const text = report();
    if (box.value !== text) {
      box.value = text;
      say('copy-status', 'New results: tap "Copy results" again.', '');
    }
  }
}
// The latest screen-off run of each voice, for the report.
function keepScreenOff(summary) {
  results.screenOff = summary;
  results.screenOffRuns = { ...(results.screenOffRuns || {}), [summary.voice]: summary };
}

// Michael (Kokoro am_michael) is the user's chosen voice and comes first; Ryan (Piper) is the
// fallback for phones where Kokoro cannot run (fallbackVoice('am_michael')).
export const VOICES = {
  michael: { id: 'am_michael', name: 'Michael', label: 'Michael (HD)', size: '330 MB' },
  ryan: { id: 'en_US-ryan-medium', name: 'Ryan', label: 'Ryan (backup)', size: '63 MB' },
};
const BACKUP = 'ryan';

const SAMPLE = `Readout reads your documents aloud, even with the screen off. This is a short sample, so you can hear how the voice sounds on this phone. On Tuesday, Dr. Patel read three chapters in 45 minutes; it cost $12.50.`;

/* ---------- small UI helpers ---------- */

function show(id, on = true) {
  $(id).hidden = !on;
}
function say(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  if (cls !== undefined) el.className = 'status ' + cls;
}
function bar(id, frac) {
  $(id).value = Math.max(0, Math.min(1, frac || 0));
}
// Waits for a click on one of the buttons; resolves with its id.
function choose(...ids) {
  return new Promise((resolve) => {
    const handlers = ids.map((id) => {
      const fn = () => {
        ids.forEach((x, i) => $(x).removeEventListener('click', handlers[i]));
        resolve(id);
      };
      $(id).addEventListener('click', fn);
      return fn;
    });
  });
}

/* ---------- (a) device check ---------- */

export async function deviceCheck() {
  say('device-status', 'Checking...', '');
  const d = { at: new Date().toISOString() };
  d.ua = navigator.userAgent;
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const h = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
      d.model = h.model || null;
      d.platform = (navigator.userAgentData.platform || '') + ' ' + (h.platformVersion || '');
      const chrome = (h.fullVersionList || []).find((b) => /Chrome|Chromium/.test(b.brand));
      d.browser = chrome ? chrome.brand + ' ' + chrome.version : null;
    }
  } catch (e) {
    /* not offered */
  }
  d.cores = navigator.hardwareConcurrency || null;
  d.memoryGB = navigator.deviceMemory || null;
  d.coi = !!self.crossOriginIsolated;
  d.sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  d.gpu = { available: !!navigator.gpu };
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      if (a) {
        const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
        d.gpu = { available: true, vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '', description: info.description || '', f16: a.features.has('shader-f16'), maxBufferMB: mb(a.limits.maxBufferSize), maxStorageMB: mb(a.limits.maxStorageBufferBindingSize) };
      } else d.gpu = { available: true, adapter: false };
    } catch (e) {
      d.gpu = { available: true, error: e.message };
    }
  }
  const sup = playerSupport();
  d.mse = sup.mse;
  d.mediaSession = sup.mediaSession;
  d.opus24 = (await opusSupport(24000)).encoder;
  d.opus22 = (await opusSupport(22050)).encoder;
  if (navigator.storage) {
    try {
      d.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
      if (!d.persisted && navigator.storage.persist) d.persisted = await navigator.storage.persist();
      const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est) d.storage = { quotaMB: mb(est.quota), usedMB: mb(est.usage) };
    } catch (e) {
      d.storageError = e.message;
    }
  }
  const c = navigator.connection;
  if (c) d.net = { type: c.type || null, effective: c.effectiveType || null, downlink: c.downlink || null, saveData: !!c.saveData };
  results.device = d;
  save();
  $('device-out').textContent = deviceLines(d).join('\n');
  const audioOk = d.mse && d.opus24;
  const gpuOk = d.gpu && d.gpu.available && d.gpu.adapter !== false && !d.gpu.error;
  const verdict = !audioOk
    ? 'Done. Read-aloud audio does NOT work in this browser.'
    : gpuOk
      ? `Done. This phone can play read-aloud audio, and its graphics chip can try ${VOICES.michael.name}.`
      : `Done. This phone can play read-aloud audio. ${VOICES.michael.name} needs WebGPU, which this browser lacks, so ${VOICES[BACKUP].name} would be used.`;
  say('device-status', verdict, audioOk ? 'good' : 'bad');
  return d;
}

function deviceLines(d) {
  const g = d.gpu || {};
  const gpu = g.vendor || g.architecture ? `${g.vendor} ${g.architecture} ${g.description || g.device || ''}`.replace(/\s+/g, ' ').trim() + (g.f16 ? ', f16' : '') + `, max buffer ${g.maxBufferMB} MB` : g.available ? (g.error ? 'error: ' + g.error : 'no adapter') : 'not available';
  return [
    `Phone: ${d.model || '?'} ${d.platform || ''} ${d.browser || ''}`.replace(/\s+/g, ' '),
    `CPU cores: ${d.cores}, memory: ${d.memoryGB ? d.memoryGB + ' GB' : '?'}`,
    `Isolated (WASM threads): ${d.coi ? 'yes' : 'no'}${d.sw ? ' (via sw.js)' : ''}`,
    `WebGPU: ${gpu}`,
    `Opus encoder: ${d.opus24 ? 'yes' : 'no'}; MediaSource WebM/Opus: ${d.mse ? 'yes' : 'no'}; lock-screen controls: ${d.mediaSession ? 'yes' : 'no'}`,
    `Storage: ${d.persisted ? 'persistent' : 'may be cleared'}, ${d.storage ? `${d.storage.usedMB} MB used of ${d.storage.quotaMB} MB` : '?'}`,
    `Network: ${d.net ? `${d.net.type || ''} ${d.net.effective || ''} ${d.net.downlink ? d.net.downlink + ' Mbit/s' : ''}${d.net.saveData ? ' (data saver)' : ''}`.trim() : '?'}`,
  ];
}

/* ---------- (b) voice test ---------- */

const loaded = {}; // key -> voice

// Download (after the user said yes), load, calibrate, measure at 1x and 1.5x.
export async function voiceTest(key, opts = {}) {
  const go = $(key + '-go');
  if (go.disabled) return null; // already running (a second tap)
  go.disabled = true;
  try {
    return await runVoiceTest(key, opts);
  } finally {
    go.disabled = false;
  }
}

async function runVoiceTest(key, { confirmed = false } = {}) {
  const v = VOICES[key];
  const st = key + '-status';
  // the HD voice runs only on the graphics chip: say so before offering a big download
  if (findVoice(v.id).engine === 'kokoro') {
    const gpu = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (!gpu) {
      results[key] = { id: v.id, at: new Date().toISOString(), error: 'no WebGPU in this browser (not downloaded)' };
      save();
      renderVoice(key);
      say(st, `This browser has no WebGPU, so this voice cannot run here. Nothing was downloaded. Test ${VOICES[BACKUP].name} below instead.`, 'bad');
      return null;
    }
  }
  const r = (results[key] = { id: v.id, at: new Date().toISOString() });
  try {
    const status = await voiceStore.status(v.id);
    if (!status.installed && !confirmed) {
      show(key + '-ask');
      say(st, '', '');
      const answer = await choose(key + '-yes', key + '-no');
      show(key + '-ask', false);
      if (answer !== key + '-yes') {
        r.declined = true;
        save();
        renderVoice(key);
        say(st, 'Not downloaded.', '');
        return null;
      }
    }
    if (!status.installed) {
      show(key + '-bar');
      const t0 = performance.now();
      let first = null;
      await voiceStore.install(v.id, {
        onProgress: (p) => {
          if (first == null && p.done > 0) first = p.done;
          bar(key + '-bar', p.total ? p.done / p.total : 0);
          say(st, `Downloading: ${mb(p.done)} of ${mb(p.total)} MB`, '');
        },
      });
      r.downloadS = r1((performance.now() - t0) / 1000);
      r.downloadMB = mb(status.total - status.bytes);
      r.resumedFromMB = mb(status.bytes);
      bar(key + '-bar', 1);
    } else r.downloadS = 0;
    say(st, 'Loading the voice...', '');
    const t1 = performance.now();
    if (loaded[key]) {
      loaded[key].dispose();
      delete loaded[key];
    }
    const voice = await createVoice({ id: v.id, onProgress: (p) => say(st, p.message || p.stage, '') });
    loaded[key] = voice;
    r.loadS = r1((performance.now() - t1) / 1000);
    r.device = voice.device;
    r.threads = voice.info.threads;
    r.adapter = voice.info.adapter || null;
    say(st, 'Checking the voice (calibrate)...', '');
    const cal = await voice.calibrate({ force: true });
    r.calibrate = { ok: cal.ok, rt: r1(cal.rt || 0), reason: cal.reason || null };
    const segs = plan(SAMPLE, { dialect: 'en-US' });
    r.speeds = {};
    for (const speed of [1, 1.5]) {
      say(st, `Measuring at ${speed}x...`, '');
      const t = performance.now();
      let firstMs = null;
      const res = await voice.synth(segs, { speed, onChunk: () => firstMs == null && (firstMs = performance.now() - t) });
      const totalS = (performance.now() - t) / 1000;
      const audioS = res.pcm.length / res.sampleRate;
      r.speeds[speed] = { firstAudioS: r1((firstMs || 0) / 1000), audioS: r1(audioS), rtf: r1(audioS / totalS) };
    }
    save();
    renderVoice(key);
    const backup = key !== BACKUP ? ` Test ${VOICES[BACKUP].name} below instead.` : '';
    const rtf = r.speeds[1] && r.speeds[1].rtf;
    const pace = rtf >= 1 ? ` This phone makes the speech ${rtf} times as fast as it is read out, so reading does not wait.` : '';
    say(st, cal.ok ? `Ready.${pace} Tap "Play sample" to hear it.` : `This voice does not work well here (${cal.reason || 'calibration failed'}).${backup}`, cal.ok ? 'good' : 'bad');
    $(key + '-play').disabled = false;
    show(key + '-play');
    refreshScreenOffChoices();
    return r;
  } catch (e) {
    r.error = (e && e.message) || String(e);
    save();
    renderVoice(key);
    say(st, 'Failed: ' + r.error + (e && e.name === 'AbortError' ? '' : '. Tap again to retry (downloads resume).'), 'bad');
    return r;
  }
}

function renderVoice(key) {
  $(key + '-out').textContent = voiceLine(key) || '';
}

function voiceLine(key) {
  const r = results[key];
  if (!r) return null;
  if (r.declined) return `${key}: download declined, not tested`;
  if (r.error && !r.loadS) return `${key}: error ${r.error}`;
  if (!r.loadS) return `${key}: test did not finish`;
  const s1 = (r.speeds && r.speeds[1]) || {};
  const s15 = (r.speeds && r.speeds[1.5]) || {};
  const dl = r.downloadS ? `download ${r.downloadMB} MB in ${r.downloadS} s${r.resumedFromMB ? ` (resumed at ${r.resumedFromMB} MB)` : ''}; ` : 'already installed; ';
  const cal = r.calibrate ? `calibrate ${r.calibrate.ok ? 'ok' : 'FAILED (' + r.calibrate.reason + ')'} ${r.calibrate.rt}x; ` : '';
  const play = r.play ? `; sample ${r.play.firstSoundS != null ? `played (first sound ${r.play.firstSoundS} s` : '(no sound yet'}${r.play.error ? ', error ' + r.play.error : ''})` : '';
  const speeds = [s1.rtf != null ? `1x: first audio ${s1.firstAudioS} s, ${s1.rtf}x real time` : '', s15.rtf != null ? `1.5x: first audio ${s15.firstAudioS} s, ${s15.rtf}x` : ''].filter(Boolean).join('; ');
  return `${key}: ${dl}load ${r.loadS} s on ${r.device}${r.threads > 1 ? ` (${r.threads} threads)` : ''}; ${cal}${speeds}${r.error ? `; error ${r.error}` : ''}${play}`;
}

let samplePlayer = null;
// Plays the sample through the real player (must run inside the tap).
export function playSample(key) {
  const voice = loaded[key];
  if (!voice) return;
  if (samplePlayer) samplePlayer.destroy();
  const t0 = performance.now();
  const r = results[key];
  r.play = { firstSoundS: null };
  samplePlayer = createPlayer({
    audio: $('audio'),
    voice,
    segments: plan(SAMPLE, { dialect: 'en-US' }),
    cache: false,
    metadata: { title: 'readkit lab sample', artist: 'readkit lab' },
    onState: (s) => {
      if (s === 'playing' && r.play.firstSoundS == null) {
        r.play.firstSoundS = r1((performance.now() - t0) / 1000);
        save();
        renderVoice(key);
      }
      if (s === 'ended') say(key + '-status', 'Sample finished.', 'good');
    },
    onError: (e) => {
      r.play.error = e.code || e.message;
      save();
      renderVoice(key);
    },
  });
  samplePlayer.play();
}

/* ---------- (c) screen-off test ---------- */

const DB = 'readkit-lab';
function db() {
  return new Promise((resolve, reject) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => {
      const d = q.result;
      d.createObjectStore('runs', { keyPath: 'id' });
      d.createObjectStore('rows', { autoIncrement: true }).createIndex('run', 'run');
    };
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}
async function idbPut(store, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => (d.close(), resolve());
    tx.onerror = () => (d.close(), reject(tx.error));
  });
}
async function idbRows(run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const q = d.transaction('rows').objectStore('rows').index('run').getAll(run);
    q.onsuccess = () => (d.close(), resolve(q.result));
    q.onerror = () => (d.close(), reject(q.error));
  });
}
async function idbLastRun() {
  const d = await db();
  return new Promise((resolve) => {
    const q = d.transaction('runs').objectStore('runs').getAll();
    q.onsuccess = () => (d.close(), resolve(q.result.sort((a, b) => b.started - a.started)[0] || null));
    q.onerror = () => (d.close(), resolve(null));
  });
}

let passage = null;
async function passageSegments(minutes) {
  if (!passage) passage = await (await fetch('./passage.txt')).text();
  // about 15 characters a second at 1x: repeat the passage until it fills the test
  const need = minutes * 60 * 15 * 1.2;
  let text = passage;
  while (text.length < need) text += '\n\n' + passage;
  return plan(text, { dialect: 'en-US' });
}

let test = null; // the running screen-off test
let starting = false; // loading its voice

export async function screenOffStart({ key, minutes }) {
  if (test || starting) return;
  minutes = Math.min(120, Math.max(0.25, +minutes || 10));
  let voice = loaded[key];
  if (!voice) {
    // installed on an earlier visit: load it now (play() is still allowed: the page has been
    // interacted with)
    const st = await voiceStore.status(VOICES[key].id).catch(() => null);
    if (!st || !st.installed) return say('off-status', 'Run the voice test for this voice first.', 'bad');
    say('off-status', 'Loading the voice...', '');
    starting = true;
    $('off-start').disabled = true;
    try {
      voice = loaded[key] = await createVoice({ id: VOICES[key].id });
    } catch (e) {
      say('off-status', `Could not load the voice: ${(e && e.message) || e}`, 'bad');
      return;
    } finally {
      starting = false;
      $('off-start').disabled = false;
    }
  }
  const run = { id: 'run-' + Date.now(), voice: VOICES[key].id, key, minutes, started: Date.now(), ended: null, summary: null };
  const segments = await passageSegments(minutes);
  const audio = $('audio');
  if (samplePlayer) {
    samplePlayer.destroy();
    samplePlayer = null;
  }
  const t = (test = { run, rows: [], seq: 0, prev: null, states: [], errors: [], firstAudioAt: null });
  t.player = createPlayer({
    audio,
    voice,
    segments,
    speed: 1,
    cache: false,
    metadata: { title: 'readkit screen-off test', artist: 'readkit lab' },
    onState: (s) => {
      t.states.push([r1((Date.now() - run.started) / 1000), s]);
      if (s === 'playing' && t.firstAudioAt == null) t.firstAudioAt = Date.now();
    },
    onError: (e) => t.errors.push(`${r1((Date.now() - run.started) / 1000)} s: ${e.code || ''} ${e.message}`),
  });
  t.player.play(); // inside the tap
  $('off-start').disabled = true;
  $('off-stop').disabled = false;
  await idbPut('runs', run);
  say('off-status', `Playing. Lock your phone now and wait ${minutes} minute${minutes === 1 ? '' : 's'}, then unlock.`, '');
  say('off-live', '');
  show('off-live');
  t.timer = setInterval(() => sample(t), 1000);
}

async function sample(t) {
  const now = Date.now();
  const st = t.player.stats;
  const w = (now - t.run.started) / 1000;
  const prev = t.prev;
  const dt = prev ? w - prev.w : 0;
  const row = {
    run: t.run.id,
    seq: t.seq++,
    t: now,
    w: r1(w),
    dt: r1(dt),
    ct: Math.round(st.currentTime * 100) / 100,
    ahead: r1(st.aheadS),
    gen: prev && dt > 0 ? r1((st.appendEndS - prev.appendEnd) / dt) : null,
    vis: document.visibilityState,
    filler: st.fillerRun > 0,
    fillers: st.fillers,
    state: st.state,
    rate: st.playbackRate,
  };
  t.prev = { w, appendEnd: st.appendEndS };
  t.rows.push(row);
  idbPut('rows', row).catch(() => {});
  if (document.visibilityState === 'visible') say('off-live', `${Math.round(w)} s: heard ${Math.round(row.ct)} s, ${Math.round(row.ahead)} s ready ahead, ${row.state}${row.filler ? ' (filler)' : ''}`);
  if (w >= t.run.minutes * 60) await screenOffStop({ early: false });
}

// early: the user pressed "Stop early" (the report says so).
export async function screenOffStop({ early = true } = {}) {
  const t = test;
  if (!t) return null;
  test = null;
  clearInterval(t.timer);
  t.player.pause();
  t.run.ended = Date.now();
  t.run.summary = summarize(t.rows, { states: t.states, errors: t.errors, firstAudioS: t.firstAudioAt ? (t.firstAudioAt - t.run.started) / 1000 : null, minutes: t.run.minutes });
  if (early) t.run.summary.stoppedEarly = true;
  t.run.rows = t.rows.length;
  await idbPut('runs', t.run);
  t.player.destroy();
  show('off-live', false);
  $('off-stop').disabled = true;
  refreshScreenOffChoices();
  keepScreenOff({ voice: t.run.voice, minutes: t.run.minutes, ...t.run.summary });
  save();
  renderSummary(t.run);
  return t.run.summary;
}

// What happened while the screen was off, from the one-second log.
export function summarize(rows, { states = [], errors = [], firstAudioS = null, minutes = null } = {}) {
  if (!rows.length) return { rows: 0 };
  const playing = rows.filter((r) => r.state === 'playing' || r.state === 'buffering' || r.state === 'loading');
  let longest = 0;
  let run = 0;
  let stalls = 0;
  let inStall = false;
  let frozen = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    const dt = b.w - a.w;
    if (dt > 3) frozen = Math.max(frozen, dt); // the page got no timer for a while
    const heard = (b.ct - a.ct) / Math.max(0.001, dt * (b.rate || 1));
    const started = firstAudioS == null || b.w > firstAudioS + 1;
    const gap = started && (b.state !== 'playing' || heard < 0.5 || b.filler) && b.state !== 'paused' && b.state !== 'ended';
    if (gap) {
      run += dt;
      if (!inStall) stalls++;
      inStall = true;
      longest = Math.max(longest, run);
    } else {
      run = 0;
      inStall = false;
    }
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const wall = last.w - (firstAudioS || first.w);
  const heard = last.ct - first.ct;
  const after = rows.filter((r) => r.w > (firstAudioS || 0) + 30);
  const minAhead = after.length ? Math.min(...after.map((r) => r.ahead)) : null;
  const gens = rows.map((r) => r.gen).filter((g) => g != null);
  const hidden = rows.filter((r) => r.vis === 'hidden').length;
  // comfort noise in the first seconds (the screen locked before the first audio was
  // buffered) is the start, not generation falling behind
  const settled = rows.find((r) => r.w > (firstAudioS || 0) + 10);
  const lateFillers = settled ? last.fillers - settled.fillers : 0;
  return {
    rows: rows.length,
    wallS: Math.round(wall),
    heardS: Math.round(heard),
    hiddenS: hidden,
    longestGapS: r1(Math.max(longest, frozen)),
    stalls,
    frozenS: r1(frozen),
    wholeTime: wall > 0 && heard >= 0.9 * wall && frozen < 5,
    keepsUp: (minAhead == null || minAhead >= 5) && lateFillers === 0,
    minAheadS: minAhead == null ? null : Math.round(minAhead),
    fillers: last.fillers,
    lateFillers,
    genPeak: gens.length ? r1(Math.max(...gens)) : null,
    firstAudioS: firstAudioS == null ? null : r1(firstAudioS),
    states: states.map(([w, s]) => s).filter((s, i, a) => i === 0 || s !== a[i - 1]).join(' > '),
    errors: errors.slice(0, 5),
    playingRows: playing.length,
    minutes,
  };
}

const secs = (x) => (x == null ? '?' : x + ' s');

function summaryLine(s, voice) {
  if (!s) return '';
  const how = `${s.stoppedEarly ? ', stopped early' : ''}${s.cutShort ? ', cut short: the phone closed the page' : ''}`;
  if (!s.rows) return `screen-off (${voice}, ${s.minutes} min${how}): nothing was logged`;
  return `screen-off (${voice}, ${s.minutes} min${how}): heard ${s.heardS} of ${s.wallS} s, whole time ${s.wholeTime ? 'yes' : 'NO'}, longest gap ${s.longestGapS} s, stalls ${s.stalls}, generation keeps up ${s.keepsUp ? 'yes' : 'NO'} (min ahead ${secs(s.minAheadS)}, fillers ${s.fillers}, after the start ${s.lateFillers}), hidden ${s.hiddenS} s, first audio ${secs(s.firstAudioS)}${s.errors && s.errors.length ? ', errors: ' + s.errors.join('; ') : ''}`;
}

function renderSummary(run) {
  const s = run.summary;
  if (!s) return;
  if (!s.rows) {
    $('off-out').textContent = 'Nothing was logged: the page was closed right after the start.';
    say('off-status', 'The last test was cut short.', 'bad');
    return;
  }
  $('off-out').textContent = [
    s.cutShort ? 'The phone closed this page during the test, so it was cut short.' : s.stoppedEarly ? 'Stopped early.' : null,
    `Played the whole time: ${s.wholeTime ? 'YES' : 'NO'} (heard ${s.heardS} s of ${s.wallS} s)`,
    `Longest gap: ${s.longestGapS} s; stalls: ${s.stalls}`,
    `Generation keeps up: ${s.keepsUp ? 'YES' : 'NO'} (lowest buffer ${s.minAheadS == null ? 'not measured, the run was too short' : s.minAheadS + ' s'}, comfort-noise fillers ${s.fillers})`,
    `Screen off (page hidden) for ${s.hiddenS} s`,
    s.errors && s.errors.length ? 'Errors: ' + s.errors.join('; ') : 'No errors',
  ]
    .filter((x) => x != null)
    .join('\n');
  say('off-status', 'Test finished. Results below; tap "Copy results" to share them.', s.wholeTime && s.keepsUp && !s.cutShort ? 'good' : 'bad');
}

/* ---------- (d) report ---------- */

export function report() {
  const d = results.device;
  const lines = [`readkit lab report v${LAB_VERSION}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${localBase ? ' (local models)' : ''}`];
  if (d) lines.push(...deviceLines(d));
  else lines.push('device check: not run');
  for (const key of Object.keys(VOICES)) lines.push(voiceLine(key) || `${key}: not tested`);
  // the latest run of each voice (older results kept only results.screenOff)
  const runs = Object.values(results.screenOffRuns || (results.screenOff ? { x: results.screenOff } : {}));
  if (runs.length) for (const s of runs) lines.push(summaryLine(s, s.voice));
  else lines.push('screen-off: not run');
  return lines.join('\n');
}

export async function copyReport() {
  const text = report();
  $('report').value = text;
  show('report');
  try {
    await navigator.clipboard.writeText(text);
    say('copy-status', 'Copied. Paste it into the chat.', 'good');
  } catch (e) {
    $('report').select();
    const ok = document.execCommand && document.execCommand('copy');
    say('copy-status', ok ? 'Copied. Paste it into the chat.' : 'Select the text below and copy it.', ok ? 'good' : '');
  }
  return text;
}

/* ---------- wiring ---------- */

// Voices that are loaded or installed can run the screen-off test.
async function refreshScreenOffChoices() {
  const sel = $('off-voice');
  const cur = sel.value;
  const ready = {};
  for (const [key, v] of Object.entries(VOICES)) {
    try {
      ready[key] = !!loaded[key] || (await voiceStore.status(v.id)).installed;
    } catch (e) {
      ready[key] = !!loaded[key];
    }
  }
  sel.innerHTML = '';
  for (const [key, v] of Object.entries(VOICES)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = v.label + (ready[key] ? '' : ' – test it first');
    o.disabled = !ready[key];
    sel.appendChild(o);
  }
  const first = Object.keys(VOICES).find((k) => ready[k]);
  sel.value = cur && ready[cur] ? cur : first || Object.keys(VOICES)[0];
  $('off-start').disabled = !first || !!test || starting;
  // say why Start is greyed out
  const hint = 'Test a voice in step 2 first; then Start works.';
  if (!first && !$('off-status').textContent) say('off-status', hint, '');
  else if (first && $('off-status').textContent === hint) say('off-status', '', '');
}

export async function init() {
  $('device-go').onclick = () => deviceCheck();
  for (const key of Object.keys(VOICES)) {
    $(key + '-go').onclick = () => voiceTest(key);
    $(key + '-play').onclick = () => playSample(key);
    renderVoice(key);
  }
  $('off-start').onclick = () => screenOffStart({ key: $('off-voice').value, minutes: $('off-minutes').value });
  $('off-stop').onclick = () => screenOffStop();
  $('copy').onclick = () => copyReport();
  if (results.device) $('device-out').textContent = deviceLines(results.device).join('\n');
  refreshScreenOffChoices();
  fetch('./passage.txt').then((r) => r.text()).then((x) => (passage = passage || x), () => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && test) say('off-status', 'Still running. Lock the phone again, or wait here.', '');
  });
  // a run the phone cut short (page killed): summarize what was logged
  try {
    const last = await idbLastRun();
    if (last && !last.summary) {
      const rows = await idbRows(last.id);
      last.summary = summarize(rows, { minutes: last.minutes });
      last.summary.cutShort = true;
      await idbPut('runs', last);
      keepScreenOff({ voice: last.voice, minutes: last.minutes, ...last.summary });
      save();
    }
    if (last && last.summary) renderSummary(last);
  } catch (e) {
    /* no IndexedDB: the live result still shows */
  }
  // plain words for the user; the technical details are in the device check and the report
  $('env').textContent = `Ready.${self.crossOriginIsolated ? '' : ' Fast mode is off in this browser, so the backup voice may be slower.'}${localBase ? ` (Test models from ${localBase}.)` : ''}`;
}

window.LAB = { deviceCheck, voiceTest, playSample, screenOffStart, screenOffStop, report, copyReport, summarize, results, loaded, config, findVoice };
