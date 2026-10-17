// Heteronyms: words spelled alike but said differently (read/read, record/record, lead/lead).
//
// misaki keys about 790 such words by part of speech (data/g2p/pos-*.json). misaki gets
// the part of speech from spaCy; we decide it from the neighbouring words, which is what
// the decision usually hinges on ("to record", "the record", "was read", "they read").
// A few words have senses the part of speech can't separate (lead the metal, a tear in
// the fabric, take a bow); phrase cues pick those, from data/g2p/hetero.json.

import {
  DET, POSS, NUM, SUBJ, OBJ, MODAL, DO, BE, HAVE, NEG, PREP, PART, CONJ, DEGREE, FREQ, LINKING, LET,
  codesOf, nounish, verbish, neighbour,
} from './tagger.js';

const set = (s) => new Set(s.split(' '));

// Past participle spelled like the base form, so "had read" / "was wound" are VBN.
const SAME_VBN = set('read reread wound upset cut set put cast hit let shut spread burst cost hurt quit split thrust');
// "to" after these is usually a preposition: "listen to records", "next to the present".
const TO_PREP = set('according due next close closer similar related compared owing thanks prior contrary addition response return reference regard respect access attention devoted committed dedicated listen listened listening listens back way key answer solution approach road path door letter letters visit trip welcome introduction guide entry admission exposure damage threat contribution alternative objection opposition resistance open equal equivalent opposite adjacent near from up down');
const QUANT = set('many some all most few several both none each any others those these');
const FIRM_DET = set('the a an this that these those every each no another his her my your our their its whose');
const BROADCAST = set('broadcast broadcasts broadcasted shown show shows showing aired air airs airing streamed stream streams streaming played performed perform performs performing televised filmed recorded go goes going went gone');
const PAST_CUE = set('yesterday ago last earlier previously formerly once recently somewhere');
const PRES_CUE = set('every always usually often sometimes daily nightly weekly nowadays now today tonight tomorrow generally regularly currently frequently rarely seldom');
const OBJ_NEXT = set('the a an this that these those his her my your our their its me him them us it you some any every each all both no another one two three several many whatever');

// Adjective readings that only make sense before certain nouns.
const J_GATE = {
  minute: set('detail details amount amounts quantity quantities particle particles trace traces fraction fractions difference differences change changes crack cracks fragment fragments droplet droplets hole holes opening openings size scale portion portions organism organisms creature creatures grain grains variation variations error errors examination inspection attention adjustment adjustments'),
  content: set(''),
};

const LIVE_J_NEXT = set('music concert concerts show shows event events stream streams streaming broadcast broadcasts performance performances audience audiences recording recordings album albums version versions wire wires ammunition rounds round bait animals animal coverage feed feeds updates update blog chat video videos television tv radio action oak birth births cell cells culture cultures vaccine vaccines fire firing mic microphone microphones sound set sets theatre theater entertainment band bands gig gigs demo session sessions data link preview view webcast webinar interview debate telecast match game games sport sports score scores results odds commentary footage studio specimens specimen');

