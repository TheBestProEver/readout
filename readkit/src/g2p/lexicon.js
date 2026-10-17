// misaki's English lexicon lookup, ported from misaki/en.py (Apache-2.0, hexgrad/misaki
// at fba1236): gold then silver dictionaries, part-of-speech entries, weak forms of
// a/an/am/the/to/in, spelled-out acronyms, and -s/-ed/-ing morphology. Kokoro was
// trained on this exact output, so the port stays close to the original, quirks included.

import { VOWELS } from './phonemes.js';

const PRIMARY = 'ˈ';
const SECONDARY = 'ˌ';
const DIPHTHONGS = new Set('AIOQWYʤʧ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
const SYMBOLS = { '%': 'percent', '&': 'and', '+': 'plus', '@': 'at' };
const ALPHA = /^\p{L}+$/u;
const ASCII_WORD = /^[A-Za-z'-]+$/;
const DOUBLED_ING = /([bcdgklmnprstvxz])\1ing$|cking$/;

const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const capitalize = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const isUpper = (w) => w === w.toUpperCase();
const isLower = (w) => w === w.toLowerCase();

export function stressWeight(ps) {
  let n = 0;
  for (const c of ps) n += DIPHTHONGS.has(c) ? 2 : 1;
  return n;
}

function hasVowel(ps) {
  for (const c of ps) if (VOWELS.has(c)) return true;
  return false;
}

// Moves each stress mark to just before the next vowel.
function restress(ps) {
  const keys = [];
  for (let i = 0; i < ps.length; i++) {
    keys.push(i);
    if (ps[i] === PRIMARY || ps[i] === SECONDARY) {
      let j = i;
      while (j < ps.length && !VOWELS.has(ps[j])) j++;
      if (j < ps.length) keys[i] = j - 0.5;
    }
  }
  return keys
    .map((k, i) => [k, i])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, i]) => ps[i])
    .join('');
}

export function applyStress(ps, stress) {
  if (ps == null || stress == null) return ps;
  const p = ps.includes(PRIMARY);
  const s = ps.includes(SECONDARY);
  if (stress < -1) return ps.replaceAll(PRIMARY, '').replaceAll(SECONDARY, '');
  if (stress === -1 || ((stress === 0 || stress === -0.5) && p)) return ps.replaceAll(SECONDARY, '').replaceAll(PRIMARY, SECONDARY);
  if ((stress === 0 || stress === 0.5 || stress === 1) && !p && !s) return hasVowel(ps) ? restress(SECONDARY + ps) : ps;
  if (stress >= 1 && !p && s) return ps.replaceAll(SECONDARY, PRIMARY);
  if (stress > 1 && !p && !s) return hasVowel(ps) ? restress(PRIMARY + ps) : ps;
  return ps;
}

export function parentTag(tag) {
  if (!tag) return tag;
  if (tag.startsWith('VB')) return 'VERB';
  if (tag.startsWith('NN')) return 'NOUN';
  if (tag.startsWith('ADV') || tag.startsWith('RB')) return 'ADV';
  if (tag.startsWith('ADJ') || tag.startsWith('JJ')) return 'ADJ';
  return tag;
}

const asDict = (d) => (d && typeof d.get === 'function' ? d : new Map(Object.entries(d || {})));
const CACHE_MAX = 50000;

export class Lexicon {
  // gold, silver: word -> phonemes, as a Map, a packed dictionary (packed.js) or a plain
  // object. pos: misaki's part-of-speech entries (word -> { DEFAULT, NOUN, VBD, ... }).
  // overrides win over everything.
  constructor({ gold, silver, pos, british, overrides, cache = true }) {
    this.golds = asDict(gold);
    this.silvers = asDict(silver);
    this.pos = pos || {};
    this.overrides = overrides || {};
    this.british = !!british;
    this.cache = cache ? new Map() : null; // off when the dictionaries change (build tools)
  }

  // misaki grows each dictionary with Capitalized copies of lowercase words and lowercase
  // copies of Capitalized ones (words of 2+ letters); we resolve that at lookup time.
  static grown(get, w) {
    let v = get(w);
    if (v !== undefined || w.length < 2) return v;
    const lower = w.toLowerCase();
    if (w !== lower && w === capitalize(w)) return get(lower);
    if (w === lower) {
      const cap = capitalize(w);
      if (cap !== w) return get(cap);
    }
    return undefined;
  }

  gold(w) {
    return Lexicon.grown((k) => {
      const o = own(this.overrides, k);
      if (o !== undefined) return o;
      const p = own(this.pos, k);
      return p !== undefined ? p : this.golds.get(k);
    }, w);
  }

  silver(w) {
    return Lexicon.grown((k) => this.silvers.get(k), w);
  }

