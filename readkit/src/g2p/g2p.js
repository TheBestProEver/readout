// Speech text -> phonemes. kokoro() gives misaki phonemes for Kokoro's tokenizer; ipa()
// gives espeak-ng IPA for Piper. Input is already-verbalized text (Segment.spoken).
//
// Kokoro order, per word: user lexicon -> heteronym senses and part of speech ->
// misaki gold, then silver, with misaki's special cases and -s/-ed/-ing stems ->
// espeak-ng (en-us / en-gb-x-rp) mapped into misaki symbols for words still unknown.

import { loadData } from './data.js';
import { loadEspeak } from './espeak.js';
import { Lexicon, applyStress, stressWeight } from './lexicon.js';
import { parsePacked } from './packed.js';
import { tokenize } from './tokenize.js';
import { tagTokens, parseTags } from './tagger.js';
import { senseOf, posTag } from './hetero.js';
import { fromEspeak, toEspeak, kokoroFinal, VOWELS, CONSONANTS } from './phonemes.js';
import { numberWords } from './numbers.js';

const PRIMARY = 'ˈ';
const NON_QUOTE_PUNCT = new Set(';:,.!?—…');
const JUNK = new Set("',-._‘’/");
const CURRENCY = { $: 'dollars', '£': 'pounds', '€': 'euros', '¥': 'yen' };
const SENSE_WORDS = new Set(['lead', 'tear', 'tears', 'bow', 'bows', 'row', 'rows', 'bass', 'does', 'deserts', 'resume', 'resumes']);
const MAX_SPAN = 8; // longest run of word pieces tried as one lexicon entry
const MAX_WORD = 64; // longer "words" are junk (hashes, runs of letters), not sent to espeak
const CACHE_MAX = 20000;

const isJunk = (s) => [...s].every((c) => JUNK.has(c));
// POS-table words whose reading depends on noun/verb/adjective; function words with only
// weak/strong forms ('None' keys) and 'used' are left to misaki's special cases.
const CONTENT_KEYS = ['NOUN', 'VERB', 'ADJ', 'ADV', 'VBD', 'VBN', 'VBP'];
const isHeteronym = (w, entry) => w !== 'used' && CONTENT_KEYS.some((k) => Object.hasOwn(entry, k));
const isNumber = (s) => /^\d/.test(s);
// A letter outside the Latin and Greek scripts: an English voice can't say the word
// (espeak reads 中文 as "Chinese letter Chinese letter"), so it stays silent.
const FOREIGN = /[^\P{L}\p{Script=Latin}\p{Script=Greek}]/u;
const CLOSING = new Set([',', '.', '!', '?', ';', ':', ')', '”', '…']);
const GREEK = 'αβγδεζηθικλμνξοπρσςτυφχψω';
const GREEK_NAMES = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma sigma tau upsilon phi chi psi omega'.split(' ');

function tokenContext(ctx, ps, text, tag) {
  let vowel = ctx.futureVowel;
  if (ps) {
    for (const c of ps) {
      if (NON_QUOTE_PUNCT.has(c)) {
        vowel = null;
        break;
      }
      if (VOWELS.has(c)) {
        vowel = true;
        break;
      }
      if (CONSONANTS.has(c)) {
        vowel = false;
        break;
      }
    }
  }
  const futureTo = text === 'to' || text === 'To' || (text === 'TO' && (tag === 'TO' || tag === 'IN'));
  return { futureVowel: vowel, futureTo };
}

// 0 letter, 1 digit, 2 other
function charClass(c) {
  const n = c.charCodeAt(0);
  if ((n >= 97 && n <= 122) || (n >= 65 && n <= 90)) return 0;
  if (n >= 48 && n <= 57) return 1;
  return /\p{L}/u.test(c) ? 0 : 2;
}

