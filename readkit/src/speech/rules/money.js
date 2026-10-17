// Money and percentages.
//   $3.50 -> 'three dollars and fifty cents' (UK '£4.99' -> 'four pounds ninety-nine')
//   $0.99 -> 'ninety-nine cents'; $2.5M, £1.2bn, €15k, $3 billion -> magnitude first
//   $5-10 -> 'five to ten dollars'; US$5, A$, C$; USD/GBP/EUR codes; 50p (UK), 99¢
//   old British money: 3l. 10s. 6d., £3 10s., 1s. 6d., 47s., 4½d. -> 'three pounds ten shillings and six pence'
//   12% -> 'twelve percent' | 'twelve per cent'; 10-20%; 2 pp -> 'percentage points'

import { cardinal, decimal, numberWords, under100 } from '../numbers.js';
import { wordAfter, wordBefore, endDot } from './util.js';

const CURRENCY = {
  $: ['dollar', 'dollars', 'cent', 'cents'], '£': ['pound', 'pounds', 'penny', 'pence'], '€': ['euro', 'euros', 'cent', 'cents'],
  '¥': ['yen', 'yen'], '₹': ['rupee', 'rupees', 'paisa', 'paise'], '₩': ['won', 'won'], '₽': ['ruble', 'rubles', 'kopek', 'kopeks'],
  '₺': ['lira', 'lira'], '₪': ['shekel', 'shekels', 'agora', 'agorot'], '₦': ['naira', 'naira', 'kobo', 'kobo'],
  '₱': ['peso', 'pesos', 'centavo', 'centavos'], '฿': ['baht', 'baht'],
};
const CODES = {
  USD: ['$', 'US'], GBP: ['£', ''], EUR: ['€', ''], JPY: ['¥', ''], INR: ['₹', ''], CAD: ['$', 'Canadian'], AUD: ['$', 'Australian'],
  NZD: ['$', 'New Zealand'], HKD: ['$', 'Hong Kong'], SGD: ['$', 'Singapore'], CHF: ['CHF', ''], CNY: ['CNY', ''], RMB: ['CNY', ''],
};
CURRENCY.CHF = ['Swiss franc', 'Swiss francs', 'centime', 'centimes'];
CURRENCY.CNY = ['yuan', 'yuan', 'fen', 'fen'];
const PREFIX = { US: 'US', A: 'Australian', AU: 'Australian', C: 'Canadian', CA: 'Canadian', NZ: 'New Zealand', HK: 'Hong Kong', S: 'Singapore' };
const MAG = { k: 'thousand', K: 'thousand', m: 'million', M: 'million', mn: 'million', mln: 'million', mil: 'million', b: 'billion', B: 'billion', bn: 'billion', bln: 'billion', tn: 'trillion', T: 'trillion', thousand: 'thousand', million: 'million', billion: 'billion', trillion: 'trillion' };
const PER = { hr: 'hour', h: 'hour', hour: 'hour', day: 'day', wk: 'week', week: 'week', mo: 'month', month: 'month', yr: 'year', year: 'year', night: 'night', person: 'person', head: 'head', kg: 'kilogram', lb: 'pound', unit: 'unit', item: 'item', gal: 'gallon', gallon: 'gallon', l: 'litre', litre: 'litre', liter: 'liter', mile: 'mile', km: 'kilometre', min: 'minute', minute: 'minute', share: 'share', barrel: 'barrel', bbl: 'barrel', ton: 'ton', tonne: 'tonne', annum: 'annum', sqft: 'square foot', m2: 'square metre' };

