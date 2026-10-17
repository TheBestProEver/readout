// A light part-of-speech tagger, just enough for pronunciation: closed-class words from
// hand lists, open-class words from en-lexicon's tags (data/g2p/tags.txt), suffixes for
// the rest, and capitals for proper nouns and acronyms. Heteronyms get a closer look in
// hetero.js, which uses the word classes defined here.

const words = (s) => s.split(' ');
const set = (s) => new Set(words(s));

export const DET = set('the a an this that these those every each no any some another either neither all both half several such what whatever which whichever many much few fewer enough');
export const POSS = set('my your his her its our their whose thy one\'s');
export const NUM = set('one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand million billion first second third fourth fifth last next');
export const SUBJ = set('i you we they he she it who');
export const OBJ = set('me him her us them it you');
export const MODAL = set("will would can could shall should may might must 'll 'd won't wouldn't can't cannot couldn't shan't shouldn't mustn't mightn't needn't i'll you'll we'll they'll he'll she'll it'll i'd you'd we'd they'd he'd she'd");
export const DO = set("do does did don't doesn't didn't");
export const BE = set("am is are was were be been being 'm 're 's isn't aren't wasn't weren't ain't i'm you're we're they're he's she's it's that's there's");
export const HAVE = set("have has had having 've hasn't haven't hadn't i've you've we've they've");
export const NEG = set("not never n't");
export const PREP = set('of in on at by for with from about into onto upon over under after before between through during without within against among amongst around behind beyond despite toward towards across along beside besides near since until till via per amid throughout underneath beneath inside outside versus vs than like');
export const PART = set('up down out off away back');
export const CONJ = set('and or but nor yet');
export const SUBORD = set('if because although though while whereas unless whether when where as once');
export const DEGREE = set('very so too quite rather extremely really pretty fairly incredibly perfectly completely totally fully more most less least how somewhat highly utterly entirely absolutely remarkably surprisingly relatively truly especially particularly deeply genuinely');
export const FREQ = set('often always usually sometimes never rarely seldom frequently generally also just still already even only actually probably certainly simply finally soon now again ever regularly typically normally occasionally constantly repeatedly hardly barely');
export const LINKING = set('seem seems seemed seeming feel feels felt feeling look looks looked remain remains remained stay stays stayed keep keeps kept become becomes became get gets got getting appear appears appeared sound sounds sounded grow grows grew prove proved proves');
export const LET = set('let lets make makes made help helps helped watch watched see saw seen hear heard have has had');

// Closed-class tags. Ambiguous ones get their usual tag; tagSentence() fixes a few.
const CLOSED = new Map();
const add = (tag, s) => words(s).forEach((w) => CLOSED.has(w) || CLOSED.set(w, tag));
add('DT', 'the a an this that these those every each no any some another either neither all both half');
add('PRP$', "my your his its our their thy");
add('PRP', 'i you we they he she it me him her us them myself yourself himself herself itself ourselves yourselves themselves');
add('MD', words([...MODAL].join(' ')).join(' '));
add('VBP', "am are 'm 're do don't have 've");
add('VBZ', "is 's does doesn't has hasn't isn't");
add('VBD', "was were did didn't had hadn't wasn't weren't");
add('VB', 'be');
add('VBN', 'been');
add('VBG', 'being having doing');
add('TO', 'to');
add('IN', [...PREP].join(' ') + ' if because although though while whereas unless whether since');
add('CC', 'and or but nor');
add('RB', "not never n't very so too quite rather just also still already even only often always usually sometimes rarely seldom here there now then soon again ever perhaps maybe really almost nearly");
add('WP', 'who whom what');
add('WDT', 'which whichever whatever');
add('WRB', 'where when why how');
add('WP$', 'whose');
add('EX', 'there');
add('UH', 'oh ah yes hello hi hey okay ok wow');
add('CD', [...NUM].filter((w) => !'first second third fourth fifth last next'.includes(w)).join(' '));

