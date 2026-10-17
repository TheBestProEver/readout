// Kokoro's tokenizer, call planning and timings. Pure: no workers, no ORT, so it runs
// in Node tests. The model takes one token per phoneme character, wrapped in '$' (id 0).
import { spokenWords, alignEntries, alignToPhonemes } from './words.js';

// Vocabulary from hexgrad/Kokoro-82M config.json (Apache-2.0); identical to the
// onnx-community tokenizer.json at the pinned revision, which adds '$' = 0.
export const VOCAB = Object.freeze({
  '$': 0,
  ';': 1, ':': 2, ',': 3, '.': 4, '!': 5, '?': 6, '—': 9, '…': 10, '"': 11, '(': 12, ')': 13,
  '“': 14, '”': 15, ' ': 16, '̃': 17, 'ʣ': 18, 'ʥ': 19, 'ʦ': 20, 'ʨ': 21, 'ᵝ': 22, 'ꭧ': 23, 'A': 24,
  'I': 25, 'O': 31, 'Q': 33, 'S': 35, 'T': 36, 'W': 39, 'Y': 41, 'ᵊ': 42, 'a': 43, 'b': 44, 'c': 45,
  'd': 46, 'e': 47, 'f': 48, 'h': 50, 'i': 51, 'j': 52, 'k': 53, 'l': 54, 'm': 55, 'n': 56, 'o': 57,
  'p': 58, 'q': 59, 'r': 60, 's': 61, 't': 62, 'u': 63, 'v': 64, 'w': 65, 'x': 66, 'y': 67, 'z': 68,
  'ɑ': 69, 'ɐ': 70, 'ɒ': 71, 'æ': 72, 'β': 75, 'ɔ': 76, 'ɕ': 77, 'ç': 78, 'ɖ': 80, 'ð': 81, 'ʤ': 82,
  'ə': 83, 'ɚ': 85, 'ɛ': 86, 'ɜ': 87, 'ɟ': 90, 'ɡ': 92, 'ɥ': 99, 'ɨ': 101, 'ɪ': 102, 'ʝ': 103,
  'ɯ': 110, 'ɰ': 111, 'ŋ': 112, 'ɳ': 113, 'ɲ': 114, 'ɴ': 115, 'ø': 116, 'ɸ': 118, 'θ': 119, 'œ': 120,
  'ɹ': 123, 'ɾ': 125, 'ɻ': 126, 'ʁ': 128, 'ɽ': 129, 'ʂ': 130, 'ʃ': 131, 'ʈ': 132, 'ʧ': 133, 'ʊ': 135,
  'ʋ': 136, 'ʌ': 138, 'ɣ': 139, 'ɤ': 140, 'χ': 142, 'ʎ': 143, 'ʒ': 147, 'ʔ': 148, 'ˈ': 156, 'ˌ': 157,
  'ː': 158, 'ʰ': 162, 'ʲ': 164, '↓': 169, '→': 171, '↗': 172, '↘': 173, 'ᵻ': 177,
});

export const PAD = 0;
export const SPACE = 16;
export const MAX_TOKENS = 500; // per call, pads included (the model breaks above 512)
export const MAX_CONTENT = MAX_TOKENS - 2;
export const SAMPLE_RATE = 24000;
export const STEP_SAMPLES = 600; // one duration step at 24 kHz
export const STYLE_DIM = 256;
export const STYLE_ROWS = 510;

const PUNCT = new Set([';', ':', ',', '.', '!', '?', '—', '…', '"', '(', ')', '“', '”']);
const PAUSE_PUNCT = new Set([',', ';', ':', '—', '…', '.', '!', '?']);
const STRESS = new Set(['ˈ', 'ˌ']);

// Phonemes -> the characters the model knows, whitespace collapsed to single spaces.
// Unknown characters are dropped, as Kokoro's own tokenizer does (no Unicode normalization:
// NFC would fuse a + combining tilde into a character the vocabulary lacks).
export function tokenize(phonemes) {
  let chars = '';
  let dropped = 0;
  for (const ch of String(phonemes || '')) {
    if (/\s/.test(ch)) {
      if (chars && chars[chars.length - 1] !== ' ') chars += ' ';
    } else if (ch !== '$' && VOCAB[ch] !== undefined) chars += ch;
    else dropped++;
  }
  chars = chars.trim();
  // Spread syntax keeps astral characters whole; every vocab symbol is one code unit anyway.
  const symbols = [...chars];
  return { symbols, ids: symbols.map((c) => VOCAB[c]), dropped };
}

// The style vector for a call of n tokens (pads included): voice row min(max(n-2,0),509).
export function styleRow(voice, n) {
  const row = Math.min(Math.max(n - 2, 0), STYLE_ROWS - 1);
  return voice.subarray(row * STYLE_DIM, row * STYLE_DIM + STYLE_DIM);
}

