// Dates and times.
//   2024-07-04, 07/04/2024 (first field > 12: day first; second > 12: month first; otherwise
//   the dialect's order), 'July 4, 2024', '4 July 2024', 'the 3rd of May', 'Jan. 5', 'on 10/14'
//   US 'July fourth, twenty twenty-four'; UK 'the fourth of July, twenty twenty-four'
//   3:30 pm, 10:05, 15:45, 7.15am, 10am-6pm, 1:23:45 (a duration)

import { MONTHS, MONTH_INDEX, WEEKDAYS } from '../../../data/speech/abbreviations.js';
import { cardinal, ordinal, under100, year } from '../numbers.js';
import { endDot, endDotCap } from './util.js';

// A full stop belongs to abbreviated months only: 'Jan. 5', but '3 March.' ends a sentence.
const MON = '(January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?)';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const monthOf = (name) => MONTH_INDEX[name.slice(0, 3).toLowerCase()];
const validDay = (d, mo) => d >= 1 && d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo];
const fullYear = (y) => (y.length === 2 ? (+y > 40 ? '19' : '20') + y : y);
const precededByThe = (s, i) => /\bthe\s+$/i.test(s.slice(Math.max(0, i - 5), i));

// Month and day in the dialect's spoken order, with an optional year.
function sayDate(d, mo, y, ctx, theBefore) {
  const yy = y ? ', ' + year(y, ctx.uk) : '';
  if (ctx.uk) return `${theBefore ? '' : 'the '}${ordinal(d)} of ${MONTHS[mo]}${yy}`;
  return `${MONTHS[mo]} ${ordinal(d)}${yy}`;
}

const ISO = /(?<![\d\-/.])(\d{4})-(\d{2})-(\d{2})(?![\d\-/]|\.\d)/g;
const NUMERIC = /(?<![\d/.\-:])(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})(?![\d/\-:]|\.\d)/g;
const SHORT = /(?<=\b(?:[Oo]n|[Bb]y|[Uu]ntil|[Tt]ill|[Ff]rom|[Ss]ince|[Bb]efore|[Aa]fter|[Tt]hrough|[Tt]hru|[Dd]ue|[Dd]ated|[Ss]tarting|[Ee]nding|[Ee]ffective|of|[Ee]xpires|[Ee]xpiring|[Dd]eadline)[:,]?\s)(\d{1,2})\/(\d{1,2})(?![\d/]|\.\d)/g;
// A month/day with no cue word ('Midterm 10/22 at 2pm', 'Mon 10/7', 'closed 12/24-12/26'):
// a date when a weekday comes right before it, or when its day is past 12 and is no usual
// fraction denominator (16, 20, 25) and no unit, counted noun, 'of' or 'scale' follows. A
// day of 12 or less with no weekday stays a fraction ('Answer: 3/4', '1/2-3/4 cup').
const BARE = /(?<![\w/.,:⁄$\-])(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)(\.?,?\s+))?(\d{1,2})\/(\d{1,2})(?![\d/]|[.,]\d)/g;
// the second date of a range whose first date was just read: '12/24-12/26'
const RANGE_TAIL = /(?<=(?:\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s[a-z]+(?:-[a-z]+)?(?:st|nd|rd|th)|\bof\s(?:January|February|March|April|May|June|July|August|September|October|November|December))\s?)[–\-]\s?(\d{1,2})\/(\d{1,2})(?![\d/]|[.,]\d)/g;
const BARE_NOT_AFTER = /^(?:\s*(?:[-–]\s*)?(?:of|scale|inch|inches|ft|foot|feet|yd|yard|mile|miles|cup|cups|teaspoons?|tablespoons?|tsp|tbsp|oz|ounces?|pounds?|lbs?|grams?|kg|mm|cm|km|ml|mph|odds|th|ths)\b|\s*%)/i;
const BARE_PLURAL = /^\s+([a-z]+s)\b/;
const BARE_SPECIAL = ['24/7', '22/7', '9/11', '7/11', '20/20', '50/50'];
const NOT_PLURAL = /^(?:is|was|has|as|its|this|his|us|thus|plus|yes|class|pass|less|across|always|perhaps|bus|campus|focus|news|series|status|address|access|process|business)$/;
const BARE_NOT_BEFORE = /\b(?:scored?|scoring|got|gets|rated?|earned|marks?|grade[sd]?|ratio|odds|approximately|about|roughly|nearly|almost)\s+$/i;
const MONTH_FIRST = new RegExp(`\\b${MON}\\s${DAY}(?:\\s?(?:[–\\-]|to)\\s?${DAY})?(?![\\d:])(?:(,?\\s)(\\d{4})(?!\\d))?`, 'g');
const DAY_FIRST = new RegExp(`(?<![\\w.,:/])(?:([Tt]he)\\s)?${DAY}(?:\\s?([–\\-]|to|and)\\s?(?:the\\s)?${DAY})?\\s(?:of\\s)?${MON}(?![a-z])(?:(,?\\s)(\\d{4})(?!\\d))?`, 'g');
const WEEKDAY = new RegExp(`\\b(Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)(?:\\.(?=,?\\s+(?:\\d|the\\b|at\\b|${MON}))|(?=,?\\s+\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}|,?\\s+${MON}\\s+\\d))`, 'g');
const MONTH_ABBR = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?(?=\s+\d{4}\b)|(?<=\b(?:in|by|since|until|from|of|early|late|mid|last|next|this|In|By|Since|Until|From)\s)(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\./g;

const WEEKDAY_AFTER = /(?<=\b(?:on|On|by|By|for|before|after|since|until|till|from|From|next|last|this|every|each|and|or|to|through|thru|due)\s)(Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)\.(?=\s|$|[,;:)])/g;
const DAYNAME ='(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)\\.?';
const MONTHNAME = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
// 'Mon–Fri' -> 'Monday to Friday', 'Jan-Mar' -> 'January to March'
const DAY_RANGE = new RegExp(`\\b${DAYNAME}\\s?(?:[–—-]|\\bto\\b|\\bthrough\\b|\\bthru\\b)\\s?${DAYNAME}(?![\\w-])`, 'g');
const MONTH_RANGE = new RegExp(`\\b${MONTHNAME}\\s?[–—-]\\s?${MONTHNAME}(?![\\w-])`, 'g');
const fullDay = (d) => WEEKDAYS[d] || d;

