// Fallback phonemes for when readkit's g2p module cannot load: espeak-ng (phonemizer,
// GPL-3.0, loaded at runtime from config.phonemizer, never bundled) with the same
// clean-ups kokoro-js applies, which Kokoro reads well. g2p (misaki lexicon first) is better.

const PUNCT = new Set([';', ':', ',', '.', '!', '?', '¡', '¿', '—', '…', '"', '«', '»', '“', '”', '(', ')', '{', '}', '[', ']']);

// Splits text into runs of punctuation (kept verbatim, with the spaces around them) and
// runs of words (sent to espeak). A scanner rather than a regex, so it stays linear.
export function punctuationRuns(text) {
  const runs = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let j = i;
    while (j < n && !PUNCT.has(text[j])) j++;
    // Spaces that touch a punctuation run belong to it.
    let k = j;
    if (j < n) while (k > i && /\s/.test(text[k - 1])) k--;
    if (k > i) runs.push({ punct: false, text: text.slice(i, k) });
    if (j >= n) break;
    let e = j;
    while (e < n && (PUNCT.has(text[e]) || /\s/.test(text[e]))) e++;
    runs.push({ punct: true, text: text.slice(k, e) });
    i = e;
  }
  return runs;
}

export function fixEspeak(ps, dialect) {
  let out = ps
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (dialect !== 'en-GB') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}

// phonemize(text, lang) -> Promise<string[]> (phonemizer's API).
export async function espeakKokoro(text, phonemize, dialect) {
  const lang = dialect === 'en-GB' ? 'en-gb-x-rp' : 'en-us';
  const call = async (t) => {
    try {
      return await phonemize(t, lang);
    } catch (e) {
      // Older espeak builds lack the RP variant; plain British English is close.
      if (lang !== 'en-us' && /language/i.test(String(e && e.message))) return phonemize(t, 'en');
      throw e;
    }
  };
  const parts = [];
  for (const run of punctuationRuns(String(text || ''))) {
    if (run.punct) parts.push(run.text);
    else if (run.text.trim()) parts.push((await call(run.text)).join(' '));
    else parts.push(run.text);
  }
  return fixEspeak(parts.join(''), dialect);
}

let loading = null;
export function loadPhonemizer(url) {
  if (!loading) {
    loading = import(url).then((m) => m.phonemize).catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