// tags.txt: "codes word word ...", one Penn tag per character, most likely first.
const CODE_TAG = {
  n: 'NN', s: 'NNS', p: 'NNP', q: 'NNPS', v: 'VB', b: 'VBP', z: 'VBZ', d: 'VBD', e: 'VBN', g: 'VBG',
  j: 'JJ', k: 'JJR', l: 'JJS', r: 'RB', t: 'RBR', u: 'RBS', i: 'IN', c: 'CC', x: 'DT', m: 'MD',
  o: 'PRP', $: 'PRP$', w: 'WDT', h: 'UH', 0: 'CD', f: 'FW', a: 'RP', 2: 'TO', 3: 'EX', y: 'PDT',
};

export function parseTags(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const ws = line.split(' ');
    for (let i = 1; i < ws.length; i++) if (ws[i]) map.set(ws[i], ws[0]);
  }
  return map;
}

// Word classes as a string of codes (see CODE_TAG). Unknown words are guessed from suffixes.
export function codesOf(w, tags) {
  const c = tags.get(w);
  if (c) return c;
  if (w.length < 3) return 'n';
  if (/ly$/.test(w)) return 'rj';
  if (/ing$/.test(w)) return 'gnj';
  if (/ed$/.test(w)) return 'dej';
  if (/(?:tion|sion|ment|ness|ity|ism|ship|hood|ance|ence|ery|ist|ure|dom|ogy|graphy)$/.test(w)) return 'n';
  if (/(?:ous|ful|ive|able|ible|less|ish|ical|ic|ary|al)$/.test(w)) return 'jn';
  if (/(?:ize|ise|ify|ate)$/.test(w)) return 'vbn';
  if (/(?:ers|ors|ists|ions|ments|ies)$/.test(w)) return 's';
  if (/[^s]s$/.test(w)) return 'sz';
  return 'n';
}

const VERB_CODES = 'vbzdeg';
export const has = (codes, which) => [...which].some((c) => codes.includes(c));
export const primary = (codes) => codes[0];
export const nounish = (codes) => 'nsp'.includes(codes[0]) || (codes[0] === 'j' && codes.includes('n'));
export const verbish = (codes) => VERB_CODES.includes(codes[0]);
export const isVerbCode = (c) => VERB_CODES.includes(c);

const PUNCT_BREAK = new Set(['.', '!', '?', ';', ':', '—', '…', '(', ')']);