// [day, month index] of an 'a/b' month/day in the dialect's order, or null.
function monthDay(a, b, ctx) {
  const dayFirst = ctx.dateOrder ? ctx.dateOrder === 'DMY' : ctx.uk;
  let d;
  let mo;
  if (a > 12 && b <= 12) [d, mo] = [a, b];
  else if (b > 12 && a <= 12) [mo, d] = [a, b];
  else if (dayFirst) [d, mo] = [a, b];
  else [mo, d] = [a, b];
  return mo >= 1 && mo <= 12 && validDay(d, mo - 1) ? [d, mo - 1] : null;
}

function bareDate(m, s, ctx) {
  const [, wd, sep, A, B] = m;
  const a = +A;
  const b = +B;
  const md = monthDay(a, b, ctx);
  if (!md || BARE_SPECIAL.includes(A + '/' + B)) return null;
  const end = m.index + m[0].length;
  const after = s.slice(end, end + 24);
  if (!wd) {
    // only in the dialect's own order, with the day (the second field in the US) past 12 and
    // not 16, 20 or 25: '24/7' and '22/7' stay what they are
    const dayFirst = ctx.dateOrder ? ctx.dateOrder === 'DMY' : ctx.uk;
    const day = md[0];
    if (day !== (dayFirst ? a : b) || day < 13 || [16, 20, 25].includes(day)) return null;
    if (BARE_NOT_AFTER.test(after) || BARE_NOT_BEFORE.test(s.slice(Math.max(0, m.index - 16), m.index))) return null;
    const noun = BARE_PLURAL.exec(after);
    if (noun && !NOT_PLURAL.test(noun[1])) return null;
  }
  const date = sayDate(md[0], md[1], '', ctx, precededByThe(s, m.index));
  return wd ? fullDay(wd) + sep.replace('.', '') + date : date;
}