// Sense cues. Each returns a sense name from hetero.json, or null to use the part of speech.
const LEAD_METAL_NEXT = set('poisoning pipe pipes paint paints pencil pencils weight weights shot acid ore oxide sulfide sulphide nitrate carbonate crystal glass mine mines mining smelter smelters smelting roof roofing apron aprons shielding solder levels level exposure contamination content particles dust fumes toxicity alloy alloys bullet bullets balloon sinker sinkers flashing poisoned free');
const LEAD_METAL_PREV = set('red white molten pure solid metallic toxic unleaded');
// "exposure to lead", "contaminated with lead": the metal, as a bare noun after these
const LEAD_METAL_P2 = set('exposure exposed contaminated contamination poisoned tainted laced lined coated filled containing contains contain free rich traces trace levels amounts');
// verbs that take an adjective: "practice makes perfect"
const MAKE = set('make makes made making');
const METALS = set('zinc copper tin iron mercury arsenic cadmium nickel silver gold aluminium aluminum steel chromium uranium bismuth antimony metal metals lithium cobalt');
const RIP_IN = set('fabric cloth clothing shirt jeans trousers pants dress sail sails tent canvas skin muscle muscles ligament ligaments meniscus retina screen sheet paper wall membrane lining seam seams curtain curtains material leather net jacket sleeve sock bag pocket rubber plastic tissue tendon cartilage hull roof page map');
const RIP_PREV = set('muscle acl ligament meniscus tendon hamstring rotator cuff retinal labral partial complete small large minor major tiny slight long jagged');
const BOW_BEND_PREV = set('deep low slight polite small quick formal courtly final last little graceful sweeping stiff respectful');
const BOW_SHIP = set('ship boat vessel yacht canoe kayak ferry liner tanker');
const ROW_PREV = set('blazing furious bitter heated huge big major public political diplomatic family legal ongoing latest fresh growing angry almighty bust furore');
const ROW_NEXT = set('over with between about erupted erupts broke escalated escalates deepened deepens rumbled rumbles intensified flared');
const FISH = set('sea striped largemouth smallmouth black rock spotted peacock chilean european giant kelp white caught catch catching fishing fish fillet fillets lake pond river angler anglers lure lures bait rod reel grilled baked seared roasted seafood trout cod salmon perch pike walleye crappie hooked landed species');
const DIVE_NEXT = set('into in off under for down headfirst deep deeper back through from onto out toward towards behind beneath over overboard across after straight right quickly');
const DEER_PREV = set('the these those two three four several many female young pregnant wild white-tailed and');

function words(tokens, i, dir, n) {
  const out = [];
  let k = i;
  for (let step = 0; step < n; step++) {
    k = neighbour(tokens, k, dir);
    if (k === null) break;
    out.push(tokens[k].lw);
  }
  return out;
}

// The words of i's sentence, at most 40 tokens either side (keeps long inputs linear).
function sentenceWords(tokens, i) {
  let a = i;
  let b = i;
  const stop = (t) => t.kind === 'punct' && (t.ps === '.' || t.ps === '!' || t.ps === '?');
  while (a > 0 && i - a < 40 && !stop(tokens[a - 1])) a--;
  while (b < tokens.length - 1 && b - i < 40 && !stop(tokens[b + 1])) b++;
  const out = [];
  for (let k = a; k <= b; k++) if (tokens[k].kind === 'word' && k !== i) out.push(tokens[k]);
  return out;
}