// Space-separated phoneme words over token indices, leading/trailing punctuation excluded.
export function phonemeWords(symbols) {
  const out = [];
  let i = 0;
  while (i < symbols.length) {
    while (i < symbols.length && symbols[i] === ' ') i++;
    let j = i;
    while (j < symbols.length && symbols[j] !== ' ') j++;
    let a = i;
    let b = j;
    while (a < b && PUNCT.has(symbols[a])) a++;
    while (b > a && PUNCT.has(symbols[b - 1])) b--;
    if (b > a) {
      let weight = 0;
      for (let k = a; k < b; k++) if (!STRESS.has(symbols[k]) && !PUNCT.has(symbols[k])) weight++;
      out.push({ start: a, end: b, weight: Math.max(1, weight) });
    }
    i = j;
  }
  return out;
}

// Where to cut a too-long token run: at a space, preferably right after pause punctuation,
// close to an even split. Returns [start, end) ranges that skip the cut spaces.
export function splitTokens(symbols, max = MAX_CONTENT, start = 0, end = symbols.length) {
  const out = [];
  let a = start;
  while (end - a > max) {
    const pieces = Math.ceil((end - a) / max);
    const target = (end - a) / pieces;
    const lo = a + Math.max(1, Math.floor(target * 0.6));
    const hi = Math.min(a + max, a + Math.ceil(target * 1.4));
    let best = -1;
    let bestScore = Infinity;
    for (let k = lo; k <= hi && k < end; k++) {
      if (symbols[k] !== ' ') continue;
      const score = Math.abs(k - (a + target)) / target + (PAUSE_PUNCT.has(symbols[k - 1]) ? 0 : 0.35);
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best < 0) {
      // No space in range (a run of symbols with no word breaks): hard cut.
      out.push([a, a + max]);
      a += max;
    } else {
      out.push([a, best]);
      a = best + 1;
    }
  }
  if (end > a) out.push([a, end]);
  return out;
}

// For a fast first chunk: a cut after pause punctuation, the latest one between tokens lo
// and hi, else the earliest one up to far, or -1. Only punctuation: cutting the very first
// words heard mid-phrase gives them a sentence-final fall. A call costs about 0.3 s plus
// 16 ms per token on an Arc 140V (twice that when the GPU is shared), so cutting an
// 85-token opening sentence at its comma starts audio ~0.7-1.4 s sooner; an opening sentence
// can also have its first pause (a colon) only at token 86-91.
function earlyCut(symbols, lo, hi, far = hi) {
  for (let k = Math.min(hi, symbols.length - 1); k >= lo; k--) if (symbols[k] === ' ' && PAUSE_PUNCT.has(symbols[k - 1])) return k;
  for (let k = hi + 1; k <= far && k < symbols.length - 1; k++) if (symbols[k] === ' ' && PAUSE_PUNCT.has(symbols[k - 1])) return k;
  return -1;
}

// Prepares segments: tokens, word ranges in token coordinates, and units (pieces of at
// most MAX_CONTENT tokens) ready for grouping into model calls.
// phonemize(seg) -> phoneme string. Segments without tokens become pure pauses.
export function prepareSegments(segments, phonemize, { fastStart = false } = {}) {
  const segs = [];
  const units = [];
  for (const seg of segments) {
    const tok = tokenize(phonemize(seg));
    const sw = spokenWords(seg.spoken || '');
    const ranges = alignToPhonemes(sw, phonemeWords(tok.symbols), seg.spoken || '', tok.symbols);
    const entries = alignEntries(seg, sw).map((e) => {
      let s = Infinity;
      let t = -Infinity;
      for (let w = e.from; w < e.to; w++) {
        const r = ranges[w];
        if (!r) continue;
        s = Math.min(s, r[0]);
        t = Math.max(t, r[1]);
      }
      return s <= t ? { alignIndex: e.alignIndex, tokStart: s, tokEnd: t } : null;
    }).filter(Boolean);
    const s = { seg, index: seg.index, symbols: tok.symbols, ids: tok.ids, dropped: tok.dropped, entries, pauseAfterMs: Math.max(0, +seg.pauseAfterMs || 0), units: [] };
    let pieces = tok.ids.length ? splitTokens(tok.symbols) : [];
    if (fastStart && !units.length && pieces.length && pieces[0][1] - pieces[0][0] > 60) {
      // Keep at least 20 tokens after the cut (a scrap costs a call's fixed overhead).
      const a0 = pieces[0][0];
      const last = pieces[0][1] - 20;
      const cut = earlyCut(tok.symbols, a0 + 25, Math.min(a0 + 60, last), Math.min(a0 + 100, last));
      if (cut > 0) pieces = [[pieces[0][0], cut], [cut + 1, pieces[0][1]], ...pieces.slice(1)];
    }
    pieces.forEach(([a, b], k) => {
      const u = { seg: s, from: a, to: b, ids: tok.ids.slice(a, b), last: k === pieces.length - 1 };
      s.units.push(u);
      units.push(u);
    });
    segs.push(s);
  }
  return { segs, units };
}