export function dateRules(t, ctx) {
  t.replace(DAY_RANGE, (m) => `${fullDay(m[1])} to ${fullDay(m[2])}`);
  if (/[A-Z][a-z]{2,8}\.?\s?[–—-]/.test(t.s)) t.replace(MONTH_RANGE, (m) => `${MONTHS[monthOf(m[1])]} to ${MONTHS[monthOf(m[2])]}`);
  // 'on Tues. in Room 4', 'by Mon.', 'Mon. or Wed.'
  if (/\b(?:Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\./.test(t.s)) t.replace(WEEKDAY_AFTER, (m, s) => WEEKDAYS[m[1]] + endDot(s, m.index + m[0].length));
  if (!/\d/.test(t.s)) {
    if (/\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\./.test(t.s)) t.replace(MONTH_ABBR, (m, s) => MONTHS[monthOf(m[1] || m[2])] + (m[2] ? endDot(s, m.index + m[0].length) : ''));
    return t;
  }
  t.replace(ISO, (m, s) => {
    const mo = +m[2] - 1;
    const d = +m[3];
    if (mo < 0 || mo > 11 || !validDay(d, mo)) return null;
    return sayDate(d, mo, m[1], ctx, precededByThe(s, m.index));
  });
  t.replace(NUMERIC, (m, s) => {
    if (m[2] !== '/' && m[4].length !== 4) return null;
    const a = +m[1];
    const b = +m[3];
    let d;
    let mo;
    const dayFirst = ctx.dateOrder ? ctx.dateOrder === 'DMY' : ctx.uk;
    if (a > 12 && b <= 12) [d, mo] = [a, b];
    else if (b > 12 && a <= 12) [mo, d] = [a, b];
    else if (dayFirst) [d, mo] = [a, b];
    else [mo, d] = [a, b];
    if (mo < 1 || mo > 12 || !validDay(d, mo - 1)) return null;
    return sayDate(d, mo - 1, fullYear(m[4]), ctx, precededByThe(s, m.index));
  });
  if (t.s.includes('/')) {
    t.replace(SHORT, (m, s) => {
      const a = +m[1];
      const b = +m[2];
      const by = /by\s$/i.test(s.slice(m.index - 3, m.index));
      // 'increased by 1/2' is a fraction; 'on 5/7 benchmarks' is a score
      if (by && a < b && [2, 3, 4, 8, 16].includes(b)) return null;
      if (a <= b && /^\s+(?:of\b|[a-z]+s\b)/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 20))) return null;
      const dayFirst = ctx.dateOrder ? ctx.dateOrder === 'DMY' : ctx.uk;
      let d;
      let mo;
      if (a > 12 && b <= 12) [d, mo] = [a, b];
      else if (b > 12 && a <= 12) [mo, d] = [a, b];
      else if (dayFirst) [d, mo] = [a, b];
      else [mo, d] = [a, b];
      if (mo < 1 || mo > 12 || !validDay(d, mo - 1)) return null;
      return sayDate(d, mo - 1, '', ctx, precededByThe(s, m.index));
    });
    if (/\d\/\d/.test(t.s)) {
      t.replace(BARE, (m, s) => bareDate(m, s, ctx));
      t.replace(RANGE_TAIL, (m) => {
        const md = monthDay(+m[1], +m[2], ctx);
        return md ? ' to ' + sayDate(md[0], md[1], '', ctx, false) : null;
      });
    }
  }
  t.replace(MONTH_FIRST, (m) => {
    const mo = monthOf(m[1]);
    const d1 = +m[2];
    const d2 = m[3] ? +m[3] : 0;
    if (!validDay(d1, mo) || (m[3] && (!validDay(d2, mo) || d2 <= d1))) return null;
    const the = ctx.uk ? 'the ' : '';
    let out = `${MONTHS[mo]} ${the}${ordinal(d1)}`;
    if (d2) out += ` to ${the}${ordinal(d2)}`;
    if (m[5]) out += (m[4].includes(',') ? ', ' : ' ') + year(m[5], ctx.uk);
    return out;
  });
  t.replace(DAY_FIRST, (m, s) => {
    const mo = monthOf(m[5]);
    const d1 = +m[2];
    const d2 = m[4] ? +m[4] : 0;
    if (!validDay(d1, mo) || (m[4] && (!validDay(d2, mo) || d2 <= d1))) return null;
    const the = m[1] || (precededByThe(s, m.index) ? '' : 'the');
    let out = (the ? the + ' ' : '') + ordinal(d1);
    if (d2) out += (m[3] === 'and' ? ' and the ' : ' to the ') + ordinal(d2);
    out += ' of ' + MONTHS[mo];
    if (m[7]) out += (m[6].includes(',') ? ', ' : ' ') + year(m[7], ctx.uk);
    else if (m[5].endsWith('.')) out += endDot(s, m.index + m[0].length);
    return out;
  });
  t.replace(WEEKDAY, (m) => WEEKDAYS[m[1]]);
  t.replace(MONTH_ABBR, (m, s) => MONTHS[monthOf(m[1] || m[2])] + (m[2] ? endDot(s, m.index + m[0].length) : ''));
  return t;
}

