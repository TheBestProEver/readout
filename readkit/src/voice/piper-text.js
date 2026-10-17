// Piper input ids. A Piper voice's .onnx.json maps each phoneme (a code point after NFD,
// as piper-phonemize does) to ids; a sentence is '^' '_' (phoneme '_')* '$'.

export const BOS = '^';
export const EOS = '$';
export const PAD = '_';
const SPACE = ' ';

function idOf(map, sym) {
  const v = map[sym];
  return Array.isArray(v) ? v : v === undefined ? null : [v];
}

// One sentence of phonemes -> ids. Returns { ids, missing }.
export function sentenceIds(phonemes, map) {
  const pad = idOf(map, PAD) || [0];
  const ids = [...(idOf(map, BOS) || [1]), ...pad];
  let missing = 0;
  let kept = 0;
  for (const ch of String(phonemes).normalize('NFD')) {
    const v = idOf(map, ch);
    if (!v) {
      if (!/\s/.test(ch)) missing++;
      continue;
    }
    ids.push(...v, ...pad);
    kept++;
  }
  ids.push(...(idOf(map, EOS) || [2]));
  return { ids, missing, kept };
}

// An IPA string (possibly several sentences) -> per-sentence ids, cut after . ! ? followed
// by a space, like espeak's own sentence split.
export function ipaToSentences(ipa, map) {
  const text = String(ipa || '').replace(/\s+/g, ' ').trim();
  if (!text) return { sentences: [], missing: 0, kept: 0 };
  const parts = [];
  let a = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if ((text[i] === '.' || text[i] === '!' || text[i] === '?') && text[i + 1] === ' ') {
      parts.push(text.slice(a, i + 1));
      a = i + 2;
    }
  }
  parts.push(text.slice(a));
  let missing = 0;
  let kept = 0;
  const sentences = [];
  for (const p of parts) {
    const r = sentenceIds(p, map);
    missing += r.missing;
    kept += r.kept;
    if (r.kept) sentences.push(r.ids);
  }
  return { sentences, missing, kept };
}

// piper_phonemize prints all sentences' ids back to back; split them at each EOS.
export function splitPhonemizeIds(ids, map) {
  const bos = (idOf(map, BOS) || [1])[0];
  const eos = (idOf(map, EOS) || [2])[0];
  const out = [];
  let cur = [];
  for (const id of ids) {
    if (id === bos && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(id);
    if (id === eos) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  // Drop sentences with no phonemes (just ^ _ $).
  return out.filter((s) => s.length > 3);
}

// Very long sentences are cut at a word break near the middle (VITS has no hard limit,
// but memory and latency grow with length). Each piece is re-wrapped in ^ _ ... $.
export function splitLongIds(ids, map, max = 1000) {
  if (ids.length <= max) return [ids];
  const pad = (idOf(map, PAD) || [0])[0];
  const space = (idOf(map, SPACE) || [3])[0];
  const head = ids.slice(0, 2);
  const eos = ids[ids.length - 1];
  const inner = ids.slice(2, -1);
  const pieces = Math.ceil(ids.length / max);
  const target = inner.length / pieces;
  let best = -1;
  let bestScore = Infinity;
  for (let k = 2; k < inner.length - 2; k += 1) {
    if (inner[k] !== space) continue;
    const score = Math.abs(k - target);
    if (score < bestScore && k + 2 <= inner.length) {
      bestScore = score;
      best = k;
    }
  }
  let a;
  let b;
  if (best < 0) {
    // No word break: cut on a phoneme boundary (ids alternate phoneme, pad).
    const k = Math.floor(target / 2) * 2;
    a = inner.slice(0, k);
    b = inner.slice(k);
  } else {
    a = inner.slice(0, best);
    b = inner.slice(best + (inner[best + 1] === pad ? 2 : 1));
  }
  return [...splitLongIds([...head, ...a, eos], map, max), ...splitLongIds([...head, ...b, eos], map, max)];
}

// Samples of digital silence to insert between two pieces of audio: one rule for every
// engine, in pcm.js.
export { gapSamples } from './pcm.js';
