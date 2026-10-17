// The player: speech that keeps playing with the screen off.
//
// One MediaSource per session on the app's <audio> (duration Infinity, one SourceBuffer
// 'audio/webm; codecs="opus"' in 'sequence' mode); play() once from the user's tap; src never
// changes until destroy(). Segments are pulled from voice.synth() in order, each segment is
// encoded as its own Opus clip by the session's one AudioEncoder and appended as WebM
// clusters as soon as packets come out. The player keeps 60-120 s ahead, trims what was
// played, plays comfort noise when it runs dry while hidden, and maps the playhead back to
// segments and words through the timeline.
//
// Speed: setSpeed() is instant through playbackRate (pitch preserved); about 3 s after the
// last change the audio not yet heard is regenerated at the nearest model speed (0.8-2.0) and
// spliced in at a segment boundary, and playbackRate covers the rest.
import { MIME, webmHeader, webmClusters } from './webm.js';
import { createEncoder, encoderRate, FRAME_US, packetsDurationUs } from './opus.js';
import { createTimeline, createEstimates, CONTENT_LEAD_US } from './timeline.js';
import { comfortNoise, createKeepAlive } from './keepalive.js';
import { createMediaSession } from './session.js';
import { openClipStore, clipKey } from './clipstore.js';

export const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2];
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;
const SPLICE_GUARD_S = 1; // wall seconds between the playhead and a splice point
const FILLER_GUARD_S = 0.4; // same, for cutting unplayed filler when speech arrives
const PREFETCH_US = 15e6; // generated before the first play()

// Nearest model speed for a listening speed (playbackRate covers the difference).
export function snapSpeed(r, speeds = SPEEDS) {
  const x = Math.min(MAX_SPEED, Math.max(MIN_SPEED, +r || 1));
  let best = speeds[0];
  for (const s of speeds) if (Math.abs(Math.log(s / x)) < Math.abs(Math.log(best / x))) best = s;
  return best;
}

export function playerSupport() {
  const mse = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME);
  const encoder = typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
  const mediaSession = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  return { ok: mse && encoder, mse, encoder, mediaSession, preservesPitch: typeof HTMLMediaElement !== 'undefined' && 'preservesPitch' in HTMLMediaElement.prototype };
}

const isAbort = (e) => e && (e.name === 'AbortError' || e.code === 'aborted');
const fail = (code, message, cause) => Object.assign(new Error(message), { code, cause });
const clampRate = (r) => Math.min(16, Math.max(0.0625, r));