const SYM = '[$£€¥₹₩₽₺₪₦₱฿]';
const AMOUNT = '(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?';
const MAGS = '(?:\\s?(k|K|m|M|mn|mln|mil|bn|bln|b|B|tn|T)(?![\\w])|\\s(thousand|million|billion|trillion)\\b)?';
const PER_RE = `(?:\\s?/\\s?(${Object.keys(PER).join('|')})\\b)?`;
const MONEY = new RegExp(`(?<![\\w$£€¥₹₩₽₺₪₦₱฿])([-−])?(US|AU|A|CA|C|NZ|HK|S)?(${SYM})\\s?${AMOUNT}${MAGS}(?:\\s?(?:[–\\-]|to)\\s?${SYM}?${AMOUNT}${MAGS})?${PER_RE}`, 'g');
const CODE_BEFORE = new RegExp(`(?<![\\w])(${Object.keys(CODES).join('|')})\\s?${AMOUNT}${MAGS}`, 'g');
const MONEY_AFTER = new RegExp(`(?<![\\w.,$£€¥₹₩₽₺₪₦₱฿])([-−])?${AMOUNT}(?:\\s?(k|K|m|M|mn|bn|tn))?\\s?(${SYM})(?![\\w$£€¥₹₩₽₺₪₦₱฿])`, 'g');
const CODE_AFTER = new RegExp(`(?<![\\w.,])${AMOUNT}${MAGS}\\s?(${Object.keys(CODES).join('|')})\\b`, 'g');
const PERCENT = /(?<![\w.])([-−+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[-−+]?\.\d+)(?:\s?%)?(?:\s?(?:[–\-]|to)\s?([-−+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))?\s?(%|‰)/g;
const POINTS = /(?<![\w.])(\d+(?:\.\d+)?)\s?(?:ppts?|pp|p\.p\.)(?![\w])/g;
// '5-dollar bill': after a/an/the and before a noun the unit is singular.
const ADJ_AFTER = /^(?:bill|note|coin|fee|fine|charge|ticket|voucher|gift|tip|deposit|discount|surcharge|increase|cut|price|budget|loan|bet|donation|payment|check|cheque)s?$/;

const signed = (neg, s) => (neg ? 'minus ' : '') + s;

function amount(int, frac, cur, prefix, ctx) {
  const uk = ctx.uk;
  const whole = +int.replace(/,/g, '');
  if (frac && frac.length === 3 && cur[2]) {
    const cents = +frac.slice(1);
    if (whole === 0) return `${cardinal(cents)} ${cents === 1 ? cur[2] : cur[3]}`;
    const main = `${cardinal(int, uk)} ${prefix}${whole === 1 ? cur[0] : cur[1]}`;
    if (cents === 0) return main;
    if (uk) return `${main} ${under100(cents)}`;
    return `${main} and ${under100(cents)} ${cents === 1 ? cur[2] : cur[3]}`;
  }
  if (frac && /^\.0+$/.test(frac)) frac = '';
  if (frac) return `${decimal(int + frac, uk)} ${prefix}${cur[1]}`;
  return `${cardinal(int, uk)} ${prefix}${whole === 1 ? cur[0] : cur[1]}`;
}

function sayMoney(cur, prefix, neg, i1, f1, mag1, i2, f2, mag2, per, ctx) {
  const uk = ctx.uk;
  const perWord = per ? ' per ' + (uk ? PER[per] : PER[per].replace('litre', 'liter').replace('kilometre', 'kilometer').replace('square metre', 'square meter')) : '';
  if (i2 !== undefined) {
    const mag = mag2 || mag1;
    const a = numberWords(i1.replace(/,/g, '') + (f1 || ''), uk) + (mag1 && mag1 !== mag ? ' ' + mag1 : '');
    const b = numberWords(i2.replace(/,/g, '') + (f2 || ''), uk);
    return signed(neg, `${a} to ${b}${mag ? ' ' + mag : ''} ${prefix}${cur[1]}`) + perWord;
  }
  if (mag1) return signed(neg, `${numberWords(i1.replace(/,/g, '') + (f1 || ''), uk)} ${mag1} ${prefix}${cur[1]}`) + perWord;
  return signed(neg, amount(i1, f1, cur, prefix, ctx)) + perWord;
}

export function moneyRules(t, ctx) {
  const s0 = t.s;
  if (/[$£€¥₹₩₽₺₪₦₱฿]/.test(s0)) {
    t.replace(MONEY, (m, s) => {
      const cur = CURRENCY[m[3]];
      const prefix = m[2] ? PREFIX[m[2]] + ' ' : '';
      const mag1 = MAG[m[6] || m[7]];
      const mag2 = MAG[m[10] || m[11]];
      // adjectival: 'a $5 fee' -> 'a five-dollar fee'
      if (!m[5] && !mag1 && m[8] === undefined && !m[12] && /\b(?:a|an|the|this|that|each|every)\s+$/i.test(s.slice(Math.max(0, m.index - 6), m.index))) {
        if (ADJ_AFTER.test(wordAfter(s, m.index + m[0].length))) return signed(m[1], `${cardinal(m[4], ctx.uk)}-${prefix ? prefix : ''}${cur[0]}`);
      }
      return sayMoney(cur, prefix, m[1], m[4], m[5], mag1, m[8], m[9], mag2, m[12], ctx);
    });
    // the sign after the amount, as much of Europe writes it: '15 €', '1234.56€'
    if (/\d\s?[€£$¥₹₩₽₺₪₦₱฿]/.test(t.s)) t.replace(MONEY_AFTER, (m) => sayMoney(CURRENCY[m[5]], '', m[1], m[2], m[3], MAG[m[4]], undefined, '', '', '', ctx));
  }
  if (/\b(?:USD|GBP|EUR|JPY|INR|CAD|AUD|NZD|HKD|SGD|CHF|CNY|RMB)\b/.test(t.s)) {
    t.replace(CODE_BEFORE, (m) => {
      const [sym, pre] = CODES[m[1]];
      return sayMoney(CURRENCY[sym], pre ? pre + ' ' : '', '', m[2], m[3], MAG[m[4] || m[5]], undefined, '', '', '', ctx);
    });
    t.replace(CODE_AFTER, (m) => {
      const [sym, pre] = CODES[m[5]];
      return sayMoney(CURRENCY[sym], pre ? pre + ' ' : '', '', m[1], m[2], MAG[m[3] || m[4]], undefined, '', '', '', ctx);
    });
  }
  if (ctx.uk) t.replace(/(?<![\w.,£$])(\d{1,2})p(?![\w])/g, (m) => (m[1] === '1' ? 'one penny' : cardinal(m[1], true) + ' pence'));
  if (t.s.includes('¢')) t.replace(/(\d{1,2})\s?¢/g, (m) => cardinal(m[1]) + (m[1] === '1' ? ' cent' : ' cents'));
  if (/[%‰]/.test(t.s)) {
    t.replace(PERCENT, (m) => {
      const word = m[3] === '‰' ? 'per mille' : ctx.uk ? 'per cent' : 'percent';
      const plus = m[1][0] === '+' ? 'plus ' : '';
      const a = plus + numberWords(m[1].replace(/^\+/, '').replace(/,/g, ''), ctx.uk);
      const b = m[2] ? ' to ' + numberWords(m[2].replace(/^\+/, '').replace(/,/g, ''), ctx.uk) : '';
      return `${a}${b} ${word}`;
    });
  }
  if (/\d\s?p/.test(t.s)) {
    // '45 pp.' in a reference list is pages, so a full stop needs a rate nearby
    const rates = /%|per ?cent|\brates?\b|\bpoints?\b/i.test(t.s);
    t.replace(POINTS, (m, s) => (s[m.index + m[0].length] === '.' && !rates ? null : `${numberWords(m[1], ctx.uk)} percentage point${m[1] === '1' ? '' : 's'}`));
  }
  return t;
}

/* ---------- pounds, shillings and pence ---------- */

// Old British money, as eighteenth- and nineteenth-century books print it: '3l. 10s. 6d.',
// '£3 10s.', '1s. 6d.', '47s. the quarter', '4½d.' (clean has made '½' into ' 1⁄2').
// A lone '20s.' or '50l.' is money only where the sentence says so ('a year', 'rent',
// another amount, a price word before it); otherwise it is left for decades and litres.
const LSD_N = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
const LSD_FR = '(1⁄2|1⁄4|3⁄4)';
const LSD_PENNY = String.raw`(?:(\d{1,2})(?:\s?${LSD_FR})?|${LSD_FR})d`;
const LSD_PENCE = LSD_PENNY + String.raw`\.`;
const LSD_FULL = new RegExp(String.raw`(?<![\w£$.,⁄])(?:£\s?${LSD_N}|${LSD_N}l\.)(?:,?\s?(\d{1,2})s\.)?(?:,?\s?${LSD_PENCE})?(?![\w⁄])`, 'g');
const LSD_SD = new RegExp(String.raw`(?<![\w.,⁄])(\d{1,3})s\.?,?\s?${LSD_PENNY}\.?(?![\w⁄])`, 'g');
const LSD_S = /(?<![\w.,⁄])(\d{1,3})s\.(?![\w⁄])/g;
const LSD_D = new RegExp(String.raw`(?<![\w.,⁄])${LSD_PENCE}(?![\w⁄])`, 'g');
const LSD_CUE = /\d\s?[sd]\.(?!\w)|£|\bsterling\b|\bshillings?\b|\bpence\b|\bpenny\b/;
const MONEY_WORDS = /\b(?:sterling|pounds?|shillings?|pence|penny|guineas?|rents?|revenue|tax(?:es)?|debts?|income|price|prices|cost|costs|paid|pay|pays|wages?|salary|a[- ]year|per annum|yearly|annually|capital|stock|fund|loan|money|sum|duty|duties|bounty|profit|profits|value|worth|expence|expense)\b/i;
const PRICE_BEFORE = /^(?:cost|costs|paid|pay|pays|price|worth|at|for|of|earn|earns|earned|wages|rent|sold|sell|sells|about|than|from|to|and|or|only|nearly|above|below|under|over|is|was|be|were|are|amounted|amounts|sum|value)$/i;
const DECADE_BEFORE = /^(?:the|early|late|mid|his|her|their|my|our|your|its)$/i;
const FRACTION_WORD = { '1⁄2': ['a half', 'a halfpenny'], '1⁄4': ['a quarter', 'a farthing'], '3⁄4': ['three quarters', 'three farthings'] };

const pounds = (n, uk) => `${cardinal(n.replace(/,/g, ''), uk)} ${n === '1' ? 'pound' : 'pounds'}`;
const shillings = (n, uk) => `${cardinal(n, uk)} ${n === '1' ? 'shilling' : 'shillings'}`;
function pence(n, fr, fr2, uk) {
  if (!n) return FRACTION_WORD[fr2][1];
  if (fr) return `${cardinal(n, uk)} and ${FRACTION_WORD[fr][0]} pence`;
  return n === '1' ? 'one penny' : `${cardinal(n, uk)} pence`;
}
function lsd(parts) {
  const [l, s, d] = parts;
  const head = [l, s].filter(Boolean).join(' ');
  return d ? (head ? `${head} and ${d}` : d) : head;
}

// What the whole string says about money, counted once per pass (per match would be quadratic).
const LSD_CUE_G = new RegExp(LSD_CUE.source, 'g');
function lsdContext(s) {
  return { cues: (s.match(LSD_CUE_G) || []).length, words: MONEY_WORDS.test(s), decades: (s.match(/\d0['’]?s\b/g) || []).length };
}

// Whether a lone amount ('20s.', '50l.') matched by m in s is money.
function lsdAlone(m, s, decadeLike, c) {
  const end = m.index + m[0].length;
  const after = s.slice(end, end + 8);
  const prev = wordBefore(s, m.index);
  // another amount or a money word; '50l.' doesn't vouch for '2l.' ('Add 2l. of water... 50l.')
  const cue = c.words || c.cues > (LSD_CUE.test(m[0]) ? 1 : 0);
  // 'the 1980s and 90s.': another decade nearby
  if (decadeLike && (DECADE_BEFORE.test(prev) || c.decades > (/0s/.test(m[0]) ? 1 : 0))) return false;
  if (/^\s*[,;:)]/.test(after)) return true;
  if (/^\s+["'(]?\p{Ll}/u.test(after)) return /^\s+of\b/.test(after) || /^an?$/i.test(prev) ? cue : true;
  return cue || (!decadeLike && PRICE_BEFORE.test(prev));
}

export function oldMoneyRules(t, ctx) {
  if (!/\d(?:\s?1⁄[24])?[lsd]\.|1⁄[24]d\.|£\s?\d[\d,]*,?\s\d{1,2}s|\ds\s\d{1,2}d\b/.test(t.s)) return t;
  const uk = ctx.uk;
  const close = (s, end) => (s[end - 1] === '.' ? endDot(s, end) : '');
  let c = null;
  t.replace(LSD_FULL, (m, s) => {
    const [, pl, ll, sh, dn, dfr, dfr2] = m;
    const hasD = dn !== undefined || dfr2 !== undefined;
    if (pl !== undefined && sh === undefined && !hasD) return null; // '£3': moneyRules
    if (ll !== undefined && sh === undefined && !hasD && !lsdAlone(m, s, false, (c ??= lsdContext(s)))) return null;
    const said = lsd([pounds(pl ?? ll, uk), sh && shillings(sh, uk), hasD && pence(dn, dfr, dfr2, uk)]);
    return said + close(s, m.index + m[0].length);
  });
  t.replace(LSD_SD, (m, s) => {
    // '3s 6d' without full stops, but not 'the 80s 3d films'
    if (!m[0].includes('.') && /0$/.test(m[1])) return null;
    return lsd(['', shillings(m[1], uk), pence(m[2], m[3], m[4], uk)]) + close(s, m.index + m[0].length);
  });
  c = null;
  t.replace(LSD_S, (m, s) => {
    const n = m[1];
    const decadeLike = /^(?:\d0|\d{3})$/.test(n);
    return lsdAlone(m, s, decadeLike, (c ??= lsdContext(s))) ? shillings(n, uk) + close(s, m.index + m[0].length) : null;
  });
  t.replace(LSD_D, (m, s) => pence(m[1], m[2], m[3], uk) + close(s, m.index + m[0].length));
  return t;
}