  getNNP(word) {
    let ps = '';
    for (const c of word) {
      if (!/\p{L}/u.test(c)) continue;
      const p = this.gold(c.toUpperCase());
      if (typeof p !== 'string') return [null, null];
      ps += p;
    }
    if (!ps) return [null, null];
    ps = applyStress(ps, 0);
    const i = ps.lastIndexOf(SECONDARY);
    if (i >= 0) ps = ps.slice(0, i) + PRIMARY + ps.slice(i + 1);
    return [ps, 3];
  }

  getSpecialCase(word, tag, stress, ctx) {
    if (Object.hasOwn(SYMBOLS, word)) return this.lookup(SYMBOLS[word], null, null, ctx);
    const core = word.replace(/^\.+|\.+$/g, '');
    if (core.includes('.') && ALPHA.test(word.replace(/\./g, '')) && Math.max(...word.split('.').map((p) => p.length)) < 3) {
      return this.getNNP(word);
    }
    if (word === 'a' || word === 'A') return [tag === 'DT' ? 'ɐ' : 'ˈA', 4];
    if (word === 'am' || word === 'Am' || word === 'AM') {
      if (tag && tag.startsWith('NN')) return this.getNNP(word);
      if (ctx.futureVowel == null || word !== 'am' || (stress && stress > 0)) return [this.gold('am'), 4];
      return ['ɐm', 4];
    }
    if (word === 'an' || word === 'An' || word === 'AN') {
      if (word === 'AN' && tag && tag.startsWith('NN')) return this.getNNP(word);
      return ['ɐn', 4];
    }
    if (word === 'I' && tag === 'PRP') return [SECONDARY + 'I', 4];
    if ((word === 'by' || word === 'By' || word === 'BY') && parentTag(tag) === 'ADV') return ['bˈI', 4];
    if (word === 'to' || word === 'To' || (word === 'TO' && (tag === 'TO' || tag === 'IN'))) {
      return [ctx.futureVowel == null ? this.gold('to') : ctx.futureVowel ? 'tʊ' : 'tə', 4];
    }
    if (word === 'in' || word === 'In' || (word === 'IN' && tag !== 'NNP')) {
      return [(ctx.futureVowel == null || tag !== 'IN' ? PRIMARY : '') + 'ɪn', 4];
    }
    if (word === 'the' || word === 'The' || (word === 'THE' && tag === 'DT')) return [ctx.futureVowel === true ? 'ði' : 'ðə', 4];
    if (tag === 'IN' && /^vs\.?$/i.test(word)) return this.lookup('versus', null, null, ctx);
    if (word === 'used' || word === 'Used' || word === 'USED') {
      const used = this.gold('used');
      return [(tag === 'VBD' || tag === 'JJ') && ctx.futureTo ? used.VBD : used.DEFAULT, 4];
    }
    return [null, null];
  }

  isKnown(word) {
    if (this.gold(word) !== undefined || Object.hasOwn(SYMBOLS, word) || this.silver(word) !== undefined) return true;
    if (!ALPHA.test(word) || !ASCII_WORD.test(word)) return false;
    if (word.length === 1) return true;
    if (isUpper(word) && this.gold(word.toLowerCase()) !== undefined) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  lookup(word, tag, stress, ctx) {
    let isNNP = null;
    if (isUpper(word) && this.gold(word) === undefined) {
      word = word.toLowerCase();
      isNNP = tag === 'NNP';
    }
    let ps = this.gold(word);
    let rating = 4;
    if (ps === undefined && !isNNP) {
      ps = this.silver(word);
      rating = 3;
    }
    if (ps && typeof ps === 'object') {
      let t = tag;
      if (ctx && ctx.futureVowel == null && Object.hasOwn(ps, 'None')) t = 'None';
      else if (!Object.hasOwn(ps, t)) t = parentTag(t);
      ps = Object.hasOwn(ps, t) ? ps[t] : ps.DEFAULT;
    }
    if (ps == null || (isNNP && !ps.includes(PRIMARY))) {
      const [nnp, r] = this.getNNP(word);
      if (nnp != null) return [nnp, r];
    }
    return [applyStress(ps == null ? null : ps, stress), ps == null ? null : rating];
  }

  _s(stem) {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if ('ptkfθ'.includes(last)) return stem + 's';
    if ('szʃʒʧʤ'.includes(last)) return stem + (this.british ? 'ɪ' : 'ᵻ') + 'z';
    return stem + 'z';
  }

  stemS(word, tag, stress, ctx) {
    if (word.length < 3 || !word.endsWith('s')) return [null, null];
    let stem;
    if (!word.endsWith('ss') && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if ((word.endsWith("'s") || (word.length > 4 && word.endsWith('es') && !word.endsWith('ies'))) && this.isKnown(word.slice(0, -2))) stem = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('ies') && this.isKnown(word.slice(0, -3) + 'y')) stem = word.slice(0, -3) + 'y';
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this._s(ps), rating];
  }

