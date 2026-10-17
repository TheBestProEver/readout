// Word bookkeeping shared by the engines: which spoken words a segment has, how the
// segment's align entries map onto them, and how to line spoken words up with the
// space-separated words of a phoneme string (espeak sometimes merges "that the" into one
// phoneme word, and a lexicon may split a compound, so the counts do not always match).

const LETTER = /[\p{L}\p{N}]/u;

// Spoken words: runs of non-space characters that contain a letter or digit.
export function spokenWords(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    let letters = 0;
    for (const ch of m[0]) if (LETTER.test(ch)) letters++;
    if (letters) out.push({ start: m.index, end: m.index + m[0].length, letters });
  }
  return out;
}

// For each align entry (or each spoken word when a segment has no align), the range of
// spoken words it covers: [{ alignIndex, from, to }] with to exclusive.
export function alignEntries(seg, words) {
  const align = Array.isArray(seg.align) ? seg.align : null;
  if (!align) return words.map((w, i) => ({ alignIndex: i, from: i, to: i + 1 }));
  const out = [];
  for (let k = 0; k < align.length; k++) {
    const a = align[k][0];
    const b = align[k][1];
    if (!(b > a)) continue;
    // First word ending after a (binary search: entries need not be sorted).
    let lo = 0;
    let hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].end <= a) lo = mid + 1;
      else hi = mid;
    }
    let to = lo;
    while (to < words.length && words[to].start < b) to++;
    if (to > lo) out.push({ alignIndex: k, from: lo, to });
  }
  return out;
}

// Which first sounds a word's first letter can have (misaki and espeak symbols). Length
// alone cannot tell "that the | compound" from "that | the compound"; the onset can.
const VOWEL_SOUNDS = 'aeiouæɐəɑɒɔɛɜɪʊʌᵻᵊɚAIOQWYɨø';
const ONSETS = {
  a: VOWEL_SOUNDS, e: VOWEL_SOUNDS + 'j', i: VOWEL_SOUNDS, o: VOWEL_SOUNDS + 'w', u: VOWEL_SOUNDS + 'j', y: 'j' + VOWEL_SOUNDS,
  b: 'b', c: 'ksʃʧtʃ', d: 'dʤ', f: 'f', g: 'ɡgʤdʒʒ', h: 'h' + VOWEL_SOUNDS, j: 'ʤdʒjhʒ', k: 'kn', l: 'l', m: 'm', n: 'n',
  p: 'pfs', q: 'k', r: 'ɹr', s: 'sʃzʒ', t: 'tθðʧʃ', v: 'v', w: 'wɹh' + VOWEL_SOUNDS, x: 'zɛeks', z: 'zs',
};

function onsetOk(text, start, symbols, pwStart) {
  let letter = '';
  for (let i = start; i < text.length && i < start + 4; i++) {
    const c = text[i].toLowerCase();
    if (/\p{L}/u.test(c)) {
      letter = c.normalize('NFD')[0];
      break;
    }
    if (/\p{N}/u.test(c)) return true;
  }
  const allowed = ONSETS[letter];
  if (!allowed || !symbols) return true;
  let k = pwStart;
  while (k < symbols.length && (symbols[k] === 'ˈ' || symbols[k] === 'ˌ')) k++;
  return k < symbols.length && allowed.includes(symbols[k]);
}

// Monotonic alignment of spoken words (weights = letters) to phoneme words (weights =
// phoneme symbols). Returns, per spoken word, a fractional [start, end) range in the
// phoneme words' own coordinates (pw[i].start/end), or null when nothing matches.
// With text and symbols given, a group whose first word's letter cannot begin its first
// phoneme word costs extra.
export function alignToPhonemes(spoken, pw, text, symbols) {
  const n = spoken.length;
  const m = pw.length;
  const out = new Array(n).fill(null);
  if (!n || !m) return out;
  if (n === m) {
    for (let i = 0; i < n; i++) out[i] = [pw[i].start, pw[i].end];
    return out;
  }
  let se = 0;
  let sp = 0;
  for (const w of spoken) se += w.letters;
  for (const w of pw) sp += w.weight;
  const scale = se ? sp / se : 1;
  const e = spoken.map((w) => w.letters * scale);
  const steps = [
    [1, 1, 0],
    [2, 1, 0.6],
    [1, 2, 0.6],
    [3, 1, 1.2],
    [1, 3, 1.2],
    [1, 0, 2.5],
    [0, 1, 2.5],
  ];
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W).fill(Infinity);
  const from = new Int8Array((n + 1) * W).fill(-1);
  cost[0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c0 = cost[i * W + j];
      if (c0 === Infinity) continue;
      for (let s = 0; s < steps.length; s++) {
        const [a, b, pen] = steps[s];
        const i2 = i + a;
        const j2 = j + b;
        if (i2 > n || j2 > m) continue;
        let x = 0;
        for (let k = i; k < i2; k++) x += e[k];
        let y = 0;
        for (let k = j; k < j2; k++) y += pw[k].weight;
        let c = c0 + pen + Math.abs(Math.log((x + 1) / (y + 1)));
        if (a && b && text !== undefined && !onsetOk(text, spoken[i].start, symbols, pw[j].start)) c += 0.8;
        if (c < cost[i2 * W + j2]) {
          cost[i2 * W + j2] = c;
          from[i2 * W + j2] = s;
        }
      }
    }
  }
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const s = from[i * W + j];
    if (s < 0) break;
    const [a, b] = steps[s];
    const i0 = i - a;
    const j0 = j - b;
    if (a && b) {
      const t0 = pw[j0].start;
      const t1 = pw[j - 1].end;
      if (a === 1) out[i0] = [t0, t1];
      else {
        let tot = 0;
        for (let k = i0; k < i; k++) tot += e[k] || 1;
        let acc = 0;
        for (let k = i0; k < i; k++) {
          const s0 = t0 + ((t1 - t0) * acc) / tot;
          acc += e[k] || 1;
          out[k] = [s0, t0 + ((t1 - t0) * acc) / tot];
        }
      }
    } else if (a) {
      // A spoken word with no phonemes: give it a zero-length range at the boundary.
      const t = j0 < m ? pw[j0].start : pw[m - 1].end;
      out[i0] = [t, t];
    }
    i = i0;
    j = j0;
  }
  return out;
}

// Word timings by character share, for engines without durations (Piper): the voiced
// part of the audio [from, to) is spread over the spoken text, letters weighing 1, spaces
// 0.5 and pause punctuation 3, so commas get a little time of their own.
export function charShareTimes(text, from, to) {
  const n = text.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const w = LETTER.test(ch) ? 1 : /\s/.test(ch) ? 0.5 : /[,;:—–.!?…]/.test(ch) ? 3 : 0.3;
    cum[i + 1] = cum[i] + w;
  }
  const total = cum[n] || 1;
  return (charIndex) => from + ((to - from) * cum[Math.max(0, Math.min(n, charIndex))]) / total;
}