export function senseOf(tokens, i) {
  const w = tokens[i].lw;
  const [p1, p2] = words(tokens, i, -1, 2);
  const [n1, n2, n3, n4] = words(tokens, i, 1, 4);
  switch (w) {
    case 'lead':
      if (n1 && /^(?:singer|guitar|guitarist|role|actor|actress|character|author|story|investigator|vocals?|single|time|times|sheet|generation|engineer|developer|designer|scientist|researcher|negotiator|attorney|counsel|editor|reporter|writer|article|paragraph|sentence|car|horse|pipe)$/.test(n1) && n1 !== 'pipe') return null;
      if (n1 && LEAD_METAL_NEXT.has(n1)) return 'lead.metal';
      if (p1 && LEAD_METAL_PREV.has(p1)) return 'lead.metal';
      if ((p1 === 'as' || p1 === 'than') && p2 && /^(?:heavy|heavier|dense|denser|grey|gray|dull)$/.test(p2)) return 'lead.metal';
      if (p1 === 'of' && (!n1 || CONJ.has(n1)) && p2 !== 'the') return 'lead.metal';
      if ((p1 === 'to' || p1 === 'with' || p1 === 'from' || p1 === 'of') && ((p2 && LEAD_METAL_P2.has(p2)) || (n1 && MODAL.has(n1)))) return 'lead.metal';
      if ([p1, p2, n1, n2].some((x) => x && METALS.has(x))) return 'lead.metal';
      return null;
    case 'tear':
    case 'tears': {
      const rip = w === 'tear' ? 'tear.rip' : 'tears.rip';
      if (p1 === 'and' && p2 === 'wear') return rip;
      if (n1 === 'gas' || n1 === 'duct' || n1 === 'ducts' || n1 === 'drop' || n1 === 'drops') return null;
      if (n1 === 'in' || n1 === 'of') {
        const after = [n2, n3, n4].filter(Boolean);
        if (after.some((x) => /^(?:eye|eyes|voice)$/.test(x))) return null;
        if (after.some((x) => RIP_IN.has(x))) return rip;
        if (n1 === 'in' && (n2 === 'the' || n2 === 'a') && p1 && DET.has(p1)) return rip;
      }
      if (p1 && RIP_PREV.has(p1)) return rip;
      return null;
    }
    case 'bow':
    case 'bows': {
      const bend = w === 'bow' ? 'bow.bend' : 'bows.bend';
      if (p1 === 'a' && p2 && /^(?:take|takes|took|taking|taken|make|makes|made|give|gave)$/.test(p2)) return bend;
      if (p1 && BOW_BEND_PREV.has(p1)) return bend;
      if (n1 === 'of' && n2 && (BOW_SHIP.has(n2) || (n2 === 'the' && n3 && BOW_SHIP.has(n3)))) return bend;
      if ((n1 === 'to' || n1 === 'and') && n2 === 'stern') return bend;
      if (p1 && (BOW_SHIP.has(p1) || p1 === "ship's" || p1 === "boat's")) return bend;
      return null;
    }
    case 'row':
    case 'rows': {
      const fight = w === 'row' ? 'row.quarrel' : 'rows.quarrel';
      if (p1 && ROW_PREV.has(p1)) return fight;
      if (n1 && ROW_NEXT.has(n1) && p1 && (DET.has(p1) || POSS.has(p1))) return fight;
      return null;
    }
    case 'bass': {
      const ctx = [p1, p2, n1, n2];
      if (ctx.some((x) => x && FISH.has(x)) || sentenceWords(tokens, i).some((t) => /^(?:fish|fishing|caught|angler|anglers|lure|lures|fillets?|seafood)$/.test(t.lw))) return 'bass.fish';
      return 'bass.music';
    }
    case 'does':
      if (p1 && DEER_PREV.has(p1) && !(n1 && (SUBJ.has(n1) || OBJ.has(n1) || DET.has(n1) || NEG.has(n1) || n1 === 'so'))) {
        if (p1 !== 'and' || /^(?:bucks|stags|fawns|deer)$/.test(p2 || '')) return 'does.deer';
      }
      return null;
    case 'deserts':
      if (p1 === 'just' || p2 === 'just') return 'deserts.due';
      return null;
    case 'resume':
    case 'resumes':
      if (p1 && (FIRM_DET.has(p1) || POSS.has(p1) || /^(?:updated|new|short|strong|good|great|professional|detailed|attached|tailored|polished)$/.test(p1))) return w + '.noun';
      return null;
    default:
      return null;
  }
}

// Coarse classes a POS-table word can take: N(oun) V(erb) J (adjective) R (adverb).
function allowedClasses(lw, entry, tags) {
  const a = new Set();
  for (const c of tags.get(lw) || '') {
    if ('nsp'.includes(c)) a.add('N');
    else if ('vbzdeg'.includes(c)) a.add('V');
    else if ('jkl'.includes(c)) a.add('J');
    else if ('rtu'.includes(c)) a.add('R');
  }
  for (const k of Object.keys(entry)) {
    if (k === 'NOUN') a.add('N');
    else if (k === 'VERB' || k.startsWith('VB')) a.add('V');
    else if (k === 'ADJ') a.add('J');
    else if (k === 'ADV') a.add('R');
  }
  if (a.size < 2) a.add('N').add('V');
  return a;
}

const CLASS_TAG = { N: 'NN', J: 'JJ', R: 'RB' };