  _ed(stem) {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if ('pkfθʃsʧ'.includes(last)) return stem + 't';
    if (last === 'd') return stem + (this.british ? 'ɪ' : 'ᵻ') + 'd';
    if (last !== 't') return stem + 'd';
    if (this.british || stem.length < 2) return stem + 'ɪd';
    if (US_TAUS.has(stem[stem.length - 2])) return stem.slice(0, -1) + 'ɾᵻd';
    return stem + 'ᵻd';
  }

  stemEd(word, tag, stress, ctx) {
    if (word.length < 4 || !word.endsWith('d')) return [null, null];
    let stem;
    if (!word.endsWith('dd') && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed') && this.isKnown(word.slice(0, -2))) stem = word.slice(0, -2);
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this._ed(ps), rating];
  }

  _ing(stem) {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if (this.british) {
      if (last === 'ə' || last === 'ː') return null;
    } else if (stem.length > 1 && last === 't' && US_TAUS.has(stem[stem.length - 2])) {
      return stem.slice(0, -1) + 'ɾɪŋ';
    }
    return stem + 'ɪŋ';
  }

  stemIng(word, tag, stress, ctx) {
    if (word.length < 5 || !word.endsWith('ing')) return [null, null];
    let stem;
    if (word.length > 5 && this.isKnown(word.slice(0, -3))) stem = word.slice(0, -3);
    else if (this.isKnown(word.slice(0, -3) + 'e')) stem = word.slice(0, -3) + 'e';
    else if (word.length > 5 && DOUBLED_ING.test(word) && this.isKnown(word.slice(0, -4))) stem = word.slice(0, -4);
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this._ing(ps), rating];
  }

  getWord(word, tag, stress, ctx) {
    const sc = this.getSpecialCase(word, tag, stress, ctx);
    if (sc[0] != null) return sc;
    const wl = word.toLowerCase();
    if (
      word.length > 1 &&
      ALPHA.test(word.replace(/'/g, '')) &&
      word !== wl &&
      (tag !== 'NNP' || word.length > 7) &&
      this.gold(word) === undefined &&
      this.silver(word) === undefined &&
      (isUpper(word) || word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.gold(wl) !== undefined ||
        this.silver(wl) !== undefined ||
        this.stemS(wl, tag, stress, ctx)[0] ||
        this.stemEd(wl, tag, stress, ctx)[0] ||
        this.stemIng(wl, tag, stress, ctx)[0])
    ) {
      word = wl;
    }
    if (this.isKnown(word)) return this.lookup(word, tag, stress, ctx);
    if (word.endsWith("s'") && this.isKnown(word.slice(0, -2) + "'s")) return this.lookup(word.slice(0, -2) + "'s", tag, stress, ctx);
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1))) return this.lookup(word.slice(0, -1), tag, stress, ctx);
    let r = this.stemS(word, tag, stress, ctx);
    if (r[0] != null) return r;
    r = this.stemEd(word, tag, stress, ctx);
    if (r[0] != null) return r;
    r = this.stemIng(word, tag, stress == null ? 0.5 : stress, ctx);
    if (r[0] != null) return r;
    // readkit: a plural possessive sounds like the plural, which may itself come from
    // stemming ("the students' books"); misaki gives up here.
    if (word.length > 2 && word.endsWith("s'")) return this.getWord(word.slice(0, -1), tag, stress, ctx);
    return [null, null];
  }

  // misaki's Lexicon.__call__ without numbers (g2p.js verbalizes stray digits first).
  // Pure in (text, tag, context), so results are cached; callers must not mutate them.
  word(text, tag, ctx) {
    const fv = ctx ? ctx.futureVowel : null;
    const key = text + '\u0001' + tag + '\u0001' + (fv == null ? 'n' : fv ? 'v' : 'c') + (ctx && ctx.futureTo ? 't' : '');
    let r = this.cache ? this.cache.get(key) : undefined;
    if (r === undefined) {
      const word = text.replace(/[‘’]/g, "'").normalize('NFKC');
      const stress = isLower(word) ? null : isUpper(word) ? 2 : 0.5;
      const [ps, rating] = this.getWord(word, tag, stress, ctx || { futureVowel: null, futureTo: false });
      r = ps == null ? [null, null] : [ps, rating];
      if (this.cache) {
        if (this.cache.size >= CACHE_MAX) this.cache.clear();
        this.cache.set(key, r);
      }
    }
    return r;
  }
}
