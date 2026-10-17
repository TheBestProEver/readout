// Keeping a hidden Android page alive. Chrome counts output below -72.25 dBFS as silence,
// and on Android a hidden page that has been silent for about a minute (after a 30 s grace)
// is frozen, workers and all, so speech generation would stop. When the player runs dry while
// hidden it plays comfort noise at about -57 dBFS instead (about -59 dBFS after Opus), in 2 s
// clips, and never more than about 25 s in a row: past that, generation is stuck rather than
// slow, and hiss would only hide it.

export const FILLER_SECONDS = 2;
export const FILLER_DBFS = -56; // input level; Opus brings it to about -58 dBFS
export const SILENCE_DBFS = -72.25; // Chrome's audibility threshold
export const MAX_FILLER_US = 24000000;
export const LOW_WATER_S = 1; // wall-clock seconds of audio left that count as running dry

export function rmsDbfs(pcm, from = 0, to = pcm.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += pcm[i] * pcm[i];
  return to > from && s > 0 ? 10 * Math.log10(s / (to - from)) : -Infinity;
}

// Soft, low-passed noise (a gentle rumble rather than hiss) at an exact RMS level, with
// 10 ms fades so clips join each other and speech without clicks.
export function comfortNoise({ sampleRate = 24000, seconds = FILLER_SECONDS, dbfs = FILLER_DBFS, seed = 0x2545f491 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const x = new Float32Array(n);
  let s = seed >>> 0 || 1;
  let y = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 1200) / sampleRate); // one-pole low-pass at ~1.2 kHz
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    y += a * ((s / 4294967296) * 2 - 1 - y);
    x[i] = y;
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += x[i] * x[i];
  const k = Math.pow(10, dbfs / 20) / Math.sqrt(ss / n || 1);
  const fade = Math.min(n >> 1, Math.round(0.01 * sampleRate));
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i / fade, (n - 1 - i) / fade);
    x[i] *= k * (g < 1 ? 0.5 - 0.5 * Math.cos(Math.PI * g) : 1);
  }
  return x;
}

// Decides when to append filler. The player calls need() on every tick and fed() /
// speech() as it appends.
export function createKeepAlive({ maxFillerUs = MAX_FILLER_US, lowWaterS = LOW_WATER_S, whenVisible = false } = {}) {
  let run = 0; // consecutive filler, us
  let total = 0;
  let count = 0;
  return {
    lowWater: lowWaterS,
    get run() {
      return run;
    },
    get total() {
      return total;
    },
    get count() {
      return count;
    },
    // aheadS: wall-clock seconds of audio buffered past the playhead.
    need({ aheadS, hidden, playing, ended }) {
      if (ended || !playing) return false;
      if (!hidden && !whenVisible) return false;
      if (run >= maxFillerUs) return false;
      return aheadS < lowWaterS;
    },
    fed(us) {
      run += us;
      total += us;
      count++;
    },
    speech() {
      run = 0;
    },
    get capped() {
      return run >= maxFillerUs;
    },
  };
}