// ---------- times ----------

const TP = '([01]?\\d|2[0-3])(?:([:.])([0-5]\\d))?(?::([0-5]\\d))?(?:\\s?([AaPp])\\.?\\s?[Mm](\\.?)(?![a-z]))?';
const TIME_RANGE = new RegExp(`(?<![\\d:.,\\w])${TP}\\s?(?:[–\\-]|to)\\s?${TP}(?![\\d:]|\\.\\d)`, 'g');
// not the start of a map scale: '1:50,000'
const TIME = new RegExp(`(?<![\\d:.,\\w])${TP}(?![\\d:]|\\.\\d|,\\d{3}(?!\\d))`, 'g');

const DOT_BEFORE = /\b(?:at|At|the|The|from|From|until|Until|till|before|after|around|to)\s$/;
const DOT_AFTER = /^(?:\s*(?:$|[,;:!?)]|\.(?!\d))|\s+(?:to|from|train|service|bus|coach|flight|ferry|departure|arrival|sailing|on|tomorrow|today|tonight|this|every|each|until|till|sharp|start|kick-off|kickoff|meeting|appointment)\b)/;
const isTime = (sep, mm, ap) => (ap ? !mm || sep === ':' || sep === '.' : sep === ':' && !!mm);
const plural = (n, w) => `${cardinal(n)} ${w}${+n === 1 ? '' : 's'}`;

function sayTime(h, sep, mm, ss, ap) {
  const hour = +h;
  const apWord = ap ? (ap.toLowerCase() === 'a' ? ' A M' : ' P M') : '';
  if (ss && !ap) {
    const parts = [];
    if (hour) parts.push(plural(hour, 'hour'));
    parts.push(plural(+mm, 'minute'));
    return parts.join(' ') + ' and ' + plural(+ss, 'second');
  }
  let out = hour === 0 && !ap ? 'zero' : cardinal(hour);
  if (mm && +mm) out += ' ' + (+mm < 10 ? 'oh ' + cardinal(+mm) : under100(+mm));
  else if (!ap) out = hour === 0 ? 'midnight' : hour > 12 ? out + ' hundred' : out + " o'clock";
  if (ss) out += ' and ' + plural(+ss, 'second');
  return out + apWord;
}

export function timeRules(t) {
  if (!/\d/.test(t.s) || !/[:.]\d|\d\s?[AaPp]\.?\s?[Mm]/.test(t.s)) return t;
  t.replace(TIME_RANGE, (m, s) => {
    const a = m.slice(1, 7);
    const b = m.slice(7, 13);
    // '9-11am' and '7.15-8.30pm' borrow am/pm from the other side; '3-5' alone is a range
    const ok = (x, other) => isTime(x[1], x[2], x[4]) || (!!other[4] && (!x[1] || !!x[2]));
    if (!ok(a, b) || !ok(b, a)) return null;
    const end = m.index + m[0].length;
    const dot = (b[5] && endDotCap(s, end)) || '';
    return sayTime(a[0], a[1], a[2], a[3], a[4]) + ' to ' + sayTime(b[0], b[1], b[2], b[3], b[4]) + dot;
  });
  t.replace(TIME, (m, s) => {
    const [h, sep, mm, ss, ap, apDot] = m.slice(1, 7);
    // British '10.45' is a time only with a cue: 'the 10.45 to Brighton', 'at 7.30'
    const dotTime = sep === '.' && mm && !ap && !ss && DOT_BEFORE.test(s.slice(Math.max(0, m.index - 9), m.index)) && DOT_AFTER.test(s.slice(m.index + m[0].length, m.index + m[0].length + 14));
    if (!isTime(sep, mm, ap) && !dotTime) return null;
    const dot = (apDot && endDotCap(s, m.index + m[0].length)) || '';
    return sayTime(h, sep, mm, ss, ap) + dot;
  });
  return t;
}
