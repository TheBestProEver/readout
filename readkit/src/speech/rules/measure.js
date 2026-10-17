// Fractions, ranges, dimensions and units of measurement.
//   1/2 -> 'one half', 1 1/2 cups -> 'one and a half cups', ½ tsp -> 'one half teaspoon'
//   24/7, 9/11, 50/50; 120/80 mmHg -> 'one twenty over eighty'; rated 8/10 -> 'eight out of ten'
//   1914-18 -> 'nineteen fourteen to eighteen'; 12-14 / 5–10 km -> 'to'
//   9x13, 10 × 20 cm -> 'by'; 1.5x -> 'one point five times'
//   5 km, 3.2km, 8,849 m, 20 min, -5°C, 5 mg/mL, 2.7 g/cm³ (US kilometers | UK kilometres)

import UNIT_TABLE from '../../../data/speech/units.js';
import { cardinal, numberWords, ordinal, pluralWords, serial, under100, year } from '../numbers.js';
import { alternation } from './util.js';

const UNITS = new Map();
for (const line of UNIT_TABLE.split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [sym, one, many, flags = ''] = line.split('\t');
  const uk = (w) => w.replace(/meter/g, 'metre').replace(/liter/g, 'litre');
  UNITS.set(sym, { one, many, ukOne: uk(one), ukMany: uk(many), flags });
}
const UNIT_ALT = alternation([...UNITS.keys()]);
const NUM = '([-−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)';
const EXP = '(?:\\^([23])|([23])(?![\\w.]))?';
const UNIT_RE = new RegExp(`(?<![\\w.,])${NUM}([ \\t]?|-)(${UNIT_ALT})${EXP}(?:/(${UNIT_ALT})${EXP})?(\\.(?=\\s+[a-z]))?(?![\\w/²³])`, 'g');

// After a spaced risky unit ('5 in', '10 s'), these mean it really is a unit.
const MEASURE_NEXT = /^(?:\s*(?:[.,;:!?)\]]|$)|\s+(?:tall|long|wide|high|deep|thick|across|away|apart|above|below|deep|diameter|radius|square|x|×|by|per|of|later|earlier|ago|each|and\s+\d|or\s+\d|to\s+\d)\b)/;
// 'm' before these is million: '5 m people'
const COUNTED = /^\s*(?:people|users|customers|viewers|subscribers|followers|visitors|residents|voters|jobs|homes|households|children|adults|women|men|patients|cases|deaths|tons|tonnes|barrels|downloads|copies|units|views|years|dollars|pounds|euros|passengers|students|workers|employees|members|readers|listeners|fans|tourists|refugees|vehicles|cars|devices|accounts|records|acres|hectares)\b/;
// After 'a 5 km' a noun makes the unit adjectival and singular ('a five kilometre run').
const NOT_NOUN = /^(?:of|in|on|to|from|and|or|away|long|tall|wide|high|deep|thick|per|is|was|are|were|at|by|for|with|than|more|less|each|across|above|below|apart|ago|later|earlier|before|after|into|over|under|between|around|behind|beyond|off|up|down|out|north|south|east|west|ahead|back|left|remaining|total|so|but|which|that|as|if|when|while|or)$/;

const isOne = (n) => /^[-−]?1(?:\.0+)?$/.test(n);
const unitWord = (u, n, ctx, singular) => (singular || isOne(n) ? (ctx.uk ? u.ukOne : u.one) : ctx.uk ? u.ukMany : u.many);
const power = (sq, cu) => ((sq || cu) === '2' ? 'square ' : (sq || cu) === '3' ? 'cubic ' : '');

function adjectival(s, start, end) {
  if (!/\b(?:a|an|the|this|that|each|every|one)\s+$/i.test(s.slice(Math.max(0, start - 6), start))) return false;
  const m = /^\s+([a-z][a-z-]+)/.exec(s.slice(end, end + 30));
  return !!m && !NOT_NOUN.test(m[1]);
}

export function unitRules(t, ctx) {
  if (!/\d/.test(t.s)) return t;
  // temperatures written '34C' in British papers, when the sentence is about weather
  if (/\d[CF]\b/.test(t.s) && /\b(?:temperatures?|temp|degrees|weather|heat|hot|cold|warm|cool|chilly|freezing|forecast|highs?|lows?|heatwave|mild|thermometer|oven)\b/i.test(t.s)) {
    t.replace(/(?<![\w.,])([-−]?\d{1,3}(?:\.\d)?)([CF])(?![\w])/g, (m) => `${numberWords(m[1], ctx.uk)} ${isOne(m[1]) ? 'degree' : 'degrees'} ${m[2] === 'C' ? 'Celsius' : 'Fahrenheit'}`);
  }
  t.replace(UNIT_RE, (m, s) => {
    const [, n, gap, sym, sq1, cu1, sym2, sq2, cu2, dot] = m;
    const u = UNITS.get(sym);
    const end = m.index + m[0].length;
    const spaced = gap === ' ' || gap === '\t';
    const after = s.slice(end, end + 40);
    if (u.flags.includes('A') && gap) return null;
    if (u.flags.includes('R') && spaced && !sym2 && !dot && !MEASURE_NEXT.test(after)) return null;
    if (sym === 'm' && !sym2 && COUNTED.test(after)) return `${numberWords(n, ctx.uk)} million`;
    const singular = gap === '-' || adjectival(s, m.index, end);
    let words = power(sq1, cu1) + unitWord(u, n, ctx, singular);
    if (sym2) {
      const u2 = UNITS.get(sym2);
      words += ' per ' + power(sq2, cu2) + (ctx.uk ? u2.ukOne : u2.one);
    }
    return numberWords(n.replace(/,/g, ''), ctx.uk) + (gap === '-' ? '-' : ' ') + words;
  });
  return t;
}

