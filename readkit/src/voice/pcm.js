// Small PCM helpers shared by the engines and calibration.

// NaN count, RMS and peak over the finite samples.
export function levels(pcm, from = 0, to = pcm.length) {
  let nan = 0;
  let ss = 0;
  let peak = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = pcm[i];
    if (!Number.isFinite(v)) {
      nan++;
      continue;
    }
    ss += v * v;
    n++;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return { nan, rms: n ? Math.sqrt(ss / n) : 0, peak, samples: to - from };
}

// In place: non-finite samples -> 0, everything clamped to [-1, 1]. Returns counts.
export function sanitize(pcm) {
  let nan = 0;
  let clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (!Number.isFinite(v)) {
      pcm[i] = 0;
      nan++;
    } else if (v > 1) {
      pcm[i] = 1;
      clipped++;
    } else if (v < -1) {
      pcm[i] = -1;
      clipped++;
    }
  }
  return { nan, clipped };
}

// Share of RMS above fc (default 6 kHz): two cascaded RBJ biquad high-passes (4th order).
// onnxruntime issue #29807's WebGPU timbre corruption shows up as a shift in this number.
export function highBandShare(pcm, sr, fc = 6000) {
  if (!pcm.length || fc >= sr / 2) return 0;
  const w = (2 * Math.PI * fc) / sr;
  const c = Math.cos(w);
  const a = Math.sin(w) / (2 * Math.SQRT1_2);
  const b0 = (1 + c) / 2 / (1 + a);
  const b1 = -(1 + c) / (1 + a);
  const b2 = b0;
  const a1 = (-2 * c) / (1 + a);
  const a2 = (1 - a) / (1 + a);
  let e = 0;
  let eh = 0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = Number.isFinite(pcm[i]) ? pcm[i] : 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    const z = b0 * y + b1 * u1 + b2 * u2 - a1 * z1 - a2 * z2;
    u2 = u1;
    u1 = y;
    z2 = z1;
    z1 = z;
    e += x * x;
    eh += z * z;
  }
  return e > 0 ? Math.sqrt(eh / e) : 0;
}

// First and last sample above threshold, as [start, end); [0, 0] for silence.
export function voicedRange(pcm, threshold = 0.01, from = 0, to = pcm.length) {
  let a = from;
  while (a < to && Math.abs(pcm[a]) <= threshold) a++;
  if (a >= to) return [from, from];
  let b = to;
  while (b > a && Math.abs(pcm[b - 1]) <= threshold) b--;
  return [a, b];
}

// Raised-cosine fades, in place, so inserted silence never starts or ends with a click.
export function fadeOut(pcm, end, n) {
  const s = Math.max(0, end - n);
  const len = end - s;
  for (let i = 0; i < len; i++) pcm[s + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / len);
}

export function fadeIn(pcm, start, n) {
  const len = Math.min(n, pcm.length - start);
  for (let i = 0; i < len; i++) pcm[start + i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / len);
}

export function concat(parts, total) {
  if (total === undefined) total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The silence a listener hears at a segment boundary, the same rule for every engine.
// Voices end a sentence with very different amounts of their own silence (tail + next lead:
// Piper ryan ~25 ms, lessac 150-250 ms, hfc_male 200-400 ms; Kokoro 550-800 ms), so a fixed
// pad made some voices rush and others drag, and a planned pause added whole on top of
// Kokoro's long natural pause gave 1.35-1.45 s paragraph breaks against Piper's 0.85-1 s.
// The pad tops the natural silence up to target + 6/7 of the planned pause: at speed 1 a
// sentence end ~0.5 s, a list item (350) ~0.8 s, a heading (500) ~0.93 s and a paragraph
// (700) ~1.1 s for Kokoro and Piper alike; a voice whose own pause is longer keeps it. A
// planned pause always adds at least 30% of itself, so the break is heard as one.
// All arguments and the result are in samples (target already divided by the speed).
export const SENTENCE_GAP_MS = 500;
export const PLANNED_SHARE = 6 / 7;
export const PLANNED_MIN_SHARE = 0.3;
export function gapSamples({ tail = 0, lead = 0, target = 0, planned = 0 }) {
  const natural = tail + lead;
  return Math.max(0, Math.round(target + PLANNED_SHARE * planned - natural), Math.round(PLANNED_MIN_SHARE * planned));
}

export function msToSamples(ms, sr) {
  return Math.max(0, Math.round(((+ms || 0) * sr) / 1000));
}

// Silent samples at the start and end of pcm: whole 5 ms frames whose RMS is below
// threshold (about -40 dBFS by default), so breath and a soft decay count as silence.
// Returns { lead, tail }; all-silent input gives lead = tail = pcm.length.
export function quietEdges(pcm, sr, threshold = 0.01) {
  const f = Math.max(1, Math.round(0.005 * sr));
  const quiet = (a) => {
    let s = 0;
    for (let i = a; i < a + f; i++) s += pcm[i] * pcm[i];
    return Math.sqrt(s / f) < threshold;
  };
  let lead = 0;
  while (lead + f <= pcm.length && quiet(lead)) lead += f;
  if (lead + f > pcm.length) return { lead: pcm.length, tail: pcm.length };
  let tail = 0;
  while (pcm.length - tail - f >= lead && quiet(pcm.length - tail - f)) tail += f;
  return { lead, tail };
}