// Splits tokens into sentences of words for tagging. Returns [{ words: [tokenIndex...] }].
// Commas and quotes separate clauses for the context rules but not sentences.
export function sentences(tokens) {
  const out = [];
  let cur = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'word') cur.push(i);
    else if (t.ps === '.' || t.ps === '!' || t.ps === '?') {
      if (cur.length) out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// Neighbour lookup inside a clause: null at clause punctuation or the sentence edge.
export function neighbour(tokens, i, dir, n = 1) {
  let k = i;
  for (let step = 0; step < n; step++) {
    k += dir;
    while (k >= 0 && k < tokens.length && tokens[k].kind === 'punct') {
      const ps = tokens[k].ps;
      if (ps === ',' || PUNCT_BREAK.has(ps)) return null;
      k += dir; // quotes are transparent
    }
    if (k < 0 || k >= tokens.length) return null;
  }
  return k;
}

const isCapitalized = (w) => /^\p{Lu}\p{Ll}/u.test(w);
const isAllCaps = (w) => w.length > 1 && /^[\p{Lu}'.-]+$/u.test(w) && /\p{Lu}.*\p{Lu}/u.test(w);

// Assigns token.tag (Penn) and token.lw (lowercase) to every word token.
export function tagTokens(tokens, tags) {
  for (const sent of sentences(tokens)) {
    let caps = 0;
    let letters = 0;
    for (const i of sent) {
      const w = tokens[i].text;
      for (const c of w) {
        if (/\p{L}/u.test(c)) {
          letters++;
          if (/\p{Lu}/u.test(c)) caps++;
        }
      }
    }
    // A shouted heading reads as ordinary words, not as a row of acronyms.
    const shouting = sent.length >= 3 && letters > 0 && caps / letters >= 0.7;
    sent.forEach((i, k) => {
      const t = tokens[i];
      const w = t.text.replace(/[‘’ʼ]/g, "'");
      const lw = w.toLowerCase();
      t.lw = lw;
      const prev = neighbour(tokens, i, -1);
      const initial = k === 0 || prev === null;
      if (/^\p{N}/u.test(w)) t.tag = 'CD';
      else if (!shouting && isAllCaps(w) && w !== 'I') t.tag = 'NNP';
      else if (CLOSED.has(lw) && !(isCapitalized(w) && !initial && !CLOSED.has(w))) t.tag = CLOSED.get(lw);
      else if (!initial && !shouting && isCapitalized(w)) t.tag = 'NNP';
      else t.tag = CODE_TAG[codesOf(lw, tags)[0]] || 'NN';
      t.initial = initial;
    });
    // fix-ups that matter for misaki's special cases
    for (const i of sent) {
      const t = tokens[i];
      const p = neighbour(tokens, i, -1);
      const n = neighbour(tokens, i, 1);
      const pw = p === null ? null : tokens[p].lw;
      const nt = n === null ? null : tokens[n];
      if (t.lw === 'that') t.tag = thatTag(tokens, p, nt, tags);
      else if (t.text === 'A' && ((!t.initial && !shouting) || (nt && /^\p{Lu}$/u.test(nt.text)))) t.tag = 'NNP'; // vitamin A, plan A, "A B C"
      else if (t.text === 'I' && ((nt && /^\p{Lu}$/u.test(nt.text) && nt.text !== 'I') || (p !== null && /^\p{Lu}$/u.test(tokens[p].text) && tokens[p].text !== 'I'))) t.tag = 'NNP'; // spelled letters: "A I", "I B M"
      else if (t.lw === 'am' && pw && (NUM.has(pw) || /^\d/.test(pw) || pw === "o'clock")) t.tag = 'NN';
      else if ((t.lw === 'by' || t.lw === 'in' || t.lw === 'on') && (nt === null || CONJ.has(nt.lw))) t.tag = t.lw === 'by' ? 'RB' : 'RP';
      else if (t.lw === 'her') t.tag = nt && (nounish(codesOf(nt.lw, tags)) || /^\p{Lu}/u.test(nt.text)) && !DET.has(nt.lw) ? 'PRP$' : 'PRP';
      else if (t.lw === 'used' && nt && nt.lw === 'to') {
        const after = neighbour(tokens, n, 1);
        const aw = after === null ? null : tokens[after].lw;
        t.tag = pw && (BE.has(pw) || /^(?:get|gets|got|getting|become|became)$/.test(pw)) ? (aw && verbish(codesOf(aw, tags)) && !nounish(codesOf(aw, tags)) ? 'VBN' : 'JJ') : 'VBD';
      }
    }
  }
}

// 'that' is DT (stressed ðˈæt) as a determiner or pronoun, IN/WDT (ðæt) when it joins clauses.
function thatTag(tokens, p, nt, tags) {
  const pw = p === null ? null : tokens[p].lw;
  if (nt === null) return 'DT'; // "I like that."
  const nc = codesOf(nt.lw, tags);
  if (BE.has(nt.lw) || MODAL.has(nt.lw) || nt.lw === "that's") return pw && !CONJ.has(pw) && nounish(codesOf(pw, tags)) && !SUBJ.has(pw) ? 'WDT' : 'DT';
  if (SUBJ.has(nt.lw) || DET.has(nt.lw) || POSS.has(nt.lw) || nt.tag === 'NNP') return 'IN'; // "said that the", "so that we"
  if (pw && /^(?:so|such|now|given|provided|except|in|order)$/.test(pw)) return 'IN';
  if (nounish(nc) && !verbish(nc)) return 'DT'; // "that book"
  if (pw && nounish(codesOf(pw, tags)) && verbish(nc)) return 'WDT'; // "the man that wound"
  return 'DT';
}