// Picks a Penn tag for word i (a POS-table word). entry: its misaki dict.
export function posTag(tokens, i, entry, tags) {
  const t = tokens[i];
  const lw = t.lw;
  const allowed = allowedClasses(lw, entry, tags);
  const cls = decide(tokens, i, lw, allowed, tags);
  if (cls !== 'V') {
    if (cls === 'N' && /s$/.test(lw) && !/ss$/.test(lw)) return 'NNS';
    return CLASS_TAG[cls];
  }
  return verbTag(tokens, i, lw, tags);
}

function info(tokens, k, tags) {
  if (k === null) return null;
  const t = tokens[k];
  return { t, w: t.lw, c: codesOf(t.lw, tags), k };
}

function isObjNext(n) {
  return !!n && (OBJ_NEXT.has(n.w) || (n.t.tag === 'NNP' && !BE.has(n.w)));
}

function isVerbNext(n) {
  if (!n) return false;
  if (BE.has(n.w) || HAVE.has(n.w) || MODAL.has(n.w) || DO.has(n.w)) return true;
  return 'zd'.includes(n.c[0]) && !nounish(n.c);
}

function isNounNext(n) {
  if (!n) return false;
  const w = n.w;
  if (DET.has(w) || POSS.has(w) || PREP.has(w) || CONJ.has(w) || BE.has(w) || HAVE.has(w) || MODAL.has(w) || DO.has(w) || SUBJ.has(w) || OBJ.has(w) || PART.has(w)) return false;
  return nounish(n.c) || n.t.tag === 'NNP';
}