// ---------- fractions ----------

function fractionWords(a, b, ctx) {
  if (b === 2) return a === 1 ? 'one half' : cardinal(a) + ' halves';
  if (b === 4) return a === 1 ? 'one quarter' : cardinal(a) + ' quarters';
  const o = ordinal(b, ctx.uk);
  return a === 1 ? 'one ' + o : cardinal(a, ctx.uk) + ' ' + pluralWords(o);
}

function mixed(whole, a, b, ctx) {
  const part = a === 1 ? (b === 2 ? 'a half' : b === 4 ? 'a quarter' : 'a ' + ordinal(b, ctx.uk)) : fractionWords(a, b, ctx);
  return cardinal(whole, ctx.uk) + ' and ' + part;
}

const SPECIAL = { '24/7': 'twenty-four seven', '9/11': 'nine eleven', '50/50': 'fifty-fifty', '20/20': 'twenty twenty', '7/11': 'seven eleven' };
const FRAC_U = new RegExp(`(?<![\\d⁄])(?:(\\d{1,3})\\s)?(\\d+)⁄(\\d+)(?![\\d⁄])(?:([ \\t]?)(${UNIT_ALT})(?![\\w/]))?`, 'g');
const FRAC = new RegExp(`(?<![\\w/.,:⁄])(?:(\\d{1,2})[ \\t]+)?(\\d{1,3})/(\\d{1,4})(?:([ \\t]?)(${UNIT_ALT})(?![\\w/]))?(?![\\w/]|[.,]\\d)`, 'g');
const BP_BEFORE = /\b(?:blood pressure|BP|pressure)\b[^.]{0,20}$/i;

const MEASURE_NOUN = /^(?:cups|teaspoons|tablespoons|spoons|pints|quarts|gallons|litres|liters|inches|feet|yards|miles|metres|meters|pounds|ounces|grams|kilos|tons|tonnes|hours|minutes|seconds|days|weeks|months|years|centuries|turns|rotations|revolutions|notes|beats|bars|slices|pieces|portions|servings|sticks|cloves|lengths|thirds|halves|quarters|times|points|degrees|acres|hectares|shares|marks)$/;

function sayFraction(m, s, ctx, unambiguous) {
  const [, whole, A, B, gap, sym] = m;
  const a = +A;
  const b = +B;
  if (!b) return null;
  const end = m.index + m[0].length;
  let out;
  let plural;
  if (!unambiguous && !whole) {
    const key = `${A}/${B}`;
    if (SPECIAL[key] && !sym) return SPECIAL[key];
    if ((sym === 'mmHg' || BP_BEFORE.test(s.slice(Math.max(0, m.index - 40), m.index))) && b >= 40) {
      return `${serial(A, ctx.uk)} over ${cardinal(B, ctx.uk)}` + (sym ? ' ' + unitWord(UNITS.get(sym), '2', ctx) : '');
    }
    // scores: '95/100 on the test', 'rated 8/10', '4/5 stars'
    if ([5, 10, 20, 100].includes(b) && a <= b && !sym) {
      const after = s.slice(end, end + 12);
      const cue = /\b(?:scored?|scoring|rated?|rating|got|gets|gave|earned|marks?|grade[sd]?)\s+$/i.test(s.slice(Math.max(0, m.index - 12), m.index));
      const follow = /^\s*(?:[.,;:!?)]|$|points?\b|overall\b|rating\b|on\b|in\b|for\b)/.test(after);
      if (cue || /^\s*stars?\b/.test(after) || (a > 1 && b >= 10 && follow)) return `${cardinal(a, ctx.uk)} out of ${cardinal(b, ctx.uk)}`;
    }
    // '4/5 dentists', 'on 5/7 benchmarks' count things; '3/4 cups' measures them
    const noun = /^\s+([a-z]+s)\b/.exec(s.slice(end, end + 24));
    if (noun && a <= b && !sym && !MEASURE_NOUN.test(noun[1])) return `${cardinal(a, ctx.uk)} out of ${cardinal(b, ctx.uk)}`;
  }
  if (a >= 100 || !(b <= 16 || [20, 25, 32, 50, 64, 100, 1000].includes(b))) {
    out = `${cardinal(A, ctx.uk)} over ${cardinal(B, ctx.uk)}`;
    if (whole) out = cardinal(whole, ctx.uk) + ' and ' + out;
    plural = true;
  } else if (whole) {
    out = mixed(whole, a, b, ctx);
    plural = true;
  } else {
    out = fractionWords(a, b, ctx);
    plural = a > b;
  }
  if (sym) {
    const u = UNITS.get(sym);
    if (u.flags.includes('R') && gap) return out + gap + sym;
    out += ' ' + unitWord(u, plural ? '2' : '1', ctx);
  }
  return out;
}