// misaki's resolve_tokens: pieces of one word ('well-known', 'MP3') joined with or without
// spaces, and with all but the strongest stresses lowered.
function joinPieces(pieces) {
  let prespace = false;
  let cls = -1;
  for (const p of pieces) {
    for (const c of p.text) {
      if (c === ' ' || c === '/') prespace = true;
      if (prespace) break;
      if (JUNK.has(c)) continue;
      const k = charClass(c);
      if (cls < 0) cls = k;
      else if (k !== cls) prespace = true;
    }
    if (prespace) break;
  }
  for (const p of pieces) if (p.ps == null) p.ps = '';
  if (!prespace) {
    let idx = pieces.map((p, i) => [p.ps.includes(PRIMARY) ? 1 : 0, stressWeight(p.ps), i]).filter((x) => pieces[x[2]].ps);
    if (idx.length === 2 && pieces[idx[0][2]].text.length === 1) {
      const i = idx[1][2];
      pieces[i].ps = applyStress(pieces[i].ps, -0.5);
    } else if (idx.length >= 2 && idx.reduce((s, x) => s + x[0], 0) > Math.floor((idx.length + 1) / 2)) {
      idx.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      for (const [, , i] of idx.slice(0, Math.floor(idx.length / 2))) pieces[i].ps = applyStress(pieces[i].ps, -0.5);
    }
  }
  // (no out.endsWith(): on a long concatenated string it flattens it every time)
  let out = '';
  let spaced = true;
  for (const p of pieces) {
    if (!p.ps) continue;
    if (prespace && !spaced) out += ' ';
    out += p.ps;
    spaced = p.ps[p.ps.length - 1] === ' ';
  }
  return out;
}