function decide(tokens, i, lw, allowed, tags) {
  const can = (c) => allowed.has(c);
  const pick = (...order) => order.find(can) || [...allowed][0];
  let p1k = neighbour(tokens, i, -1);
  // "they often record", "will never desert": look past adverbs of frequency
  for (let n = 0; n < 2 && p1k !== null && (FREQ.has(tokens[p1k].lw) || tokens[p1k].lw === 'really') && !NEG.has(tokens[p1k].lw); n++) {
    const back = neighbour(tokens, p1k, -1);
    if (back === null) break;
    p1k = back;
  }
  const p1 = info(tokens, p1k, tags);
  const p2 = p1 && info(tokens, neighbour(tokens, p1k, -1), tags);
  const n1 = info(tokens, neighbour(tokens, i, 1), tags);
  const n2 = n1 && info(tokens, neighbour(tokens, n1.k, 1), tags);
  const pw = p1 && p1.w;
  const nw = n1 && n1.w;
  const gate = J_GATE[lw];
  const jBefore = (n) => can('J') && isNounNext(n) && (!gate || gate.has(n.w));

  if (gate && n1 && gate.has(nw) && can('J') && !(pw && (pw === 'to' || MODAL.has(pw)))) return 'J';
  if (lw === 'live' || lw === 'lives') {
    if (lw === 'live' && pw && BROADCAST.has(pw)) return pick('J', 'R');
    if (lw === 'live' && nw && LIVE_J_NEXT.has(nw) && !(pw && (SUBJ.has(pw) || MODAL.has(pw) || pw === 'to'))) return 'J';
  }
  if ((lw === 'content' || lw === 'close') && (nw === 'with' || nw === 'to') && !(pw && (pw === 'to' || MODAL.has(pw) || DO.has(pw)))) {
    if (lw === 'content' && nw === 'to' && pw && FIRM_DET.has(pw)) return 'N';
    return 'J';
  }
  if (lw === 'wound' || lw === 'wind' || lw === 'winds') {
    if ((nw === 'up' || nw === 'down') && !(pw && (FIRM_DET.has(pw) || POSS.has(pw)))) return 'V';
  }
  if (lw === 'dove' && nw && DIVE_NEXT.has(nw) && !(pw && (FIRM_DET.has(pw) || POSS.has(pw)))) return 'V';

  if (p1) {
    if (pw === 'to') {
      if (!can('V')) return pick('N', 'J');
      // "exposure to lead can harm": a noun when a modal follows
      if (n1 && MODAL.has(nw)) return pick('N', 'J');
      if (isObjNext(n1) || !(p2 && TO_PREP.has(p2.w))) return nw === 'of' ? 'N' : 'V';
      // "stood up to bow.": a bare singular at the end of the clause is a verb
      if (!n1 && !/[^s]s$/.test(lw) && (p2.w === 'up' || p2.w === 'down' || p2.w === 'back')) return 'V';
      return pick('N', 'J');
    }
    if (MAKE.has(pw) && can('J') && (!n1 || CONJ.has(nw))) return 'J';
    if (MODAL.has(pw) || DO.has(pw) || pw === 'please' || pw === "let's" || pw === 'cannot') return pick('V', 'N');
    if (NEG.has(pw)) {
      if (p2 && BE.has(p2.w)) return can('J') ? 'J' : SAME_VBN.has(lw) ? 'V' : pick('N', 'V');
      if (p2 && HAVE.has(p2.w)) return SAME_VBN.has(lw) ? 'V' : pick('N', 'V');
      return pick('V', 'N');
    }
    if (HAVE.has(pw)) {
      if (SAME_VBN.has(lw) && can('V')) return 'V';
      return jBefore(n1) ? 'J' : pick('N', 'J');
    }
    if (BE.has(pw)) {
      if (can('J') && !(SAME_VBN.has(lw) && !gate && isObjNext(n1))) return 'J';
      if (SAME_VBN.has(lw) && can('V')) return 'V';
      return pick('N', 'J');
    }
    if (DEGREE.has(pw) || pw === 'as') return can('J') ? 'J' : pw === 'as' ? pick('N', 'V') : pick('V', 'N');
    if (LINKING.has(pw)) return pick('J', 'N');
    if (QUANT.has(pw) && !FIRM_DET.has(pw) && can('V') && (nw === 'to' || isObjNext(n1))) return 'V';
    if (pw === 'that' && p1.t.tag === 'WDT' && can('V')) return 'V';
    if (DET.has(pw) || POSS.has(pw) || NUM.has(pw) || pw === 'of' || /'s?$/.test(pw) || p1.t.tag === 'CD') {
      return jBefore(n1) ? 'J' : pick('N', 'J');
    }
    if (SUBJ.has(pw) || pw === 'which') return pick('V', 'N');
    if (OBJ.has(pw) && p2 && LET.has(p2.w)) return pick('V', 'N');
    if (pw === 'what' || pw === 'whose') return pick('N', 'V');
    if (PREP.has(pw)) return jBefore(n1) ? 'J' : pick('N', 'J');
    if (CONJ.has(pw)) {
      if (isObjNext(n1) && can('V')) return 'V';
      if (p2 && verbish(p2.c) && !nounish(p2.c) && can('V')) return 'V';
      if (p2 && nounish(p2.c)) return pick('N', 'J');
    } else {
      const c0 = p1.c[0];
      if (c0 === 's' || c0 === 'q' || (p1.t.tag === 'NNP' && !p1.t.initial) || (c0 === 'z' && /s$/.test(pw) && p1.c.includes('s'))) {
        if (can('V') && nw !== 'of' && !isVerbNext(n1)) return 'V';
        return pick('N', 'J');
      }
      if ('jkl'.includes(c0)) return pick('N', 'J');
      if (c0 === 'n' || c0 === 'p') {
        // "my aunt lives by the sea", "the road winds through": an -s verb agreeing with its subject
        if (can('V') && /[^s]s$/.test(lw) && !isVerbNext(n1) && nw !== 'of') return 'V';
        return isObjNext(n1) && can('V') ? 'V' : pick('N', 'J');
      }
      if ('vbzdeg'.includes(c0)) return pick('N', 'J', 'V');
    }
  } else {
    // start of a sentence or clause: an imperative, or a subject
    if (nw === 'of') return pick('N', 'J');
    if (n1 && (isObjNext(n1) || PART.has(nw) || nw === 'before' || nw === 'into' || nw === 'onto' || nw === 'around' || nw === 'through')) return pick('V', 'N');
    if (isVerbNext(n1)) return pick('J', 'N');
    if (isNounNext(n1)) {
      if (n2 && isVerbNext(n2)) return pick('J', 'N');
      if (jBefore(n1) && n1.c[0] === 'n') return 'J';
      return pick('V', 'N');
    }
    if (n1 && PREP.has(nw)) return pick('V', 'N');
  }
  // the next word decides, or the word's most common class
  if (nw === 'of') return pick('N', 'J');
  if (isObjNext(n1) && can('V')) return 'V';
  if (isVerbNext(n1)) return pick('N', 'J');
  const c0 = (tags.get(lw) || 'n')[0];
  return pick('nsp'.includes(c0) ? 'N' : 'vbzdeg'.includes(c0) ? 'V' : 'jkl'.includes(c0) ? 'J' : 'N', 'N', 'V');
}

