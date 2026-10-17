// Phoneme alphabets and conversions.
//
// Kokoro v1.0 was trained on misaki phonemes (github.com/hexgrad/misaki, EN_PHONES.md):
// one symbol per sound, with capitals for diphthongs (A=eɪ I=aɪ O=oʊ Q=əʊ W=aʊ Y=ɔɪ).
// espeak-ng writes the same sounds as IPA sequences, and phonemizer.js gives us no tie
// characters, so fromEspeak() has to find the diphthongs and affricates itself.

// Every symbol Kokoro's tokenizer knows (kokoro_tok.json). Anything else is silently
// dropped by the tokenizer, so we never emit it.
export const KOKORO_VOCAB = new Set(
  ';:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ',
);

// misaki's phoneme sets, plus ɐ (weak a/an/am) and T (US flap, see kokoroFinal).
const US_PHONES = 'AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹʃʊʌʒʤʧˈˌθᵊᵻɐT';
const GB_PHONES = 'AIQWYabdfhijklmnpstuvwzðŋɑɒɔəɛɜɡɪɹʃʊʌʒʤʧˈˌːθᵊɐ';
export const PUNCT = ';:,.!?—…"()“”';
const ALLOWED = {
  us: new Set(US_PHONES + PUNCT + ' '),
  gb: new Set(GB_PHONES + PUNCT + ' '),
};

export const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');
export const CONSONANTS = new Set('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ');

// Kokoro v1.0 used misaki's default version, which writes the US flap ɾ as T and the
// glottal stop ʔ as t. Then keep only symbols of the dialect, with single spaces.
export function kokoroFinal(ps, british) {
  const allowed = ALLOWED[british ? 'gb' : 'us'];
  let out = '';
  let space = false;
  for (const c of ps.replace(/ɾ/g, british ? 't' : 'T').replace(/ʔ/g, 't')) {
    if (c === ' ') space = out.length > 0;
    else if (allowed.has(c)) {
      if (space) out += ' ';
      out += c;
      space = false;
    }
  }
  return out;
}

// espeak-ng IPA (phonemizer.js, no ties) -> misaki. Follows misaki's espeak.py, which
// works on tied output; without ties we match the two-letter sequences directly.
function replaceAll(ps, pairs) {
  for (const [a, b] of pairs) if (ps.includes(a)) ps = ps.split(a).join(b);
  return ps;
}
const E2M_US = [['eə', 'ɛɹ'], ['oʊ', 'O'], ['əʊ', 'O']];
const E2M_GB = [['eə', 'ɛː'], ['əʊ', 'Q'], ['oʊ', 'Q'], ['ɚ', 'ə']];
const E2M = [
  ['ʔˌn̩', 'ʔn'], ['ʔn̩', 'ʔn'],
  ['aɪ', 'I'], ['aʊ', 'W'], ['eɪ', 'A'], ['ɔɪ', 'Y'], ['dʒ', 'ʤ'], ['tʃ', 'ʧ'], ['e', 'A'],
  ['ʲo', 'jo'], ['ʲə', 'jə'], ['ʲ', ''],
  ['ɚɹ', 'əɹ'], ['ɚ', 'əɹ'], ['r', 'ɹ'], ['x', 'k'], ['ç', 'k'], ['ɐ', 'ə'], ['ɬ', 'l'], ['ɫ', 'l'], ['̃', ''],
  ['y', 'u'], ['ø', 'ɜ'], ['œ', 'ɜ'],
];
// espeak's syllabic l (tied ə^l in misaki) is written plain əl here; treat it as
// syllabic when no vowel follows: apple -> ˈæpᵊl, but hello stays həlˈO.
const SYLLABIC_L = /əl(?![ˈˌ]*[AIOQWYaeiouæɑɒɔəɛɜɪʊʌᵻ])/g;

