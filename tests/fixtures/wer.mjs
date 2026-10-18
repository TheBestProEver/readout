// Copied from readkit (tests/fixtures/pdf/wer.mjs, MIT, same author).
// Word error rate between a reference and a hypothesis (case-sensitive words with
// edge punctuation stripped, typographic quotes and dashes folded).

export function norm(s) {
  return String(s)
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(s, lower) {
  return norm(s)
    .split(' ')
    .map((t) => t.replace(/^[^\p{L}\p{N}£$]+/u, '').replace(/[^\p{L}\p{N}]+$/u, ''))
    .filter(Boolean)
    .map((t) => (lower ? t.toLowerCase() : t));
}

export function lev(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

export function wer(ref, hyp) {
  const r = words(ref);
  const h = words(hyp);
  return r.length ? (100 * lev(r, h)) / r.length : h.length ? 100 : 0;
}

// The first differing words, for failure messages.
export function diff(ref, hyp, n = 12) {
  const r = words(ref);
  const h = words(hyp);
  const hs = new Set(h);
  const rs = new Set(r);
  return { missing: r.filter((w) => !hs.has(w)).slice(0, n), extra: h.filter((w) => !rs.has(w)).slice(0, n) };
}