// Fine verb tag: VB after to/modals/imperatives, VBN after have/be, else past or present.
function verbTag(tokens, i, lw, tags) {
  let pk = neighbour(tokens, i, -1);
  while (pk !== null && (FREQ.has(tokens[pk].lw) || NEG.has(tokens[pk].lw) || tokens[pk].lw === 'really')) {
    const back = neighbour(tokens, pk, -1);
    if (back === null) break;
    pk = back;
  }
  const pw = pk === null ? null : tokens[pk].lw;
  if (pw === null || pw === 'to' || MODAL.has(pw) || DO.has(pw) || pw === 'please' || pw === "let's" || pw === 'cannot') return 'VB';
  if (OBJ.has(pw) && !SUBJ.has(pw)) {
    const p2 = neighbour(tokens, pk, -1);
    if (p2 !== null && LET.has(tokens[p2].lw)) return 'VB';
  }
  if (HAVE.has(pw) || BE.has(pw) || /^(?:well|widely|much|badly|little|seldom)$/.test(pw)) return 'VBN';
  if (SUBJ.has(pw)) {
    // "Have you read it?", "Was it wound?"
    const p2 = neighbour(tokens, pk, -1);
    if (p2 !== null && (HAVE.has(tokens[p2].lw) || BE.has(tokens[p2].lw))) return 'VBN';
    if (p2 !== null && (MODAL.has(tokens[p2].lw) || DO.has(tokens[p2].lw))) return 'VB';
  }
  if (lw.endsWith('s') && !SAME_VBN.has(lw)) return 'VBZ';
  return pastTense(tokens, i, pk, tags) ? 'VBD' : 'VBP';
}

function pastTense(tokens, i, pk, tags) {
  const others = sentenceWords(tokens, i);
  for (const t of others) if (PAST_CUE.has(t.lw)) return true;
  // "he read" has no -s, so it is past even with "every night"; "they read" could be either
  if (pk !== null && singularSubject(tokens, pk, tags)) return true;
  for (const t of others) if (PRES_CUE.has(t.lw)) return false;
  let past = 0;
  let pres = 0;
  for (const t of others) {
    if (/^(?:was|were|did|had|didn't|wasn't|weren't|hadn't)$/.test(t.lw)) past++;
    else if (/^(?:is|are|am|do|does|has|have|don't|doesn't|isn't|aren't)$/.test(t.lw)) pres++;
    else {
      const c = codesOf(t.lw, tags);
      if (c[0] === 'd' && !c.includes('j')) past++;
      else if (c[0] === 'z') pres++;
    }
  }
  return past > pres;
}

function singularSubject(tokens, pk, tags) {
  {
    let s = tokens[pk];
    if (/^(?:he|she|it)$/.test(s.lw)) return true;
    if (SUBJ.has(s.lw) && s.lw !== 'who') return false;
    if (s.lw === 'who' || s.lw === 'that' || s.lw === 'which') {
      const ante = neighbour(tokens, pk, -1);
      if (ante === null) return false;
      s = tokens[ante];
    }
    const sc = codesOf(s.lw, tags);
    return (sc[0] === 'n' || (s.tag === 'NNP' && !s.initial)) && !/s$/.test(s.lw);
  }
}