// createG2P({ dialect, lexicon, need, espeak })
//   dialect: 'en-US' (default) | 'en-GB'
//   lexicon: user pronunciations, word -> respelling ('Readout': 'Read-out') or /misaki/
//   need: 'both' (default) | 'kokoro' | 'ipa'; 'ipa' skips the misaki lexicon download
//   espeak: false to run without espeak-ng, or an object { phonemize(text, voice) -> lines }
export async function createG2P({ dialect = 'en-US', lexicon, need = 'both', espeak } = {}) {
  const british = /^en[-_](gb|uk)\b/i.test(String(dialect));
  const d = british ? 'gb' : 'us';
  const voice = british ? 'en-gb-x-rp' : 'en-us';
  const wantKokoro = need !== 'ipa';
  const wantIpa = need !== 'kokoro';
  let espeakError = null;
  const [lex, pos, tags, hetero, esp] = await Promise.all([
    wantKokoro ? loadData(`lex-${d}.txt`, parsePacked) : null,
    loadData(`pos-${d}.json`),
    loadData('tags.txt', parseTags),
    loadData('hetero.json'),
    espeak === false
      ? null
      : Promise.resolve(espeak || loadEspeak())
          .then((e) => (e && typeof e.phonemize === 'function' && e.sync !== false ? e : Promise.reject(new Error('This espeak-ng build has no synchronous worker'))))
          .catch((e) => {
            espeakError = e;
            return null;
          }),
  ]);
  if (wantIpa && !wantKokoro && !esp) throw espeakError || new Error('espeak-ng is turned off');
  // espeak loads a voice on its first use of it (~50-100 ms); do that now, not mid-sentence.
  if (esp) {
    try {
      esp.phonemize('a', voice);
    } catch (e) {
      /* reported on first real use */
    }
  }

  const senses = hetero.senses;
  const ipaTable = hetero.ipa[d];
  const lexi = wantKokoro ? new Lexicon({ gold: lex.gold, silver: lex.silver, pos, british, overrides: hetero.overrides[d] }) : null;

  // user pronunciations: word -> respelling, or /misaki phonemes/
  const user = new Map();
  for (const [k, v] of Object.entries(lexicon || {})) {
    if (typeof v !== 'string' || !k.trim()) continue;
    user.set(k.trim(), v.trim());
    if (!user.has(k.trim().toLowerCase())) user.set(k.trim().toLowerCase(), v.trim());
  }
  const userEntry = (text) => user.get(text) ?? user.get(text.toLowerCase());

  const espeakCache = new Map();
  const remember = (k, v) => {
    if (espeakCache.size >= CACHE_MAX) espeakCache.clear();
    espeakCache.set(k, v);
  };

  // espeak-ng for unknown words, many at once: one clause per word, so one line each.
  function espeakWords(words) {
    const todo = [...new Set(words)].filter((w) => !espeakCache.has(w));
    if (!todo.length || !esp) return;
    try {
      let lines = todo.length > 1 ? esp.phonemize(todo.join(', '), voice) : null;
      if (!lines || lines.length !== todo.length) lines = todo.map((w) => esp.phonemize(w, voice).join(' '));
      todo.forEach((w, k) => remember(w, fromEspeak(lines[k].trim(), british)));
    } catch (e) {
      // a broken espeak must not stop the voice: these words get the offline reading
      for (const w of todo) if (!espeakCache.has(w)) remember(w, offline(w));
    }
  }

  // Without espeak: known pieces of a compound, else letter names.
  function offline(word) {
    const greek = GREEK.indexOf(word.toLowerCase());
    if (word.length === 1 && greek >= 0) return lexi.word(GREEK_NAMES[greek], 'NN', { futureVowel: null, futureTo: false })[0] || '';
    const plain = word.normalize('NFD').replace(/\p{M}/gu, '');
    if (plain !== word) {
      const [ps] = lexi.word(plain, 'NN', { futureVowel: null, futureTo: false });
      if (ps) return ps;
    }
    const lw = plain.toLowerCase();
    for (let k = lw.length - 3; k >= 3; k--) {
      const a = lexi.word(lw.slice(0, k), 'NN', { futureVowel: null, futureTo: false })[0];
      const b = a && lexi.word(lw.slice(k), 'NN', { futureVowel: null, futureTo: false })[0];
      if (a && b) return joinPieces([{ text: 'a', ps: a }, { text: 'b', ps: b }]);
    }
    return lexi.getNNP(plain)[0] || '';
  }

  function unknown(word) {
    if (word.length > MAX_WORD) return ''; // junk; the speech junk guard drops these upstream
    if (!esp) return offline(word);
    if (!espeakCache.has(word)) espeakWords([word]);
    return espeakCache.get(word) || '';
  }

  // Numbers become words first; '$5' becomes 'five dollars'.
  function numberPs(text, ctx) {
    const words = numberWords(text, british).split(/[ -]/).filter(Boolean);
    return words.map((w) => lexi.word(w, 'CD', ctx)[0] || '').filter(Boolean).join(' ');
  }

  function wordPs(text, tag, ctx) {
    const [ps] = lexi.word(text, tag, ctx);
    if (ps != null) return ps;
    if (isNumber(text)) return numberPs(text, ctx);
    return null;
  }

  // misaki's right-to-left search over a word's pieces for the longest lexicon entries.
  // Returns { ps, ctx, fallback }; fallback means some piece is unknown (espeak the word).
  function pieces(t, ctx) {
    const w = t.parts.map((text) => ({ text, ps: null }));
    const span = w.length > 24 ? 3 : MAX_SPAN; // 'a-a-a-...' junk stays cheap
    let left = 0;
    let right = w.length;
    while (left < right) {
      let ps = null;
      let text = '';
      // (pieces left of `right` are never assigned yet: assignment moves `right` down)
      if (right - left <= span) {
        for (let k = left; k < right; k++) text += w[k].text;
        if (left + 1 === right && CURRENCY[text] && w[right] && isNumber(w[right].text)) ps = '';
        else ps = wordPs(text, t.tag, ctx);
        if (ps != null && left > 0 && CURRENCY[w[left - 1].text] && isNumber(text)) {
          const unit = text === '1' ? CURRENCY[w[left - 1].text].replace(/s$/, '') : CURRENCY[w[left - 1].text];
          ps += ' ' + (lexi.word(unit, 'NN', ctx)[0] || '');
        }
      }
      if (ps != null) {
        w[left].ps = ps;
        for (let k = left + 1; k < right; k++) w[k].ps = '';
        if (ps) ctx = tokenContext(ctx, ps, text, t.tag);
        right = left;
        left = 0;
      } else if (left + 1 < right) left = Math.max(left + 1, right - span);
      else {
        right--;
        const x = w[right];
        if (x.ps == null) {
          if (isJunk(x.text) || CURRENCY[x.text] !== undefined) x.ps = '';
          else return { ps: null, ctx, fallback: true };
        }
        left = 0;
      }
    }
    return { ps: joinPieces(w), ctx, fallback: false };
  }

  // Tags, user entries, heteronym senses and part-of-speech choices for a token list.
  function prepare(tokens, withUser = true) {
    tagTokens(tokens, tags);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind !== 'word') continue;
      const u = withUser ? userEntry(t.text) : undefined;
      if (u !== undefined) {
        t.user = u;
        continue;
      }
      if (FOREIGN.test(t.text)) {
        t.foreign = true;
        continue;
      }
      if (SENSE_WORDS.has(t.lw)) {
        const s = senseOf(tokens, i);
        if (s && senses[s]) {
          t.sense = s;
          continue;
        }
      }
      const entry = Object.hasOwn(pos, t.lw) ? pos[t.lw] : null;
      if (entry && t.parts.length === 1 && t.tag !== 'NNP' && isHeteronym(t.lw, entry)) {
        t.tag = posTag(tokens, i, entry, tags);
        // misaki's read/VBP is ɹˈɛd ("they read" in the present is ɹˈid)
        if (t.tag === 'VBP' && (t.lw === 'read' || t.lw === 'reread')) t.tag = 'VB';
        t.pos = true;
      }
    }
    return tokens;
  }

  const userKokoro = new Map();
  function userPs(u) {
    if (!userKokoro.has(u)) {
      const m = /^\/(.+)\/$/.exec(u);
      userKokoro.set(u, m ? m[1] : run(u, false).out.trim());
    }
    return userKokoro.get(u);
  }

  function run(text, withUser) {
    const tokens = prepare(tokenize(text), withUser);
    // espeak every unknown word in one call
    if (esp) {
      const misses = [];
      const ctx0 = { futureVowel: null, futureTo: false };
      for (const t of tokens) {
        if (t.kind !== 'word' || t.user !== undefined || t.sense || t.foreign) continue;
        if (t.parts.length === 1) {
          if (t.text.length <= MAX_WORD && wordPs(t.text, t.tag, ctx0) == null && !isJunk(t.text) && !espeakCache.has(t.text)) misses.push(t.text);
        } else if (t.text.length <= MAX_WORD && pieces(t, ctx0).fallback && !espeakCache.has(t.text)) misses.push(t.text);
      }
      if (misses.length) espeakWords(misses);
    }
    let ctx = { futureVowel: null, futureTo: false };
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      let ps;
      if (t.kind === 'punct') ps = t.ps;
      else if (t.user !== undefined) ps = userPs(t.user);
      else if (t.foreign) ps = '';
      else if (t.sense) ps = senses[t.sense][d];
      else if (t.parts.length === 1) {
        ps = isJunk(t.text) ? '' : wordPs(t.text, t.tag, ctx);
        if (ps == null) ps = unknown(t.text);
      } else {
        const r = pieces(t, ctx);
        ps = r.fallback ? unknown(t.text) : r.ps;
      }
      t.out = ps;
      ctx = tokenContext(ctx, ps, t.text, t.tag);
    }
    // A silent word (foreign script, junk) must not leave "word ," or "()" behind.
    // (`last` instead of out[out.length - 1]: indexing a long concatenated string
    // flattens it, which would make this quadratic.)
    let out = '';
    let last = '';
    let silent = false;
    for (const t of tokens) {
      if (!t.out) {
        if (t.kind === 'word') silent = true;
        if (t.ws && last && last !== ' ') {
          out += ' ';
          last = ' ';
        }
        continue;
      }
      if (silent && t.kind === 'punct') {
        if (last === ' ' && CLOSING.has(t.out)) out = out.slice(0, -1);
        else if (last === '(' && t.out === ')') {
          out = out.slice(0, -1);
          last = out ? ' ' : '';
          continue;
        }
      }
      silent = false;
      out += t.out;
      last = t.out[t.out.length - 1];
      if (t.ws) {
        out += ' ';
        last = ' ';
      }
    }
    return { out, tokens };
  }

  function kokoro(text) {
    if (!lexi) throw new Error("createG2P({ need: 'ipa' }) has no Kokoro lexicon");
    return kokoroFinal(run(String(text ?? ''), true).out, british);
  }

  // Piper: espeak per clause, with punctuation the way piper_phonemize writes it, and
  // heteronym choices spliced in where espeak would guess. Overridden words are swapped
  // for a placeholder espeak always says the same way, then replaced in its output.
  const HOLD = { c: 'zorbix', v: 'orbix' };
  const holdIpa = {};
  function placeholder(kind) {
    if (!holdIpa[kind]) holdIpa[kind] = esp.phonemize(HOLD[kind], voice).join(' ').trim();
    return holdIpa[kind];
  }

  function ipaOverride(t, tokens, i) {
    if (t.user !== undefined) {
      const m = /^\/(.+)\/$/.exec(t.user);
      return m ? { ipa: toEspeak(m[1], british) } : { say: t.user };
    }
    if (t.sense) return { ipa: senses[t.sense]['ipa_' + d] };
    if (t.pos && Object.hasOwn(ipaTable, t.lw)) {
      const row = ipaTable[t.lw];
      const tag = t.tag;
      const parent = tag.startsWith('VB') ? 'VERB' : tag.startsWith('NN') ? 'NOUN' : tag.startsWith('JJ') ? 'ADJ' : tag.startsWith('RB') ? 'ADV' : tag;
      const key = Object.hasOwn(row, tag) ? tag : Object.hasOwn(row, parent) ? parent : 'DEFAULT';
      if (row[key]) return { ipa: row[key] };
    }
    return null;
  }

  function ipa(text) {
    if (!esp) throw espeakError || new Error('espeak-ng is turned off');
    const tokens = prepare(tokenize(String(text ?? '')));
    // clauses: { text (with placeholders), plain, splices, punct }
    const clauses = [];
    let cur = { text: '', plain: '', splices: [] };
    const flush = (punct) => {
      if (cur.text.trim()) clauses.push({ ...cur, punct });
      else if (punct && clauses.length && !clauses[clauses.length - 1].punct) clauses[clauses.length - 1].punct = punct;
      cur = { text: '', plain: '', splices: [] };
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === 'punct') {
        const p = t.ps;
        if (',;:.!?'.includes(p) && p) flush(p);
        else if (p === '—' || p === '…' || p === '(' || p === ')') flush(',');
        continue;
      }
      if (t.foreign || t.text.length > MAX_WORD) continue; // unsayable or junk
      const o = ipaOverride(t, tokens, i);
      let piece = t.text;
      if (o && o.say) piece = o.say;
      else if (o && o.ipa) {
        const kind = /^[ˈˌ]*[aeiouæɑɒɔəɛɜɪʊʌᵻ]/.test(o.ipa) ? 'v' : 'c';
        cur.splices.push({ hold: placeholder(kind), ipa: o.ipa });
        piece = HOLD[kind];
      }
      cur.text += (cur.text ? ' ' : '') + piece;
      cur.plain += (cur.plain ? ' ' : '') + (o && o.say ? o.say : t.text);
    }
    flush('');
    if (!clauses.length) return '';
    const say = (s) => esp.phonemize(s, voice).join(' ').trim();
    // One espeak call for all clauses (each costs ~3 ms); espeak writes one line per
    // clause. If it splits differently, ask clause by clause.
    let lines = null;
    if (clauses.length > 1) {
      lines = esp.phonemize(clauses.map((c, k) => c.text + (k < clauses.length - 1 ? c.punct || ',' : '')).join(' '), voice);
      if (lines.length !== clauses.length) lines = null;
    }
    let out = '';
    let last = '';
    clauses.forEach((c, k) => {
      let ps = lines ? lines[k].trim() : say(c.text);
      for (const s of c.splices) {
        const at = ps.indexOf(s.hold);
        if (at < 0) {
          ps = say(c.plain); // espeak changed the placeholder; keep its own reading
          break;
        }
        ps = ps.slice(0, at) + s.ipa + ps.slice(at + s.hold.length);
      }
      if (ps) {
        out += (out ? ' ' : '') + ps;
        last = ps[ps.length - 1];
      }
      if (c.punct && out && last !== c.punct) {
        out += c.punct;
        last = c.punct;
      }
    });
    return out;
  }

  return {
    dialect: british ? 'en-GB' : 'en-US',
    espeak: !!esp,
    kokoro,
    ipa,
    // For tests and debugging: each token with its tag and phonemes.
    explain(text) {
      return run(String(text ?? ''), true).tokens.map((t) => ({ text: t.text, tag: t.tag, ps: t.out, sense: t.sense }));
    },
  };
}
