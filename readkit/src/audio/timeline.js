// Timeline: which segment and word is heard at a given media time, and the document
// position estimate used for the lock screen.
//
// Media times are integer microseconds. Every clip starts with the encoder's 6.5 ms of
// priming (pre-skip 312 at 48 kHz), and the decoder drops the stream's CodecDelay (the same
// 6.5 ms) at the start, so each clip's first input sample is heard at the clip's start time:
// the two cancel out. CONTENT_LEAD_US keeps that offset in one place.
export const CONTENT_LEAD_US = 0;

// Entry: { kind: 'speech' | 'filler', index, start, end, offset (samples into the segment
// where this part starts), sampleRate, speed (generated), words: [{ alignIndex, start, end }]
// in media us, or null }. A segment can have several parts when playback ran dry while it
// was being generated.
export function createTimeline() {
  let entries = [];

  // Last entry with start <= us (binary search; entries are in time order).
  const floor = (us) => {
    let lo = 0;
    let hi = entries.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].start <= us) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };

  const tl = {
    get entries() {
      return entries;
    },
    get end() {
      return entries.length ? entries[entries.length - 1].end : 0;
    },
    get length() {
      return entries.length;
    },
    add(e) {
      const last = entries[entries.length - 1];
      if (last && e.start < last.end) throw new Error(`timeline: entry at ${e.start} overlaps ${last.end}`);
      const entry = { kind: 'speech', index: -1, start: 0, end: e.start, offset: 0, sampleRate: 24000, speed: 1, words: null, ...e };
      entries.push(entry);
      return entry;
    },
    // Entry containing us (start <= us < end), or null.
    at(us) {
      const i = floor(us);
      return i >= 0 && us < entries[i].end ? entries[i] : null;
    },
    // The speech entry heard at us. In filler, in a hole or past the end, the last speech
    // entry before it (the highlight stays put while the voice catches up).
    speechAt(us) {
      for (let i = floor(us); i >= 0; i--) if (entries[i].kind === 'speech') return entries[i];
      return null;
    },
    // { index, alignIndex } of the word heard at us, or the last word started before it in
    // the same segment.
    wordAt(us) {
      const e = tl.speechAt(us);
      if (!e) return null;
      let best = null;
      for (let i = floor(us); i >= 0; i--) {
        const x = entries[i];
        if (x.kind !== 'speech') continue;
        if (x.index !== e.index) break;
        if (x.words)
          for (const w of x.words) {
            if (w.start <= us && (!best || w.start >= best.start)) best = w;
          }
        if (best) break;
      }
      return best ? { index: e.index, alignIndex: best.alignIndex, start: best.start, end: best.end } : null;
    },
    // First part of segment index (the one with offset 0), or null.
    first(index) {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === 'speech' && entries[i].index === index && entries[i].offset === 0) return entries[i];
      return null;
    },
    parts(index) {
      return entries.filter((e) => e.kind === 'speech' && e.index === index);
    },
    // Media time of a sample within segment index, or null if that part is not here.
    timeOf(index, sample) {
      let best = null;
      for (const e of entries) if (e.kind === 'speech' && e.index === index && e.offset <= sample && (!best || e.offset >= best.offset)) best = e;
      if (!best) return null;
      return best.start + CONTENT_LEAD_US + Math.round(((sample - best.offset) / best.sampleRate) * 1e6);
    },
    // Attach a finished segment's words (sample ranges within the segment) to its parts.
    setWords(index, words) {
      const ps = tl.parts(index);
      if (!ps.length || !words) return;
      for (const p of ps) p.words = [];
      for (const w of words) {
        let part = ps[0];
        for (const p of ps) if (p.offset <= w.start) part = p;
        const at = (s) => part.start + CONTENT_LEAD_US + Math.round(((s - part.offset) / part.sampleRate) * 1e6);
        part.words.push({ alignIndex: w.alignIndex, start: at(w.start), end: Math.min(part.end, at(Math.max(w.start, w.end))) });
      }
    },
    // Drop entries starting at or after us (a splice); an entry spanning us is cut to end there.
    truncate(us) {
      const removed = [];
      while (entries.length && entries[entries.length - 1].start >= us) removed.unshift(entries.pop());
      const last = entries[entries.length - 1];
      if (last && last.end > us) last.end = us;
      return removed;
    },
    // Forget entries that ended before us (played audio trimmed from the SourceBuffer).
    trimBefore(us) {
      let k = 0;
      while (k < entries.length - 1 && entries[k].end <= us) k++;
      if (k) entries = entries.slice(k);
    },
    clear() {
      entries = [];
    },
    // Next time after us where the heard segment or the generated speed can change.
    nextBoundary(us) {
      const i = floor(us);
      const e = i >= 0 ? entries[i] : null;
      if (e && us < e.end) return e.end;
      return i + 1 < entries.length ? entries[i + 1].start : null;
    },
  };
  return tl;
}

/* ---------- document position estimate (seconds at speed 1) ---------- */

// Fenwick tree over n values.
function fenwick(n) {
  const t = new Float64Array(n + 1);
  return {
    add(i, v) {
      for (i++; i <= n; i += i & -i) t[i] += v;
    },
    // Sum of values [0, i).
    sum(i) {
      let s = 0;
      for (; i > 0; i -= i & -i) s += t[i];
      return s;
    },
  };
}

// Estimated speech length of every segment, refined as segments are generated: unmeasured
// segments use characters x the measured seconds per character (starting from about 15
// characters per second), plus their pause. Lets the lock screen show a finite duration and
// map a seek bar position to a segment.
export function createEstimates(segments, { charsPerSec = 15 } = {}) {
  const n = segments.length;
  const chars = fenwick(n);
  const pause = fenwick(n);
  const measured = fenwick(n);
  const known = new Float64Array(n).fill(-1);
  const len = new Float64Array(n);
  let spc = 1 / charsPerSec;
  let sumChars = 0;
  let sumSec = 0;
  segments.forEach((s, i) => {
    const text = String(s.spoken || '');
    len[i] = text.trim() ? text.length : 0;
    chars.add(i, len[i]);
    pause.add(i, (+s.pauseAfterMs || 0) / 1000);
  });
  const prefix = (i) => measured.sum(i) + chars.sum(i) * spc + pause.sum(i);
  const seconds = (i) => (known[i] >= 0 ? known[i] : len[i] * spc + (+segments[i].pauseAfterMs || 0) / 1000);
  return {
    get secondsPerChar() {
      return spc;
    },
    seconds,
    // Start of segment i in document seconds.
    start: (i) => prefix(Math.max(0, Math.min(n, i))),
    total: () => prefix(n),
    // Segment heard at document second t.
    indexAt(t) {
      if (n === 0) return 0;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (prefix(mid) <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    // A segment was generated: secs is its length at speed 1 (audio seconds x generated speed).
    measure(i, secs) {
      if (i < 0 || i >= n || !(secs >= 0)) return;
      const ps = (+segments[i].pauseAfterMs || 0) / 1000;
      if (known[i] < 0) {
        chars.add(i, -len[i]);
        pause.add(i, -ps);
        if (len[i] > 0 && secs - ps > 0.05) {
          sumChars += len[i];
          sumSec += secs - ps;
          if (sumChars > 40) spc = sumSec / sumChars;
        }
      } else measured.add(i, -known[i]);
      known[i] = secs;
      measured.add(i, secs);
    },
  };
}