// Groups units into calls: the first call aims for firstMin-firstMax tokens (fast start),
// later calls are filled until they reach min tokens, never above max (or MAX_TOKENS).
export function groupUnits(units, { fastStart = false, firstMin = 40, firstMax = 60, min = 150, max = 400 } = {}) {
  const calls = [];
  let cur = null;
  for (const u of units) {
    const first = fastStart && calls.length === 0;
    const want = first ? firstMin : min;
    const cap = Math.min(first ? firstMax : max, MAX_TOKENS);
    if (cur && cur.tokens < want && cur.tokens + 1 + u.ids.length <= cap) {
      cur.units.push(u);
      cur.tokens += 1 + u.ids.length;
    } else {
      if (cur) calls.push(cur);
      cur = { units: [u], tokens: 2 + u.ids.length };
    }
  }
  if (cur) calls.push(cur);
  return calls;
}

// Input ids for a call and where each unit's tokens start in it.
export function callIds(call) {
  const ids = [PAD];
  const starts = [];
  call.units.forEach((u, k) => {
    if (k) ids.push(SPACE);
    starts.push(ids.length);
    for (const id of u.ids) ids.push(id);
  });
  ids.push(PAD);
  return { ids, starts };
}

// Kokoro rounds each predicted duration (already divided by speed) half-to-even and
// clamps it to at least one step, then renders 600 samples per step; the durations output
// is the unrounded value. Rounding it the same way gives exact token boundaries (the
// waveform is always exactly 600 x the step count; a plain cumulative sum drifts by
// 50-100 ms over a sentence).
export function roundHalfEven(v) {
  const f = Math.floor(v);
  const r = v - f;
  if (r > 0.5) return f + 1;
  if (r < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function tokenPositions(durations, wavLength) {
  const n = durations.length;
  const steps = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = Number(durations[i]);
    steps[i] = Number.isFinite(d) ? Math.max(1, roundHalfEven(d)) : 1;
    total += steps[i];
  }
  const ratio = total > 0 ? wavLength / total : STEP_SAMPLES;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + steps[i] * ratio;
  return { cum, ratio, exact: Math.abs(ratio - STEP_SAMPLES) < 1e-6 };
}

// Sample position of a fractional token index.
export function posAt(cum, t) {
  const n = cum.length - 1;
  if (t <= 0) return cum[0];
  if (t >= n) return cum[n];
  const k = Math.floor(t);
  return cum[k] + (t - k) * (cum[k + 1] - cum[k]);
}

// Where to start and stop a call's audio: most of the leading and trailing pad tokens are
// silence (about 375 ms at the start), which would make gaps between calls much longer
// than the pause between sentences inside one call. Keeps a margin, and never cuts sound.
export function trimBounds(wav, cum, sr = SAMPLE_RATE, { margin = 0.05, threshold = 0.02 } = {}) {
  const n = cum.length - 1;
  const len = wav.length;
  const m = Math.round(margin * sr);
  const padEnd = Math.round(cum[1]);
  let onset = padEnd;
  for (let i = 0; i < padEnd && i < len; i++) {
    if (Math.abs(wav[i]) > threshold) {
      onset = i;
      break;
    }
  }
  const start = Math.max(0, Math.min(padEnd, onset) - m);
  const tailStart = Math.round(cum[n - 1]);
  let offset = tailStart;
  for (let i = len - 1; i > tailStart; i--) {
    if (Math.abs(wav[i]) > threshold) {
      offset = i;
      break;
    }
  }
  const end = Math.min(len, Math.max(tailStart, offset) + m);
  return { start, end: Math.max(start, end) };
}

// Where to cut between two units in one call: the start of the latest quiet 5 ms frame
// between 60 ms before the joining space and its end. The pause stays with the first
// unit, and the second starts just before its first sound, so segment marks switch when
// the next sentence is actually heard.
export function quietCut(wav, cum, space, sr = SAMPLE_RATE) {
  const frame = Math.max(1, Math.round(0.005 * sr));
  const lo = Math.max(0, Math.round(cum[space] - 0.06 * sr));
  const hi = Math.min(wav.length, Math.round(cum[space + 1]));
  if (hi - lo < frame) return Math.round(cum[space]);
  const rms = [];
  let min = Infinity;
  for (let a = lo; a + frame <= hi; a += frame) {
    let s = 0;
    for (let i = a; i < a + frame; i++) s += wav[i] * wav[i];
    const r = Math.sqrt(s / frame);
    rms.push(r);
    if (r < min) min = r;
  }
  const quiet = Math.max(min * 1.5, 0.002);
  for (let k = rms.length - 1; k >= 0; k--) if (rms[k] <= quiet) return lo + k * frame;
  return Math.round(cum[space]);
}