export function fractionRules(t, ctx) {
  if (t.s.includes('⁄')) t.replace(FRAC_U, (m, s) => sayFraction(m, s, ctx, true));
  if (t.s.includes('/')) t.replace(FRAC, (m, s) => sayFraction(m, s, ctx, false));
  return t;
}

// ---------- ranges and dimensions ----------

const YEAR_RANGE = /(?<![\w.,\-–$£€#])(1\d{3}|20\d{2})[ \t]?([–\-—/])[ \t]?(\d{4}|\d{2})(?![\w%]|[.,]\d)/g;
const COUNT_AFTER = /^\s*(?:people|persons|items|words|pages|times|miles|kilometers|kilometres|km|kg|units|copies|students|members|employees|cases|deaths|votes|points|dollars|pounds|euros|feet|meters|metres|calories|rows|tons|tonnes|acres|square|hectares|homes|houses|jobs|patients|children|adults|men|women|residents|participants|respondents|samples|cars|vehicles|tickets|seats|rooms|beds|bytes|pixels|lines|characters|steps|images|files|hours|minutes|seconds|days|weeks|months|rpm|ft|m|g|mg|ml)\b/;
const PAGE_BEFORE = /\b(?:pp?\.|pages?|lines?|nos?\.|numbers?|verses?|items?|steps?|rows?|columns?)\s*$/i;

export function rangeRules(t, ctx) {
  if (!/\d\s?[–\-—/]\s?\d/.test(t.s)) return t;
  t.replace(YEAR_RANGE, (m, s) => {
    const [, A, sep, B] = m;
    const end = m.index + m[0].length;
    if (COUNT_AFTER.test(s.slice(end, end + 20)) || PAGE_BEFORE.test(s.slice(Math.max(0, m.index - 12), m.index))) return null;
    const full = B.length === 2 ? A.slice(0, 2) + B : B;
    if (+full <= +A || +full - +A > 300) return null;
    if (sep === '/' && B.length === 4 && +full - +A !== 1) return null;
    const second = B.length === 2 && +B >= 10 ? under100(+B) : year(full, ctx.uk);
    return `${year(A, ctx.uk)} to ${second}`;
  });
  // keep the numbers as digits so units after them still work: '5-10 km' -> '5 to 10 km'
  t.replace(/(?<![\w.,\-–])(-?\d[\d,]*(?:\.\d+)?)[ \t]?[–—][ \t]?(?=-?\d)/g, (m) => m[1] + ' to ');
  const math = /=|[<>≤≥]/.test(t.s);
  t.replace(/(?<![\w.,\-–/:])(\d[\d,]*(?:\.\d+)?)([ \t]?)-\2(?=(\d[\d,]*(?:\.\d+)?)(?![\w\-/:]|\.\d))/g, (m) => {
    if (math) return null;
    if (/^0\d/.test(m[1]) || /^0\d/.test(m[3])) return null;
    return m[1] + ' to ';
  });
  return t;
}

const DIM = /(?<![\w.,])(\d+(?:\.\d+)?)[ \t]?[x×][ \t]?(\d+(?:\.\d+)?)(?:[ \t]?[x×][ \t]?(\d+(?:\.\d+)?))?(?![\w.]|\.\d)/g;

export function dimensionRules(t) {
  if (!/\d[ \t]?[x×]/.test(t.s)) return t;
  const math = /=/.test(t.s);
  t.replace(DIM, (m, s) => {
    const end = m.index + m[0].length;
    const by = math || s[end] === '^' ? ' times ' : ' by ';
    return m[1] + by + m[2] + (m[3] ? by + m[3] : '');
  });
  // multipliers: '1.5x faster', '3× more'; '2x + 3' is algebra
  t.replace(/(?<![\w.,])(\d+(?:\.\d+)?)[ \t]?[x×](?=$|[\s.,;:!?)])/g, (m, s) => (/^\s*[+\-−=<>]/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 3)) ? null : m[1] + ' times'));
  t.replace(/(?<![\w])×[ \t]?(?=\d)/g, 'times ');
  return t;
}