export function fromEspeak(ps, british) {
  ps = replaceAll(ps, british ? E2M_GB : E2M_US);
  ps = replaceAll(ps, E2M);
  ps = ps.replace(SYLLABIC_L, 'ᵊl');
  ps = ps.replace(/(\S)̩/g, 'ᵊ$1').replace(/[̀-ͯ]/g, '');
  if (british) {
    ps = ps.replace(/iə/g, 'ɪə').replace(/æ/g, 'a').replace(/ᵻ/g, 'ɪ').replace(/ɾ/g, 't');
    ps = ps.replace(/ɪ(?=\s|$)/g, 'i'); // RP happY is ɪ in espeak, i in misaki
    ps = ps.split(' ').map(gbWeakVowels).join(' ');
  } else {
    ps = ps.replace(/ɜːɹ/g, 'ɜɹ').replace(/ɜː/g, 'ɜɹ').replace(/ɪə/g, 'iə').replace(/ː/g, '');
    ps = ps.replace(/ɒ/g, 'ɑ').replace(/a/g, 'æ');
    ps = ps.split(' ').map(usWeakVowels).join(' ');
  }
  return ps.replace(/o/g, 'ɔ');
}

// American English reduces most unstressed vowels to ə, and misaki's US lexicon writes
// them so (education ˌɛʤəkˈAʃən, limit lˈɪmət, remember ɹəmˈɛmbəɹ); espeak keeps ɪ and ᵻ
// (ˌɛʤukˈAʃən, lˈɪmɪt, ɹᵻmˈɛmbəɹ). Kept: the -ᵻd/-ᵻz endings, -ɪŋ, word-initial ɪ, and
// final -ɪv -ɪʤ -ɪk(s) -ɪʃ -ɪzəm. Word-initial unstressed ɛ before ks/gz/n/m is ɪ there
// (expect ɪkspˈɛkt, enjoy ɪnʤˈY).
function usWeakVowels(w) {
  if (w.length > 64) return w;
  const out = [...w];
  let pending = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === 'ˈ' || c === 'ˌ') {
      pending = true;
      continue;
    }
    if (!VOWELS.has(c)) continue;
    const stressed = pending;
    pending = false;
    if (stressed) continue;
    const rest = w.slice(i + 1);
    if (c === 'ᵻ') {
      if (rest !== 'd' && rest !== 'z') out[i] = 'ə';
    } else if (c === 'ɛ' && i === 0) {
      if (/^(?:[kɡ][sz]|[nm][^AIOWYaiuæɑɔəɛɜɪʊʌᵻˈˌ])/.test(rest)) out[i] = 'ɪ';
    } else if (c === 'ɪ' && i > 0 && rest && !VOWELS.has(rest[0]) && rest[0] !== 'ŋ') {
      if (!/^(?:v|ʤ|ks?|ʃ|zəm)$/.test(rest)) out[i] = 'ə';
    }
  }
  return out.join('');
}

// misaki's GB lexicon: unstressed ʌ is ə (welcome wˈɛlkəm), unstressed uː is ʊ
// (education ˌɛdjʊkˈAʃᵊn), -ful is fʊl, and -tion/-sion end in a syllabic n.
function gbWeakVowels(w) {
  if (w.length > 64) return w;
  const out = [...w];
  let pending = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === 'ˈ' || c === 'ˌ') {
      pending = true;
      continue;
    }
    if (!VOWELS.has(c)) continue;
    const stressed = pending;
    pending = false;
    if (stressed) continue;
    if (c === 'ʌ') out[i] = 'ə';
    else if (c === 'u' && out[i + 1] === 'ː' && i + 2 < out.length) {
      out[i] = 'ʊ';
      out[i + 1] = '';
    }
  }
  return out.join('').replace(/([ʃʒ])ən$/, '$1ᵊn').replace(/fᵊl$/, 'fʊl');
}

// misaki -> espeak-style IPA, for user lexicon entries given as /phonemes/ in ipa().
export function toEspeak(ps, british) {
  if (british) ps = ps.replace(/a/g, 'æ');
  else {
    ps = ps.replace(/əɹ(?![AIOWYiuæɑɔəɛɜɪʊʌᵻ])/g, 'ɚ').replace(/ɜɹ/g, 'ɜː');
    ps = ps.replace(/i(?!ə)/g, 'iː').replace(/u/g, 'uː').replace(/ɑ/g, 'ɑː').replace(/ɔ/g, 'ɔː');
  }
  ps = ps.replace(/ʤ/g, 'dʒ').replace(/ʧ/g, 'tʃ').replace(/A/g, 'eɪ').replace(/I/g, 'aɪ').replace(/Y/g, 'ɔɪ');
  return ps.replace(/O/g, 'oʊ').replace(/Q/g, 'əʊ').replace(/W/g, 'aʊ').replace(/ᵊ/g, 'ə').replace(/T/g, 'ɾ');
}