// Serial async queue: ops run one after another in call order.
function serial() {
  let chain = Promise.resolve();
  return (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
}

export function createPlayer(o = {}) {
  const { audio } = o;
  let { voice } = o;
  const noPcm = (v) => !v || typeof v.synth !== 'function' || v.engine === 'system';
  if (!audio) throw fail('bad-args', 'createPlayer needs an <audio> element');
  if (noPcm(voice)) throw fail('unsupported', 'This voice produces no audio data (system voices use speak())');
  const sup = playerSupport();
  if (!sup.ok) throw Object.assign(fail('unsupported', !sup.mse ? 'MediaSource with WebM/Opus is not supported' : 'WebCodecs AudioEncoder is not supported'), { support: sup });

  const segments = Array.from(o.segments || []);
  const n = segments.length;
  const segIndex = (i) => (segments[i] && Number.isInteger(segments[i].index) ? segments[i].index : i);
  const cb = (name, ...args) => {
    const f = o[name];
    if (typeof f === 'function') {
      try {
        f(...args);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
  };
  const keepAhead = o.keepAhead || {};
  let lowUs = (keepAhead.low == null ? 60 : keepAhead.low) * 1e6;
  let highUs = (keepAhead.high == null ? 120 : keepAhead.high) * 1e6;
  const keepBehindUs = (o.keepBehind == null ? 60 : o.keepBehind) * 1e6;
  const regenMs = o.regenerateAfterMs == null ? 3000 : o.regenerateAfterMs;
  // Model speeds to generate at (an app may restrict them, e.g. [1] for an engine whose own
  // speed control sounds poor); playbackRate covers the rest.
  const speeds = Array.isArray(o.speeds) && o.speeds.length ? o.speeds.slice() : SPEEDS;
  const snap = (r) => snapSpeed(r, speeds);

  const timeline = createTimeline();
  const est = createEstimates(segments);
  const keep = createKeepAlive({ whenVisible: !!o.fillerWhenVisible });
  const work = serial();
  const listeners = [];
  const on = (target, ev, fn) => {
    target.addEventListener(ev, fn);
    listeners.push([target, ev, fn]);
  };

  let destroyed = false;
  let state = null;
  let fatal = null;
  let requested = Math.min(MAX_SPEED, Math.max(MIN_SPEED, +o.speed || 1));
  let genSpeed = snap(requested);
  let epoch = 0;
  let nextIndex = Math.max(0, Math.min(n, o.startAt | 0));
  let current = -1;
  let currentWord = null;
  let heardSpeech = false;
  let playCalled = false;
  let eos = false;
  let appendEndUs = 0; // media time where the next appended frame lands
  let streamUs = 0; // running WebM timecode
  let abortCtl = null;
  let wakeFn = null;
  let regenTimer = null;
  let tickTimer = null;
  let pendingSplice = false;
  let splice = null; // { index }: the next first part replaces old audio from there on
  let fillerQueued = false;
  // The first batch after start, a seek out of the buffer or setVoice() asks the voice for a
  // short first model call, so audio starts sooner; later batches run whole sentences (a
  // fast-start cut is a seam in the middle of a sentence, at a comma).
  let fastNext = true;
  let fillerPackets = null;
  let trimming = false;
  let lastPositionAt = 0;
  const stats = { appends: 0, appendedUs: 0, quotaErrors: 0, fillers: 0, fillerUs: 0, splices: 0, fillerCuts: 0, seeksIn: 0, seeksOut: 0, cacheHits: 0, cacheWrites: 0, segments: 0, failures: 0, batches: 0, maxAppendMs: 0 };

  // Encoder state (only touched inside work ops).
  let enc = null;
  let encIn = 0;
  let live = null; // packets array of the open part, filled by the encoder's output callback
  let open = null; // open part: { index, offset, packets, appended, entry }
  let seg = null; // segment being encoded: { index, samples, sr, speed, packets, words, drop }

  const ctUs = () => Math.round(audio.currentTime * 1e6);
  const alive = (ep) => !destroyed && !fatal && ep === epoch;
  const rate = () => audio.playbackRate || 1;

  /* ---------- clip cache ---------- */

  let store = null;
  if (o.cache && typeof o.cache === 'object') store = o.cache;
  else if (o.cache !== false && typeof indexedDB !== 'undefined') {
    try {
      store = openClipStore();
    } catch (e) {
      store = null;
    }
  }
  let revisionP = null;
  const revision = () =>
    (revisionP =
      revisionP ||
      (voice.revision
        ? Promise.resolve(voice.revision)
        : import('../voice/catalog.js').then(
            (m) => {
              const e = m.findVoice && m.findVoice(voice.id);
              return (e && e.revision) || '';
            },
            () => '',
          )));
  const keys = new Map();
  const keyOf = async (i, speed) => {
    const k = i + '@' + speed;
    if (!keys.has(k)) keys.set(k, revision().then((rev) => clipKey({ engine: voice.engine || '', revision: rev, voice: voice.id || '', speed, spoken: segments[i].spoken || '' })));
    return keys.get(k);
  };
  const cached = async (i, speed) => {
    if (!store) return null;
    try {
      return await store.get(await keyOf(i, speed));
    } catch (e) {
      store = null; // IndexedDB unusable (private mode, quota): play without the cache
      return null;
    }
  };

  /* ---------- MediaSource ---------- */

  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  let sb = null;
  audio.preservesPitch = true;
  audio.playbackRate = clampRate(requested / genSpeed);
  audio.src = url;
  const opened = new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true })).then(() => {
    sb = ms.addSourceBuffer(MIME);
    sb.mode = 'sequence';
    ms.duration = Infinity;
  });
  let sbChain = opened;
  const sbOp = (fn) => {
    const run = () =>
      new Promise((resolve, reject) => {
        if (!sb || ms.readyState === 'closed') return reject(fail('media', 'MediaSource closed'));
        const done = () => {
          sb.removeEventListener('updateend', done);
          sb.removeEventListener('error', bad);
          resolve();
        };
        const bad = () => {
          sb.removeEventListener('updateend', done);
          sb.removeEventListener('error', bad);
          reject(fail('media', 'SourceBuffer error'));
        };
        sb.addEventListener('updateend', done);
        sb.addEventListener('error', bad);
        try {
          fn(sb);
        } catch (e) {
          sb.removeEventListener('updateend', done);
          sb.removeEventListener('error', bad);
          return reject(e);
        }
        if (!sb.updating) done();
      });
    const p = sbChain.then(run, run);
    sbChain = p.catch(() => {});
    return p;
  };
  sbOp((b) => b.appendBuffer(webmHeader({ inputRate: encoderRate(voice.sampleRate || 24000) }))).catch((e) => die(fail('media', 'Could not start the audio stream', e)));

  const buffered = (us) => {
    if (!sb) return false;
    const t = us / 1e6;
    const r = sb.buffered;
    for (let i = 0; i < r.length; i++) if (t >= r.start(i) - 0.001 && t < r.end(i) - 0.01) return true;
    return false;
  };

  // Append with QuotaExceededError handling: trim played audio and retry, or wait for the
  // playhead to free space (and keep less ahead from then on).
  async function appendBytes(bytes, ep) {
    for (let attempt = 0; ; attempt++) {
      try {
        const t0 = performance.now();
        await sbOp((b) => b.appendBuffer(bytes));
        stats.maxAppendMs = Math.max(stats.maxAppendMs, performance.now() - t0);
        stats.appends++;
        return;
      } catch (e) {
        if (!e || e.name !== 'QuotaExceededError' || !alive(ep)) throw e;
        stats.quotaErrors++;
        const ct = ctUs();
        const start = sb.buffered.length ? Math.round(sb.buffered.start(0) * 1e6) : ct;
        const ahead = appendEndUs - ct;
        highUs = Math.max(20e6, Math.min(highUs, ahead * 0.8));
        lowUs = Math.min(lowUs, highUs / 2);
        if (ct - 2e6 > start + 0.1e6) {
          const to = ct - 2e6;
          await sbOp((b) => b.remove(0, to / 1e6));
          timeline.trimBefore(to);
        } else await new Promise((r) => setTimeout(r, 500));
        if (attempt > 240) throw fail('quota', 'The audio buffer stayed full', e);
      }
    }
  }

  async function appendPackets(packets, entry, ep) {
    if (!packets.length) return;
    const dur = packetsDurationUs(packets);
    const bytes = webmClusters(packets, streamUs);
    streamUs += dur;
    await appendBytes(bytes, ep);
    appendEndUs += dur;
    entry.end += dur;
    stats.appendedUs += dur;
  }

  // Remove everything from us onward and make the next append land there.
  async function cutAt(us) {
    await sbOp((b) => b.remove(us / 1e6, Infinity));
    timeline.truncate(us);
    await sbOp((b) => {
      b.timestampOffset = us / 1e6 + 1e-7; // Chrome truncates to whole microseconds
    });
    appendEndUs = us;
  }

  /* ---------- encoding (work ops only) ---------- */

  function encoder(sr) {
    if (enc && encIn === sr) return enc;
    if (enc) enc.close();
    enc = createEncoder({
      sampleRate: sr,
      onPacket: (p) => {
        if (live) {
          live.push(p);
          schedulePump();
        }
      },
    });
    encIn = sr;
    return enc;
  }

  let pumpTimer = null;
  function schedulePump() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      const ep = epoch;
      work(() => pump(ep)).catch((e) => die(e));
    }, 25);
  }

  async function pump(ep) {
    if (!alive(ep) || !open || open.appended >= open.packets.length) return;
    const pk = open.packets.slice(open.appended);
    open.appended = open.packets.length;
    await appendSpeech(open, pk, ep);
  }

  function feed(index, pcm, sr, speed) {
    if (!seg || seg.index !== index) seg = { index, samples: 0, sr, speed, packets: [], drop: false };
    if (!open) open = { index, offset: seg.samples, packets: [], appended: 0, entry: null };
    live = open.packets;
    encoder(sr).encode(pcm);
    seg.samples += pcm.length;
  }

  async function closePart(ep) {
    if (!open) return;
    const part = open;
    await enc.flush();
    live = null;
    open = null;
    if (!alive(ep)) return;
    const rest = part.packets.slice(part.appended);
    part.appended = part.packets.length;
    if (rest.length) await appendSpeech(part, rest, ep);
    if (seg) for (const p of part.packets) seg.packets.push(p);
  }

  // First packets of a part: splice over old audio or cut unplayed filler, then start an entry.
  async function appendSpeech(part, packets, ep) {
    if (!alive(ep) || (seg && seg.drop)) return;
    if (!part.entry) {
      if (splice && part.offset === 0) {
        const old = timeline.first(part.index);
        if (old && old.start < ctUs() + SPLICE_GUARD_S * 1e6 * rate()) {
          // Too late to replace this one: it plays at the old speed; try the next.
          if (seg) seg.drop = true;
          return;
        }
        if (old) {
          await cutAt(old.start);
          stats.splices++;
        }
        splice = null;
      }
      await cutFiller();
      if (!alive(ep)) return;
      part.entry = timeline.add({ kind: 'speech', index: part.index, start: appendEndUs, end: appendEndUs, offset: part.offset, sampleRate: seg ? seg.sr : 24000, speed: seg ? seg.speed : genSpeed });
      keep.speech();
    }
    await appendPackets(packets, part.entry, ep);
  }

  // Speech is ready while filler is still queued: replace the unplayed filler.
  async function cutFiller() {
    const last = timeline.entries[timeline.length - 1];
    if (!last || last.kind !== 'filler') return;
    const min = ctUs() + FILLER_GUARD_S * 1e6 * rate();
    const at = last.start + Math.ceil(Math.max(0, min - last.start) / FRAME_US) * FRAME_US;
    if (at >= last.end - 2 * FRAME_US) return;
    await cutAt(at);
    stats.fillerCuts++;
  }

  async function finishSeg(index, words, ep) {
    if (!alive(ep)) return;
    if (!seg || seg.index !== index) {
      // Nothing to say (empty segment without a pause).
      est.measure(index, 0);
      return;
    }
    await closePart(ep);
    const s = seg;
    seg = null;
    if (!alive(ep) || s.drop) return;
    timeline.setWords(index, words);
    est.measure(index, (s.samples / s.sr) * s.speed);
    stats.segments++;
    if (store && s.packets.length) {
      const clip = { sampleRate: s.sr, samples: s.samples, speed: s.speed, packets: s.packets, words };
      keyOf(index, s.speed)
        .then((k) => store && store.put(k, clip))
        .then(() => stats.cacheWrites++, () => {});
    }
  }

  async function appendFiller(ep) {
    if (!alive(ep) || eos) return;
    const aheadS = (appendEndUs - ctUs()) / 1e6 / rate();
    if (aheadS >= keep.lowWater) return;
    // Mid-segment: end this part here, so the filler sits between two clips.
    if (open) await closePart(ep);
    if (!alive(ep)) return;
    if (!fillerPackets) {
      const sr = encIn || voice.sampleRate || 24000;
      encoder(sr).encode(comfortNoise({ sampleRate: sr }));
      fillerPackets = await enc.flush();
    }
    if (!alive(ep)) return;
    const last = timeline.speechAt(appendEndUs - 1);
    const entry = timeline.add({ kind: 'filler', index: last ? last.index : nextIndex, start: appendEndUs, end: appendEndUs });
    await appendPackets(fillerPackets, entry, ep);
    const dur = packetsDurationUs(fillerPackets);
    keep.fed(dur);
    stats.fillers++;
    stats.fillerUs += dur;
  }

  async function appendCached(i, clip, ep) {
    if (!alive(ep)) return;
    if (open) await closePart(ep);
    seg = { index: i, samples: clip.samples, sr: clip.sampleRate, speed: clip.speed, packets: [], drop: false };
    const part = { index: i, offset: 0, packets: clip.packets, appended: clip.packets.length, entry: null };
    await appendSpeech(part, clip.packets, ep);
    const s = seg;
    seg = null;
    if (!alive(ep) || s.drop) return;
    timeline.setWords(i, clip.words);
    est.measure(i, (clip.samples / clip.sampleRate) * clip.speed);
    stats.cacheHits++;
    stats.segments++;
  }

  // A batch failed or was cancelled half way: keep or drop the partial segment.
  async function abandon(ep) {
    if (!alive(ep)) return null;
    if (!open && !seg) return null;
    const index = seg ? seg.index : open.index;
    if (open) await closePart(ep);
    seg = null;
    const first = timeline.first(index);
    if (first && first.start >= ctUs() + SPLICE_GUARD_S * 1e6 * rate()) {
      await cutAt(first.start);
      return { index, kept: false };
    }
    return { index, kept: !!first };
  }

  // Everything is appended. endOfStream() is not called: after it, seeking back from the end
  // left Chrome's element stuck at 'ended', and reopening the source is fragile; the tick
  // notices the playhead reaching the end instead.
  async function endStream(ep) {
    if (!alive(ep) || eos) return;
    if (open) await closePart(ep);
    eos = true;
  }

  /* ---------- producer ---------- */

  function wake() {
    if (wakeFn) {
      const f = wakeFn;
      wakeFn = null;
      f();
    }
  }
  const waitWake = (ms) =>
    new Promise((r) => {
      wakeFn = r;
      setTimeout(() => {
        if (wakeFn === r) wakeFn = null;
        r();
      }, ms);
    });

  // Media time from which new audio will be heard (a pending splice point, else the end).
  const fillFrom = () => {
    if (splice) {
      const old = timeline.first(splice.index);
      if (old) return old.start;
    }
    return appendEndUs;
  };

  function planSplice() {
    pendingSplice = false;
    const min = ctUs() + SPLICE_GUARD_S * 1e6 * rate();
    const e = timeline.entries.find((x) => x.kind === 'speech' && x.offset === 0 && x.start >= min && x.speed !== genSpeed);
    if (e && e.index < nextIndex) {
      nextIndex = e.index;
      splice = { index: e.index };
    }
  }

  // Next batch: one segment after a (re)start, then about half the buffered time ahead, up
  // to ~40 s of audio and 12 segments; stops before a cached segment.
  async function pickBatch(from, first, speed) {
    const list = [from];
    if (first) return list;
    const aheadS = Math.max(0, (fillFrom() - ctUs()) / 1e6);
    const room = (playCalled ? highUs : PREFETCH_US) / 1e6 - aheadS;
    const budget = Math.max(4, Math.min(40, aheadS / 2, room));
    let secs = est.seconds(from) / speed;
    for (let i = from + 1; i < n && list.length < 12; i++) {
      const s = est.seconds(i) / speed;
      if (secs + s > budget) break;
      if (store && (await cached(i, speed))) break;
      list.push(i);
      secs += s;
    }
    return list;
  }

  async function produce(ep) {
    let first = true;
    let failures = 0;
    let singleUntil = -1;
    let resting = false;
    while (alive(ep)) {
      if (pendingSplice) planSplice();
      if (nextIndex >= n) {
        await work(() => endStream(ep));
        return;
      }
      // Fill up to the high mark, then rest until below the low mark (fewer, larger batches
      // and an idle CPU in between).
      const ahead = fillFrom() - ctUs();
      const limit = playCalled ? highUs : PREFETCH_US;
      if (ahead >= limit) resting = true;
      else if (ahead < Math.min(lowUs, limit / 2)) resting = false;
      if (resting) {
        await waitWake(1000);
        continue;
      }
      const speed = genSpeed;
      const hit = await cached(nextIndex, speed);
      if (!alive(ep)) return;
      if (pendingSplice) continue;
      if (hit) {
        const i = nextIndex;
        await work(() => appendCached(i, hit, ep));
        if (alive(ep) && nextIndex === i) nextIndex = i + 1;
        first = false;
        continue;
      }
      const idx = await pickBatch(nextIndex, first || nextIndex <= singleUntil, speed);
      if (!alive(ep) || pendingSplice) continue;
      first = false;
      const batch = idx.map((i) => ({ ...segments[i], index: i }));
      const bs = { ep, speed, done: new Set(), chunks: 0, consumed: 0, marksSeen: 0, wordsSeen: 0 };
      const ctl = new AbortController();
      abortCtl = ctl;
      stats.batches++;
      const fastStart = fastNext;
      fastNext = false;
      try {
        const res = await voice.synth(batch, {
          speed,
          signal: ctl.signal,
          fastStart,
          onChunk: (c) => {
            if (!alive(ep) || ctl.signal.aborted) return;
            bs.chunks++;
            work(() => handleChunk(bs, idx, c)).catch((e) => die(e));
          },
        });
        if (abortCtl === ctl) abortCtl = null;
        if (!alive(ep)) return;
        await work(() => reconcile(bs, idx, res));
        failures = 0;
        if (alive(ep) && !ctl.signal.aborted) nextIndex = Math.max(nextIndex, idx[idx.length - 1] + 1);
      } catch (e) {
        if (abortCtl === ctl) abortCtl = null;
        if (!alive(ep)) return;
        const left = idx.find((i) => !bs.done.has(i));
        const partial = await work(() => abandon(ep));
        if (isAbort(e)) {
          // Cancelled for a speed change: carry on from the first unfinished segment (still
          // with a fast start if nothing has been heard yet).
          if (!heardSpeech && fastStart) fastNext = true;
          if (left != null) nextIndex = partial && partial.kept ? partial.index + 1 : left;
          continue;
        }
        failures++;
        stats.failures++;
        if (e && e.code === 'unsupported') return die(fail('unsupported', e.message, e));
        if (failures >= 4) return die(fail('voice', 'The voice failed: ' + ((e && e.message) || e), e));
        if (left == null) continue;
        if (partial && partial.kept) {
          nextIndex = partial.index + 1;
        } else if (idx.length > 1) {
          // Retry one segment at a time to find the one that fails.
          nextIndex = left;
          singleUntil = idx[idx.length - 1];
        } else {
          // This segment cannot be spoken: skip it and say so.
          cb('onError', Object.assign(fail('segment', `Segment ${segIndex(left)} could not be spoken: ${(e && e.message) || e}`, e), { index: segIndex(left) }));
          est.measure(left, 0);
          nextIndex = left + 1;
        }
        await new Promise((r) => setTimeout(r, 200 * failures));
      }
    }
  }

  // Split a chunk of batch audio at segment marks and feed the encoder.
  async function handleChunk(bs, idx, c) {
    if (!alive(bs.ep)) return;
    const sr = c.sampleRate || voice.sampleRate || 24000;
    const end = c.start + c.pcm.length;
    let pos = Math.max(c.start, bs.consumed);
    const words = c.words || [];
    const marks = (c.marks || []).slice().sort((a, b) => a.end - b.end);
    for (const m of marks) {
      if (bs.done.has(m.index)) continue;
      const upto = Math.min(m.end, end);
      if (upto > pos) {
        feed(m.index, c.pcm.subarray(pos - c.start, upto - c.start), sr, bs.speed);
        pos = upto;
      }
      const ws = words.filter((w) => w.index === m.index).map((w) => ({ alignIndex: w.alignIndex, start: w.start - m.start, end: w.end - m.start }));
      bs.done.add(m.index);
      await finishSeg(m.index, ws.length ? ws : null, bs.ep);
      if (!alive(bs.ep)) return;
    }
    if (end > pos) {
      const openIdx = idx.find((i) => !bs.done.has(i));
      if (openIdx != null) feed(openIdx, c.pcm.subarray(pos - c.start), sr, bs.speed);
    }
    bs.consumed = Math.max(bs.consumed, end);
    bs.marksSeen += (c.marks || []).length;
    bs.wordsSeen += words.length;
  }

  // After synth() resolves: whatever did not come through onChunk, and the real speed.
  async function reconcile(bs, idx, res) {
    if (!alive(bs.ep)) return;
    const marks = (res.marks || []).filter((m) => !bs.done.has(m.index));
    if (marks.length || (res.pcm && res.pcm.length > bs.consumed)) {
      const pcm = res.pcm ? res.pcm.subarray(Math.min(res.pcm.length, bs.consumed)) : new Float32Array(0);
      await handleChunk(bs, idx, { sampleRate: res.sampleRate, start: bs.consumed, pcm, marks, words: (res.words || []).filter((w) => !bs.done.has(w.index)) });
    }
    for (const i of idx) if (!bs.done.has(i)) await finishSeg(i, null, bs.ep);
    if (res.speed && res.speed !== bs.speed) {
      // The engine clamped the speed: playbackRate must cover the real one.
      for (const e of timeline.entries) if (e.kind === 'speech' && idx.includes(e.index)) e.speed = res.speed;
    }
  }

  let running = -1; // epoch of the producer loop that is running, if any
  function startProducer(ep) {
    running = ep;
    produce(ep)
      .catch((e) => {
        if (alive(ep)) die(e);
      })
      .finally(() => {
        if (running === ep) running = -1;
      });
  }

  /* ---------- seeking and speed ---------- */

  function abortSynth() {
    if (abortCtl) {
      const c = abortCtl;
      abortCtl = null;
      c.abort();
    }
  }

  function seekOut(i, resume) {
    epoch++;
    const ep = epoch;
    abortSynth();
    wake();
    pendingSplice = false;
    splice = null;
    nextIndex = i;
    fastNext = true;
    stats.seeksOut++;
    // The old audio may play on for a moment: it no longer maps to any segment.
    timeline.clear();
    if (!audio.paused || resume) setState(heardSpeech ? 'buffering' : 'loading');
    work(async () => {
      if (ep !== epoch || destroyed) return;
      live = null;
      open = null;
      seg = null;
      if (enc) enc.reset();
      const t = Math.ceil(ctUs() / 1000) * 1000 + 1000;
      await sbOp((b) => {
        if (ms.readyState === 'open') b.abort();
      });
      await sbOp((b) => b.remove(0, Infinity));
      await sbOp((b) => {
        b.timestampOffset = t / 1e6 + 1e-7;
        if (ms.readyState === 'open' && ms.duration !== Infinity) ms.duration = Infinity;
      });
      timeline.clear();
      appendEndUs = t;
      eos = false;
      keep.speech();
      audio.currentTime = t / 1e6;
      if (resume) audio.play().catch(() => {});
    }).catch((e) => die(e));
    startProducer(ep);
  }

  function seek(i, { resume } = {}) {
    if (destroyed || fatal || !n) return;
    i = Math.max(0, Math.min(n - 1, i | 0));
    // Choosing a segment after the end means: read from there.
    if (state === 'ended') resume = true;
    const first = timeline.first(i);
    current = i;
    currentWord = null;
    cb('onSegment', segIndex(i));
    if (first && first.end > first.start && buffered(first.start)) {
      stats.seeksIn++;
      audio.currentTime = (first.start + CONTENT_LEAD_US) / 1e6 + 1e-6;
      if (resume) {
        setState(heardSpeech ? 'buffering' : 'loading');
        audio.play().catch(() => {});
      }
    } else seekOut(i, resume);
    updatePosition(true);
  }

  function seekBy(deltaS) {
    const p = Math.max(0, docPosition() + deltaS);
    const i = Math.min(n - 1, est.indexAt(p));
    const first = timeline.first(i);
    if (first) {
      const sample = Math.round(((p - est.start(i)) / first.speed) * first.sampleRate);
      const us = timeline.timeOf(i, Math.max(0, sample));
      const part = us != null ? timeline.at(us) : null;
      if (part && part.kind === 'speech' && part.index === i && buffered(us)) {
        stats.seeksIn++;
        audio.currentTime = us / 1e6;
        updatePosition(true);
        return;
      }
    }
    seek(i);
  }

  function regenerate() {
    regenTimer = null;
    if (destroyed || fatal) return;
    const target = snap(requested);
    const ct = ctUs();
    const stale = timeline.entries.some((e) => e.kind === 'speech' && e.start > ct && e.speed !== target);
    if (target === genSpeed && !stale) return;
    genSpeed = target;
    pendingSplice = true;
    // Cancel the running batch unless its open segment is about to be heard (it could not
    // be finished then); a waiting producer replans at once.
    const openStart = open && open.entry ? timeline.first(open.index)?.start ?? open.entry.start : appendEndUs;
    if (abortCtl && openStart >= ct + 2 * SPLICE_GUARD_S * 1e6 * rate()) abortSynth();
    wake();
    // Everything was generated already: start a producer for the regenerated part.
    if (running !== epoch) {
      eos = false;
      startProducer(epoch);
    }
  }

  /* ---------- playhead: callbacks, rate, filler, trimming ---------- */

  function docPosition() {
    const ct = ctUs();
    const e = timeline.speechAt(ct);
    if (!e) return est.start(current >= 0 ? current : nextIndex);
    const first = timeline.first(e.index) || e;
    const within = (Math.max(0, ct - first.start) / 1e6) * e.speed;
    return est.start(e.index) + Math.min(within, est.seconds(e.index));
  }

  function updatePosition(force) {
    if (!session) return;
    const now = performance.now();
    if (!force && now - lastPositionAt < 1000) return;
    lastPositionAt = now;
    const duration = Math.max(1, est.total());
    session.setPosition({ duration, position: Math.min(duration, docPosition()), playbackRate: requested });
  }

  function setState(s) {
    if (s === state || (fatal && s !== 'error')) return;
    state = s;
    if (session) session.setState(s === 'playing' || s === 'buffering' || s === 'loading' ? (audio.paused ? 'paused' : 'playing') : s === 'paused' || s === 'ended' ? 'paused' : 'none');
    cb('onState', s);
    updatePosition(true);
  }

  function die(e) {
    if (fatal || destroyed) return;
    if (isAbort(e)) return;
    fatal = e && e.code ? e : fail('error', (e && e.message) || String(e), e);
    abortSynth();
    epoch++;
    cb('onError', fatal);
    setState('error');
  }

  function schedule(ms) {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = destroyed ? null : setTimeout(tick, ms);
  }

  function tick() {
    tickTimer = null;
    if (destroyed) return;
    const ct = ctUs();
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const playing = !audio.paused && !audio.ended;
    const e = timeline.speechAt(ct);
    const here = timeline.at(ct);
    if (e && here && e.index !== current && here.kind === 'speech') {
      current = e.index;
      currentWord = null;
      cb('onSegment', segIndex(current));
      updatePosition(true);
    }
    if (here && here.kind === 'speech' && o.onWord) {
      const w = timeline.wordAt(ct);
      if (w && w.index === current && (!currentWord || currentWord.alignIndex !== w.alignIndex || currentWord.index !== w.index)) {
        currentWord = w;
        cb('onWord', segIndex(w.index), w.alignIndex);
      }
    }
    const atEnd = eos && (ct >= appendEndUs - 40000 || (audio.readyState < 3 && ct >= appendEndUs - 300000));
    if (atEnd) {
      if (playing && state !== 'ended' && !fatal) {
        setState('ended');
        audio.pause();
      }
    } else if (here && here.kind === 'speech') {
      const want = clampRate(requested / here.speed);
      if (Math.abs(audio.playbackRate - want) > 1e-3) audio.playbackRate = want;
      if (playing && audio.readyState >= 3) {
        heardSpeech = true;
        setState('playing');
      }
    } else if (playing && !fatal && state !== 'ended') setState(heardSpeech ? 'buffering' : 'loading');

    const aheadS = (appendEndUs - ct) / 1e6 / rate();
    if (!fillerQueued && !fatal && !(open && open.packets.length > open.appended) && keep.need({ aheadS, hidden, playing, ended: eos })) {
      fillerQueued = true;
      const ep = epoch;
      work(() => appendFiller(ep))
        .catch((x) => die(x))
        .finally(() => {
          fillerQueued = false;
        });
    }
    if (!eos && !trimming && sb && sb.buffered.length && !sb.updating) {
      const start = Math.round(sb.buffered.start(0) * 1e6);
      if (ct - start > keepBehindUs + 10e6) {
        trimming = true;
        const to = ct - keepBehindUs;
        work(() => sbOp((b) => b.remove(0, to / 1e6)).then(() => timeline.trimBefore(to)))
          .catch(() => {})
          .finally(() => {
            trimming = false;
          });
      }
    }
    if (fillFrom() - ct < lowUs) wake();
    updatePosition(false);

    // Wake at the next segment boundary, and while visible at the next word, so callbacks are
    // not a whole tick late.
    let delay = hidden ? 250 : 40;
    let nb = playing ? timeline.nextBoundary(ct) : null;
    if (playing && !hidden && o.onWord && here && here.words) {
      for (const w of here.words)
        if (w.start > ct) {
          if (nb == null || w.start < nb) nb = w.start;
          break;
        }
    }
    if (nb != null) {
      const d = (nb - ct) / 1e3 / rate();
      if (d >= 0 && d + 3 < delay) delay = Math.max(4, d + 3);
    }
    schedule(delay);
  }

  /* ---------- element events and Media Session ---------- */

  on(audio, 'playing', () => tick());
  on(audio, 'waiting', () => {
    if (eos && ctUs() >= appendEndUs - 300000) return tick(); // the end, not a stall
    if (!audio.paused && !fatal && state !== 'ended') setState(heardSpeech ? 'buffering' : 'loading');
  });
  on(audio, 'pause', () => {
    // A 'pause' queued before this session (the previous player's destroy) arrives late.
    if (!audio.paused) return;
    if (!audio.ended && !fatal && state !== 'ended') setState('paused');
  });
  on(audio, 'error', () => {
    const err = audio.error;
    die(fail('media', 'Audio playback failed' + (err ? ': ' + (err.message || 'code ' + err.code) : ''), err));
  });
  if (typeof document !== 'undefined') on(document, 'visibilitychange', () => schedule(0));

  const player = {
    get state() {
      return state;
    },
    get index() {
      return current >= 0 ? segIndex(current) : segIndex(nextIndex);
    },
    get speed() {
      return requested;
    },
    get generatedSpeed() {
      return genSpeed;
    },
    get stats() {
      const ct = ctUs();
      return { ...stats, aheadS: (appendEndUs - ct) / 1e6, appendEndS: appendEndUs / 1e6, currentTime: ct / 1e6, playbackRate: audio.playbackRate, fillerRun: keep.run / 1e6, state, generatedSpeed: genSpeed, requested, nextIndex, eos, duration: est.total(), position: docPosition() };
    },
    timeline,
    estimates: est,
    play() {
      if (destroyed || fatal) return Promise.resolve();
      const wasEnded = state === 'ended';
      playCalled = true;
      const p = audio.play(); // first, while the user's tap still counts
      if (wasEnded) seek(0, { resume: true });
      else if (state === 'paused' || state === null) setState(heardSpeech ? 'buffering' : 'loading');
      wake();
      schedule(0);
      return p.catch((e) => {
        if (e && e.name === 'NotAllowedError') cb('onError', fail('not-allowed', 'Playback must start from a tap', e));
      });
    },
    pause() {
      if (destroyed) return;
      audio.pause();
      if (!fatal && state !== 'ended') setState('paused');
    },
    seek,
    seekBy,
    // Continue with another voice in the same session (e.g. Piper after Kokoro failed with the
    // screen off): what is buffered keeps playing, generation goes on from the next segment,
    // and the <audio> source never changes. Also recovers from a 'voice' error.
    setVoice(v) {
      if (destroyed) return;
      if (noPcm(v)) throw fail('unsupported', 'This voice produces no audio data (system voices use speak())');
      voice = v;
      fastNext = true;
      keys.clear();
      revisionP = null;
      if (fatal && (fatal.code === 'voice' || fatal.code === 'unsupported')) {
        fatal = null;
        epoch++;
        // Drop the dead voice's half-encoded segment; generation restarts from it.
        work(async () => {
          live = null;
          open = null;
          seg = null;
          if (enc) enc.reset();
        });
        setState(audio.paused ? 'paused' : heardSpeech ? 'buffering' : 'loading');
      }
      abortSynth(); // the producer carries on from the first unfinished segment
      wake();
      if (running !== epoch) {
        eos = false;
        startProducer(epoch);
      }
    },
    setSpeed(r) {
      if (destroyed) return;
      requested = Math.min(MAX_SPEED, Math.max(MIN_SPEED, +r || 1));
      const here = timeline.at(ctUs());
      const sp = here && here.kind === 'speech' ? here.speed : genSpeed;
      audio.preservesPitch = true;
      audio.playbackRate = clampRate(requested / sp);
      updatePosition(true);
      if (regenTimer) clearTimeout(regenTimer);
      regenTimer = setTimeout(regenerate, regenMs);
    },
    // Ogg/Opus of the document from the clip cache at the current model speed.
    async exportOgg({ from = 0, to = n, tags } = {}) {
      if (!store) throw fail('unsupported', 'No clip cache');
      const ks = [];
      for (let i = from; i < to; i++) ks.push(await keyOf(i, genSpeed));
      return store.exportOgg(ks, { tags: { title: o.metadata && o.metadata.title, artist: o.metadata && o.metadata.artist, ...tags } });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      epoch++;
      abortSynth();
      wake();
      for (const t of [tickTimer, regenTimer, pumpTimer]) if (t) clearTimeout(t);
      for (const [t, ev, fn] of listeners) t.removeEventListener(ev, fn);
      if (session) session.destroy();
      try {
        audio.pause();
      } catch (e) {
        /* ignore */
      }
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch (e) {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      if (enc) enc.close();
      if (store && !(o.cache && typeof o.cache === 'object')) store.close();
    },
  };

  const session =
    o.mediaSession === false
      ? null
      : createMediaSession({
          metadata: { title: '', artist: 'Readout', ...(o.metadata || {}) },
          skipSeconds: o.skipSeconds || 10,
          handlers: {
            play: () => player.play(),
            pause: () => player.pause(),
            stop: () => player.pause(),
            previous: () => {
              // Well into a segment: back to its start; otherwise the previous one.
              const first = current >= 0 ? timeline.first(current) : null;
              const into = first ? (ctUs() - first.start) / 1e6 / rate() : 0;
              seek(into > 3 ? current : Math.max(0, (current >= 0 ? current : nextIndex) - 1));
            },
            next: () => {
              const c = current >= 0 ? current : nextIndex;
              if (c + 1 < n) seek(c + 1);
            },
            seekTo: (t) => seek(est.indexAt(t)),
            seekBy: (d) => seekBy(d),
          },
        });

  setState('loading');
  startProducer(epoch);
  schedule(0);
  return player;
}
