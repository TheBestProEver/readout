// findEntities(textOrLayout, { dialect, now, timeZone }) -> entities with source offsets.
//
// Three passes. (1) Atoms: linear regexes find dates, times, weekdays, zones, durations,
// recurrence words, links, emails, phones and places in an OCR-tolerant copy of the text
// (same length, so every offset is an offset into the original: '1O:3O' reads as '10:30').
// (2) Composition joins neighbours by what stands between them: 'Oct 21' + ', ' + '7pm' is a
// datetime, '3' + '-' + '4:30pm' a time range, 'every Tuesday' + 'until' + 'Dec 10' a bounded
// recurrence. Nothing joins across a line break. (3) Resolution turns what was written into
// ISO values with the whole document in view: numeric dates follow the order an unambiguous
// date in the same text shows (else the dialect's, flagged), year-less dates take the year of a
// nearby dated one (else the next one from `now`, keeping a chronological list in order), a
// weekday picks the year it is true in, relative dates count from `now` (or an email's Sent
// date), and times without am/pm are inferred from their partner, the words around them, or
// the hour.
//
// Entity = { type, start, end, text, value, confidence, ...extras }
//   date        value '2026-10-21'           (+ ambiguous, alternatives, relative, inferredYear)
//   time        value '19:00'                (+ inferred: am/pm guessed)
//   datetime    value '2026-10-21T19:00'
//   daterange   value { start, end }          dates, end inclusive
//   timerange   value { start, end }          times, or datetimes when a date is part of it
//                                             (+ days: { start, end } for daily hours over a date span)
//   weekday     value 'FR'                   (+ date: the next one)
//   duration    value 'PT1H30M'              (+ minutes, allDay)
//   timezone    value 'America/New_York' | 'UTC' | '+05:30'
//   recurrence  value { rrule, freq, interval, byDay, byMonthDay, until, count, start, time }
//   url | email | phone | location            value: the normalised text
// Temporal entities carry timeZone when the text names one ('3pm ET').

import { MONTH_INDEX } from '../../data/speech/abbreviations.js';
import { ABBREVIATIONS, PLACES, nowIn, defaultZone, offsetZone, isZone } from './tz.js';
import { DAY_CODES, validDate, isoDate, isoTime, parseIso, addDays, dayNumber, fromDayNumber, weekdayOf, nextWeekday, daysBetween, nthWeekdayOfMonth, daysIn } from './civil.js';

/* ---------- vocabulary ---------- */

const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const YEAR = "((?:19|20)\\d{2}|'\\d{2})";
const NUMW = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, 'forty five': 45, fortyfive: 45, sixty: 60, ninety: 90 };
const ORDINAL = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1, final: -1 };
const S = '[ \\t]';

const monthOf = (w) => MONTH_INDEX[String(w).slice(0, 3).toLowerCase()] + 1;
export function weekdayIndex(w) {
  const s = String(w).toLowerCase();
  if (s.startsWith('mo')) return 1;
  if (s.startsWith('tu')) return 2;
  if (s.startsWith('we')) return 3;
  if (s.startsWith('th')) return 4;
  if (s.startsWith('fr')) return 5;
  if (s.startsWith('sa')) return 6;
  if (s.startsWith('su')) return 0;
  return -1;
}
const numberOf = (w) => {
  if (w == null) return null;
  const s = String(w).toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return +s;
  if (/couple/.test(s)) return 2;
  if (/few/.test(s)) return 3;
  if (/^half/.test(s)) return 0.5;
  return NUMBERS[s] != null ? NUMBERS[s] : null;
};
const fullYear = (y) => (y[0] === "'" ? 2000 + +y.slice(1) : y.length === 2 ? 2000 + +y : +y);

/* ---------- the OCR-tolerant copy ---------- */

const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

// Same length as the input. Dashes and odd spaces are made plain; inside runs of digits,
// letters OCR mistakes for digits are read as digits ('1O:3O', 'l2/3', 'Oct 2l').
export function normalize(text) {
  let s = String(text).replace(DASHES, '-').replace(SPACES, ' ').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\uff1a/g, ':');
  s = s.replace(/(?<![A-Za-z])[0-9OolI|][0-9OolI|:./-]*[0-9OolI|](?![A-Za-z]{2})/g, (m) => {
    if (!/\d/.test(m) || !/[OolI|]/.test(m)) return m;
    const digits = m.replace(/[^0-9]/g, '').length;
    const confusable = m.replace(/[^OolI|]/g, '').length;
    if (confusable > digits) return m;
    return m.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
  });
  // a dash between times read as '=' or '~' ('6 PM = 9 PM'), or a lone '_' or '—'
  s = s.replace(/(\d(?:[ \t]?[AaPp]\.?[Mm]\.?)?[ \t]?)[=~_](?=[ \t]?\d)/g, '$1-');
  // a zero read for the O of a month: '0ct', 'N0v'
  s = s.replace(/\b0(?=ct(?:ober)?\b)/gi, 'O').replace(/\bN0(?=v)/g, 'No').replace(/\bn0(?=v)/g, 'no');
  return s;
}

/* ---------- atoms ---------- */

const R = {
  // (an offset only straight after the time and only with a 'T' or seconds: '22:00-23:30' is a range)
  iso: /\b((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:(T|[ \t]+)(\d{1,2}):(\d{2})(:\d{2})?(?:\.\d+)?(Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?)?(?![\d/])/dg,
  numeric: /(?<![\d/.:\-\w])(\d{1,2})([/.\-])(\d{1,2})\2((?:19|20)?\d{2})(?![\d/\-:]|\.\d)/dg,
  short: /(?<![\d/.:$£€\-\w])(\d{1,2})\/(\d{1,2})(?![\d/]|\.\d|[ \t]*(?:of|cups?|tsp|tbsp|inch|inches|in\b|miles?|lbs?|oz|kg|g\b|th\b|pts?|points?|stars?))/dg,
  md: new RegExp(`\\b(?:(${WD})\\.?,?${S}+(?:the${S}+)?)?(${MON})\\.?,?${S}*\\n?${S}*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:]|${S}*(?:[ap]\\.?m\\b|[ap]\\b|h\\b|hrs?\\b|hours?\\b|min))(?:${S}*(-|to|through|thru|until|till|&|and)${S}*(?:(${MON})\\.?${S}*)?(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:]|${S}*(?:[ap]\\.?m\\b|[ap]\\b|noon|midnight|h\\b|hrs?\\b|hours?\\b|min)))?(?:(,?${S}*)${YEAR}(?![\\d:]))?`, 'dgi'),
  dm: new RegExp(`\\b(?:(${WD})\\.?,?${S}+)?(?:the${S}+)?(\\d{1,2})(?:st|nd|rd|th)?(?:${S}*(-|to|through|thru|until|till|&|and)${S}*(?:the${S}+)?(\\d{1,2})(?:st|nd|rd|th)?)?(?:${S}+of)?${S}*(${MON})\\b\\.?(?:(,?${S}*)${YEAR}(?![\\d:]))?`, 'dgi'),
  monthYear: new RegExp(`\\b(${MON})\\.?,?${S}+((?:19|20)\\d{2})\\b`, 'dgi'),
  // a day of the month alone, after a weekday or a cue word ('Monday the 9th', 'on the 31st')
  ordDay: new RegExp(`\\b(?:(${WD})\\.?,?${S}+)?(?:(on|by|until|till|before|after|from|through|thru|starting|this|next|is|for)${S}+)?the${S}+(\\d{1,2})(?:st|nd|rd|th)\\b(?!${S}*(?:-|to|&|and)${S}*(?:the${S}+)?\\d)(?!${S}+(?:of\\b|floor|century|time|grade|anniversary|round|place|edition|annual|year|birthday|street|st\\b|ave|avenue|amendment|quarter|period|inning|row|seat|level|percentile|hole|lap|day|week|month|hour|minute|draft|pick|overall|largest|biggest|best|most|person|caller|visitor|customer|edition|ward|district|precinct|division|class|tee|green|degree|generation|wheel|reich|dynasty|batch|chair|violin|book|chapter|verse|page|step|stage|leg|heat|game|set|try|attempt))`, 'dgi'),
  // holidays that name a day, after a cue word; a weekday may follow ("Halloween, that's Saturday")
  holiday: new RegExp(`\\b(on|this|next|until|till|by|before|after|from|starting)${S}+(?:the${S}+)?(new${S}+year'?s${S}+eve|new${S}+year'?s(?:${S}+day)?|christmas${S}+eve|christmas(?:${S}+day)?|boxing${S}+day|hallowe'?en|valentine'?s(?:${S}+day)?|st\\.?${S}+patrick'?s(?:${S}+day)?|independence${S}+day|(?:the${S}+)?fourth${S}+of${S}+july|juneteenth|veterans'?${S}+day|thanksgiving(?:${S}+day)?|labou?r${S}+day|memorial${S}+day|mlk${S}+day|martin${S}+luther${S}+king(?:${S}+jr\\.?)?${S}+day|presidents'?${S}+day|mother'?s${S}+day|father'?s${S}+day|bonfire${S}+night|guy${S}+fawkes${S}+night|easter(?:${S}+sunday)?|good${S}+friday)(?!${S}+(?:week|weekend|break|holidays?|vacation|recess|season|eve\\b|party|parties|dinner|lunch|feast|parade|sale|service|market|concert|show))(?:,?${S}+(?:that'?s|that${S}+is|which${S}+is|i\\.e\\.)${S}+(${WD})\\b\\.?|${S}*\\((${WD})\\.?\\))?`, 'dgi'),
  season: /\b(spring|summer|fall|autumn|winter)[ \t]+(?:(?:semester|term|quarter|session)[ \t]+)?((?:19|20)\d{2})\b/dgi,
  weekday: new RegExp(`\\b(?:(this|next|coming|this${S}+coming|last|following|on)${S}+)?(${WD})(s)?\\b(\\.)?(?:${S}+(next${S}+week|this${S}+week|after${S}+next|week${S}+after${S}+next))?`, 'dgi'),
  wdList: new RegExp(`\\b(${WD})(s)?\\.?(?:${S}*(?:,${S}*(?:and${S}+|&${S}*)?|/|&|\\+|and${S})${S}*(${WD})(s)?\\b\\.?)+`, 'dgi'),
  wdRange: new RegExp(`\\b(${WD})(s)?\\.?${S}*(?:-|to|through|thru|till|until)${S}*(${WD})(s)?\\b\\.?`, 'dgi'),
  mf: /(?<![\w/])M[ \t]?-[ \t]?F(?![\w/])/dg,
  codes: /(?<![\w/&])((?:M|Tu|T|W|Th|R|F|Sa|Su|S|U){2,7})(?![\w/&])/dg,
  codesSep: /(?<![\w/])((?:M|Tu|T|W|Th|R|F|Sa|Su)(?:[ \t]?[/,&][ \t]?(?:M|Tu|T|W|Th|R|F|Sa|Su)){1,6})(?![\w/])/dg,
  relday: /\b(today|tonight|tonite|tomorrow|tomorow|tommorow|tmrw|tmrrw|tmr|2morrow|yesterday|(?:the[ \t]+)?day[ \t]+after[ \t]+tomorrow|this[ \t]+(?:morning|afternoon|evening))\b(?:[ \t]+(morning|afternoon|evening|night))?/dgi,
  relspan: /\b(this(?:[ \t]+coming)?|next|the[ \t]+following|coming)[ \t]+(weekend|week|month)\b/dgi,
  inN: new RegExp(`\\b(?:in|within)${S}+(\\d{1,2}|an?|${NUMW}|a${S}+couple${S}+of|a${S}+few)${S}+(days?|weeks?|months?|fortnight)(?:${S}+time)?\\b`, 'dgi'),
  fromN: new RegExp(`\\b(\\d{1,2}|an?|${NUMW})${S}+(days?|weeks?)${S}+from${S}+(today|now|tomorrow)\\b|\\ba${S}+(week|fortnight)${S}+(today|tomorrow)\\b`, 'dgi'),
  timeMer: /(?<![\w:.$£€/])(\d{1,2})(?:[ \t]?[:.][ \t]?([0-5]\d))?(?::[0-5]\d)?[ \t]?(a\.?[ \t]?m\.?|p\.?[ \t]?m\.?)(?![a-z])/dgi,
  timeAp: /(?<![\w:.$£€/])(\d{1,2})(?::([0-5]\d))?([ap])(?![a-z.]|\.[a-z])/dgi,
  time24: /(?<![\w:.$£€/])([01]?\d|2[0-3])[ \t]?:[ \t]?([0-5]\d)(?![\d:]|[ \t]?[ap]\.?m)(?:[ \t]?(?:h|hrs|hours)\b)?/dgi,
  timeH: /\b([01]?\d|2[0-3])h([0-5]\d)\b|\b([01]\d|2[0-3])([0-5]\d)[ \t]?(?:h|hrs|hours)\b/dgi,
  timeDot: /\b(?:at|from|until|till|til|doors|starts?|begins?|kick-?off|by|before|after)[ \t]+(\d{1,2})\.([0-5]\d)(?![\d.]|[ \t]?[ap]\.?m)/dgi,
  noon: /\b(?:12[ \t]?)?(noon|midday|mid-day|midnight)\b/dgi,
  oclock: new RegExp(`\\b(\\d{1,2}|${NUMW})${S}?o'?${S}?clock\\b`, 'dgi'),
  wordTime: new RegExp(`\\b(half|quarter)${S}+(past|to|after)${S}+(\\d{1,2}|${NUMW})\\b`, 'dgi'),
  cued: /(?<![\w@])(at|@|from|by|around|about|after|before|starts?|starting|begins?|doors(?:[ \t]+open)?|kick-?off|meet(?:[ \t]+(?:at|up))?|arrive(?:[ \t]+by)?|call[ \t]+time)[ \t]*(\d{1,2})(?:[ \t]?-?ish)?(?=[ \t]*(?:$|[,.;!?()]|(?:tonight|tomorrow|today|this|on|sharp|and|or|so|then|ok|okay|for|pls|please|works?|is)\b)|(?<=(?<![\w@])(?:at|@)[ \t]*\d{1,2}(?:[ \t]?-?ish)?)[ \t]*(?:@|(?:at|with|near|outside|in(?=[ \t]+(?:the|room|rm|my|our|your|front)\b))\b))/dgim,
  ish: /(?<![\w:.])(\d{1,2})(?::([0-5]\d))?[ \t]?-?ish\b/dgi,
  numrange: /(?<![\w:.$£€/-])(\d{1,2})(?:[:.]([0-5]\d))?[ \t]*(-|to|until|till|til)[ \t]*(\d{1,2})(?:[:.]([0-5]\d))?(?![\w:/]|[.,]\d|[ \t]?[ap]\.?m)/dgi,
  endword: /\b(late|close|closing|sundown|sunset|dark|dusk|finish|end)\b/dgi,
  tzAbbr: /(?<![\w-])(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|AKST|AKDT|HST|HAST|AST|ADT|NST|NDT|GMT|UTC|UT|BST|WET|WEST|CET|CEST|EET|EEST|MSK|IST|PKT|SGT|HKT|JST|KST|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|SAST|WAT|EAT|GST|ICT|BRT|Z)(?:(?<=UTC|GMT|UT)[ \t]?([+-])[ \t]?(\d{1,2})(?::?([0-5]\d))?)?(?![\w])/dg,
  tzName: /\b(eastern|central|mountain|pacific|atlantic|alaska|hawaii(?:an)?)(?:[ \t]+(standard|daylight|summer))?(?:[ \t]+(time))?\b/dgi,
  tzLong: /\b(greenwich[ \t]+mean[ \t]+time|british[ \t]+summer[ \t]+time|coordinated[ \t]+universal[ \t]+time|central[ \t]+european(?:[ \t]+summer)?[ \t]+time|eastern[ \t]+european(?:[ \t]+summer)?[ \t]+time|indian[ \t]+standard[ \t]+time|japan[ \t]+standard[ \t]+time|australian[ \t]+eastern(?:[ \t]+(?:standard|daylight))?[ \t]+time)\b/dgi,
  duration: new RegExp(`\\b(\\d+(?:\\.\\d+)?|an?|${NUMW}|fifteen|twenty|thirty|forty-?${S}?five|forty|sixty|ninety|half${S}+an?)${S}*-?${S}*(hours?|hrs?|hr|h|minutes?|mins?|min)\\b(?:${S}*(?:and${S}+)?(?:(\\d{1,2})${S}*-?${S}*(minutes?|mins?|min|m)\\b|(a${S}+half)))?`, 'dgi'),
  allDay: /\b(all[ \t-]day|full[ \t-]day|whole[ \t]day|all[ \t]weekend)\b/dgi,
  every: new RegExp(`\\b(every|each)${S}+(?:(other|second|alternate|2nd|third|3rd)${S}+)?(?:(\\d{1,2}|two|three|four|six)${S}+)?(days?|week${S}?days?|weekends?|weeks|week|fortnight|months?|years?|mornings?|evenings?|nights?|${WD}s?(?:${S}*(?:,|/|&|and|,${S}*and)${S}*${WD}s?)*)\\b`, 'dgi'),
  adverb: /\b(daily|weekly|bi-?weekly|fortnightly|monthly|bi-?monthly|quarterly|yearly|annually|weeknights|weekdays|nightly)\b/dgi,
  nth: new RegExp(`\\b(?:(?:every|each|on${S}+the|the)${S}+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)${S}+(${WD})s?(?:${S}+(?:of|in)${S}+(?:the|each|every)${S}+month\\b|(?=${S}+(?:of${S}+)?(?:the${S}+|each${S}+|every${S}+)?month))`, 'dgi'),
  everyNth: new RegExp(`\\b(?:every|each)${S}+(first|1st|second|2nd|third|3rd|fourth|4th|last)${S}+(${WD})\\b`, 'dgi'),
  monthDay: /\b(?:on[ \t]+)?the[ \t]+(\d{1,2})(?:st|nd|rd|th)[ \t]+of[ \t]+(?:every|each|the)[ \t]+month\b|\b(?:every|each)[ \t]+month[ \t]+on[ \t]+the[ \t]+(\d{1,2})(?:st|nd|rd|th)?\b|\bmonthly[ \t]+on[ \t]+the[ \t]+(\d{1,2})(?:st|nd|rd|th)?\b/dgi,
  count: new RegExp(`\\bfor${S}+(\\d{1,2}|${NUMW}|fifteen|sixteen)${S}+(?:consecutive${S}+)?(weeks|sessions|classes|meetings|times|months|days|occurrences|lessons|weekends|${WD}s)\\b|\\b(\\d{1,2}|${NUMW})-(week|session|day)${S}+(?:course|class|program|programme|series|workshop)\\b`, 'dgi'),
  url: /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co|uk|us|ca|info|events?|app|ly|gl|me|tv|live|zoom\.us)\/[^\s<>"'()[\]]*/dgi,
  email: /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}\b/dg,
  phone: /(?<![\w+/.-])(?:\+\d{1,3}[ \t.-]?)?(?:\(\d{2,5}\)|\d{2,5})(?:[ \t.-]?\d{2,5}){1,3}(?![\w/-]|\.\d)/dg,
  address: /\b\d{1,5}(?:-\d{1,5})?[ \t]+(?:[NSEW]\.?[ \t]+)?(?:[A-Z0-9][\w'.-]*[ \t]+){0,4}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Place|Pl|Court|Ct|Square|Sq|Parkway|Pkwy|Highway|Hwy|Terrace|Close|Crescent|Row|Circle|Cir|Plaza|Broadway|Walk|Mews|Gardens|STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|LANE|LN|DRIVE|DR|WAY|PLACE|PL|COURT|CT|PARKWAY|PKWY|HIGHWAY|HWY|TERRACE)\b\.?(?:,?[ \t]+(?:Suite|Ste\.?|Apt\.?|Unit|Room|Rm\.?|Floor|Fl\.?|#)[ \t]*[\w-]+)?(?:,[ \t]*[A-Z][a-z][A-Za-z.'-]*(?:(?<![a-z]{3}\.)[ \t]+[A-Z][a-z][A-Za-z.'-]*){0,3}){0,2}(?:(?<![a-z]{3}\.),?[ \t]+[A-Z]{2}\.?(?:[ \t]+\d{5}(?:-\d{4})?)?\b|,?[ \t]+[A-Z]{1,2}\d[A-Z\d]?[ \t]?\d[A-Z]{2}\b)?/dg,
  room: /\b(?:(?:Room|Rm\.?|Suite|Ste\.?|Studio|Lab|Gate|Terminal|Platform|Hall|Building|Bldg\.?|Auditorium|Classroom|Conference[ ]{1,2}Room|Lecture[ ]{1,2}Hall|Theatre|Theater|Stage|Court|Field)[ ]{1,2}[A-Z0-9][\w.-]{0,8}\b|(?:[A-Z][\w'&.-]*[ ]{1,2}){1,4}(?:Hall|Center|Centre|Auditorium|Theater|Theatre|Library|Pavilion|Arena|Stadium|Park|Gallery|Museum|Ballroom|Lounge|Building|Church|Chapel|Club|Cafe|Café|Bar|Pub|Tavern|Hotel|Inn|Gardens|Commons|Plaza|Field|Gym|Studio|Room|Clinic|Hospital|Library|Market|Square|School|Academy|College|University|Institute|Bistro|Kitchen|Brewery|Garden|Grill|Restaurant|House|Cinema)(?:[ ]{1,2}(?:(?:Room|Rm\.?|Suite)[ ]{0,2})?(?:\d[\w.-]{0,5}|[A-Z]\b))?\b)/dg,
  // street corners: '57th & Kenwood', 'State St and Madison'
  corner: /\b(?:\d{1,3}(?:st|nd|rd|th)(?:[ \t]+(?:St|Street|Ave|Avenue|Pl|Place))?|[A-Z][a-z]+[ \t]+(?:St|Street|Ave|Avenue|Blvd|Rd|Road|Dr|Drive)\.?)[ \t]*(?:&|and|at|\/)[ \t]*(?:\d{1,3}(?:st|nd|rd|th)|[A-Z][a-z]+)(?:[ \t]+(?:St|Street|Ave|Avenue|Blvd|Rd|Road|Dr|Drive|Pl|Place)\b\.?)?/dg,
  label: /^[ \t]*(where|location|venue|place|address|room|loc|meeting[ \t]+point)[ \t]*[:\-][ \t]*(\S[^\n]*)$/dgim,
  emailHeader: /^[ \t]*(?:sent|date)[ \t]*:[ \t]*(\S[^\n]*)$/dgim,
};

const RANGE_GAP = /^[ \t]*(?:-{1,2}|~|to|until|till|til|thru|through|and)[ \t]*$/i;
const DT_GAP = /^[ \t]*(?:,|;|\||·|•|\/|-|@|at|from|on)?[ \t]*(?:,|at|@|from|starting(?:[ \t]+at)?|starts(?:[ \t]+at)?|begins(?:[ \t]+at)?|beginning(?:[ \t]+at)?|between)?[ \t]*(?:at|@)?[ \t]*$/i;
const TD_GAP = /^[ \t]*(?:,|-|on|\||·|•|\/)?[ \t]*(?:on|this|,)?[ \t]*$/i;
const TAB_GAP = /^[ \t]*\t[ \t]*$/;
const UNTIL_GAP = /^[ \t]*[,;(]?[ \t]*(?:until|till|til|untill|through|thru|to|ending(?:[ \t]+on)?|ends(?:[ \t]+on)?|up[ \t]+to|-|last[ \t]+(?:class|session|meeting)(?:[ \t]+on)?)[ \t]*(?:on|the)?[ \t]*$/i;
const FROM_GAP = /^[ \t]*[,;(]?[ \t]*(?:starting|beginning|from|commencing|effective|as[ \t]+of|begins|starts|first[ \t]+(?:class|session|meeting))[ \t]*(?:on|from)?[ \t]*$/i;

function scanAll(re, s, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    fn(m);
  }
}

const span = (m, g) => (m.indices && m.indices[g] ? m.indices[g] : null);

function dateSpec(m, d, y, extra) {
  return Object.assign({ m, d, y: y == null ? null : y, yearGiven: y != null, wd: -1 }, extra);
}

// The atoms of a text. Each: { k, s, e, v, c, p } (kind, span, value, confidence, priority).
function atoms(text, norm, ctx) {
  const out = [];
  const add = (k, s, e, v, c, p = 5, core = null) => {
    if (e > s) out.push({ k, s, e, v, c, p, core });
  };
  const capital = (s) => /^[A-Z]/.test(s);
  const lowerAmbiguousMonth = (w) => /^(?:may|mar|march)$/.test(w) && w === w.toLowerCase();

  scanAll(R.iso, norm, (m) => {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (!validDate(y, mo, d)) return;
    const date = dateSpec(mo, d, y, { iso: true });
    if (m[5] != null) {
      const time = { h: +m[5], mi: +m[6], mer: null, h24: true };
      let end = m.index + m[0].length;
      let zone = null;
      if (m[8]) {
        if (m[8] === 'Z' || m[4] === 'T' || m[7]) zone = zoneFromOffset(m[8]);
        else end = span(m, 8)[0]; // '22:00-23:30': the time ends here, a range follows
      }
      add('datetime', m.index, end, { date, time, zone }, 0.98, 9);
    } else add('date', m.index, m.index + m[0].length, { date }, 0.98, 9);
  });
  scanAll(R.numeric, norm, (m) => {
    const a = +m[1];
    const b = +m[3];
    const sep = m[2];
    if (sep !== '/' && m[4].length !== 4 && sep === '-') return; // '10-21-26' is too often not a date
    const y = fullYear(m[4]);
    const nd = numericDate(a, b, y, sep, ctx);
    if (nd) add('date', m.index, m.index + m[0].length, { date: nd }, nd.order ? 0.92 : 0.7, 8);
  });
  scanAll(R.short, norm, (m) => {
    const a = +m[1];
    const b = +m[2];
    const nd = numericDate(a, b, null, '/', ctx);
    if (nd) add('date', m.index, m.index + m[0].length, { date: nd, short: true }, 0.6, 4);
  });
  scanAll(R.md, norm, (m) => {
    const w = m[2];
    if (lowerAmbiguousMonth(w)) return;
    const mo = monthOf(w);
    const d1 = +m[3];
    const y = m[8] ? fullYear(m[8]) : null;
    const wd = m[1] ? weekdayIndex(m[1]) : -1;
    const crossLine = /\n/.test(m[0].slice(span(m, 2)[1] - m.index, span(m, 3)[0] - m.index));
    const c = crossLine ? 0.75 : 0.96;
    const core = m[1] ? span(m, 2)[0] : null;
    if (m[6]) {
      const mo2 = m[5] ? monthOf(m[5]) : mo;
      const d2 = +m[6];
      const sep = m[4].toLowerCase();
      const valid = validDate(2024, mo, d1) && validDate(2024, mo2, d2) && (mo2 !== mo || d2 > d1);
      if (valid && (sep !== '&' && sep !== 'and' ? true : d2 === d1 + 1 && mo2 === mo)) {
        add('daterange', m.index, m.index + m[0].length, { date: dateSpec(mo, d1, y, { wd, fromRange: mo2 < mo }), endDate: dateSpec(mo2, d2, y) }, c, 8, core);
        return;
      }
      if (valid && (sep === '&' || sep === 'and')) {
        // two separate days: 'Oct 21 & 28'
        add('date', m.index, span(m, 3)[1], { date: dateSpec(mo, d1, y, { wd }) }, c, 8, core);
        add('date', span(m, 6)[0], m.index + m[0].length, { date: dateSpec(mo2, d2, y) }, c, 8);
        return;
      }
      // not a range after all: the date alone
      if (validDate(2024, mo, d1)) add('date', m.index, span(m, 3)[1], { date: dateSpec(mo, d1, null, { wd }) }, c, 8, core);
      return;
    }
    if (!validDate(y || 2024, mo, d1)) return;
    add('date', m.index, m.index + m[0].length, { date: dateSpec(mo, d1, y, { wd }) }, c, 8, core);
  });
  scanAll(R.dm, norm, (m) => {
    const w = m[5];
    if (lowerAmbiguousMonth(w)) return;
    const mo = monthOf(w);
    const d1 = +m[2];
    const y = m[7] ? fullYear(m[7]) : null;
    const wd = m[1] ? weekdayIndex(m[1]) : -1;
    const core = m[1] ? span(m, 2)[0] - (norm.slice(span(m, 1)[1], span(m, 2)[0]).match(/the[ \t]+$/i) || [""])[0].length : null;
    if (m[4]) {
      const d2 = +m[4];
      const sep = m[3].toLowerCase();
      if (!validDate(2024, mo, d2) || d2 <= d1) return;
      if (sep === '&' || sep === 'and') {
        if (d2 === d1 + 1) add('daterange', m.index, m.index + m[0].length, { date: dateSpec(mo, d1, y, { wd }), endDate: dateSpec(mo, d2, y) }, 0.9, 8, core);
        else {
          add('date', m.index, span(m, 2)[1], { date: dateSpec(mo, d1, y, { wd }) }, 0.85, 8, core);
          add('date', span(m, 4)[0], m.index + m[0].length, { date: dateSpec(mo, d2, y) }, 0.9, 8);
        }
        return;
      }
      add('daterange', m.index, m.index + m[0].length, { date: dateSpec(mo, d1, y, { wd }), endDate: dateSpec(mo, d2, y) }, 0.95, 8, core);
      return;
    }
    if (!validDate(y || 2024, mo, d1)) return;
    add('date', m.index, m.index + m[0].length, { date: dateSpec(mo, d1, y, { wd }) }, 0.95, 8, core);
  });
  // 'on the 31st', 'Monday the 9th': the next such day (in a month where it is that weekday)
  scanAll(R.ordDay, norm, (m) => {
    const wd = m[1] ? weekdayIndex(m[1]) : -1;
    if (wd < 0 && !m[2]) return;
    const n = +m[3];
    if (n < 1 || n > 31) return;
    const date = nextDayOfMonth(n, wd, ctx);
    if (date) add('date', m[2] && wd < 0 ? span(m, 3)[0] - (norm.slice(span(m, 2)[1], span(m, 3)[0]).match(/the[ \t]+$/i) || [''])[0].length : m.index, m.index + m[0].length, { date }, wd >= 0 ? 0.85 : 0.7, 8);
  });
  // 'on Halloween', 'this Thanksgiving', 'Halloween, that's Saturday'
  scanAll(R.holiday, norm, (m) => {
    const date = holidayDate(m[2], ctx);
    if (!date) return;
    const said = m[3] || m[4];
    if (said) {
      const wd = weekdayIndex(said);
      date.wd = wd;
      if (weekdayOf(date.y, date.m, date.d) !== wd) date.weekdayMismatch = true;
    }
    add('date', span(m, 2)[0], m.index + m[0].length, { date, holiday: true }, said ? 0.85 : 0.75, 8);
  });
  scanAll(R.monthYear, norm, (m) => add('month', m.index, m.index + m[0].length, { m: monthOf(m[1]), y: +m[2] }, 0.5, 2));
  scanAll(R.season, norm, (m) => {
    const mo = { spring: 3, summer: 7, fall: 10, autumn: 10, winter: 1 }[m[1].toLowerCase()];
    add('month', m.index, m.index + m[0].length, { m: mo, y: +m[2], season: true }, 0.5, 2);
  });

  // weekdays
  scanAll(R.wdRange, norm, (m) => {
    const a = weekdayIndex(m[1]);
    const b = weekdayIndex(m[3]);
    if (a < 0 || b < 0 || a === b) return;
    if (/^[a-z]{3}$/.test(m[1]) || /^[a-z]{3}$/.test(m[3])) return;
    add('wdrange', m.index, m.index + m[0].length, { from: a, to: b, plural: !!(m[2] || m[4]) }, 0.85, 6);
  });
  scanAll(R.mf, text, (m) => add('wdrange', m.index, m.index + m[0].length, { from: 1, to: 5 }, 0.8, 6));
  scanAll(R.wdList, norm, (m) => {
    const days = [];
    const re = new RegExp(WD + '(s)?', 'gi');
    let x;
    let plural = false;
    const body = m[0];
    while ((x = re.exec(body))) {
      const i = weekdayIndex(x[0]);
      if (i >= 0 && !days.includes(i)) days.push(i);
      if (x[1]) plural = true;
    }
    if (days.length < 2) return;
    if (/\bor\b/i.test(body)) return;
    add('wdset', m.index, m.index + m[0].length, { days, plural }, plural ? 0.85 : 0.7, 6);
  });
  for (const re of [R.codes, R.codesSep]) {
    scanAll(re, text, (m) => {
      const days = dayCodes(m[1]);
      if (!days) return;
      add('wdset', m.index, m.index + m[0].length, { days, codes: true, weak: true }, 0.75, 6);
    });
  }
  scanAll(R.weekday, norm, (m) => {
    const w = m[2];
    const i = weekdayIndex(w);
    if (i < 0) return;
    const prefix = m[1] ? m[1].toLowerCase().replace(/\s+/g, ' ') : null;
    const suffix = m[5] ? m[5].toLowerCase().replace(/\s+/g, ' ') : null;
    // 'sat', 'sun', 'wed', 'mon' in lower case are words, unless something says they are days
    const weak = /^(?:sat|sun|wed|mon|tue|thu|fri)$/i.test(w) && !capital(w) && !prefix;
    const plural = !!m[3] && !/^(?:tues|thurs|weds)$/i.test(w + m[3]) && w.length > 3;
    if (m[3] && !plural && /^(?:tue|thur|wed)$/i.test(w)) {
      // 'Tues', 'Thurs', 'Weds' are single days
    }
    const start = prefix === 'on' ? span(m, 2)[0] : m.index;
    add('weekday', start, m.index + m[0].length, { wd: i, prefix: prefix === 'on' ? null : prefix, suffix, plural, weak, onPrefix: prefix === 'on' }, weak ? 0.4 : 0.8, 5);
  });

  // relative days
  scanAll(R.relday, norm, (m) => {
    const w = m[1].toLowerCase().replace(/\s+/g, ' ');
    let days = 0;
    let part = m[2] ? m[2].toLowerCase() : null;
    if (/^(?:tomorrow|tomorow|tommorow|tmrw|tmrrw|tmr|2morrow)$/.test(w)) days = 1;
    else if (w === 'yesterday') days = -1;
    else if (/day after tomorrow/.test(w)) days = 2;
    else if (/^(?:tonight|tonite)$/.test(w)) part = 'night';
    else if (/^this /.test(w)) part = w.slice(5);
    add('relday', m.index, m.index + m[0].length, { days, part }, 0.9, 7);
  });
  scanAll(R.relspan, norm, (m) => add('relspan', m.index, m.index + m[0].length, { which: /next|following/i.test(m[1]) ? 'next' : 'this', unit: m[2].toLowerCase() }, 0.75, 6));
  scanAll(R.inN, norm, (m) => {
    const n = numberOf(m[1]);
    if (n == null) return;
    const unit = m[2].toLowerCase();
    add('relday', m.index, m.index + m[0].length, { days: unit.startsWith('fortnight') ? 14 : unit.startsWith('week') ? n * 7 : unit.startsWith('month') ? null : n, months: unit.startsWith('month') ? n : 0 }, 0.8, 6);
  });
  scanAll(R.fromN, norm, (m) => {
    if (m[4]) {
      const days = (m[4].toLowerCase() === 'fortnight' ? 14 : 7) + (m[5].toLowerCase() === 'tomorrow' ? 1 : 0);
      return add('relday', m.index, m.index + m[0].length, { days }, 0.8, 6);
    }
    const n = numberOf(m[1]);
    if (n == null) return;
    const days = (m[2].toLowerCase().startsWith('week') ? 7 * n : n) + (m[3].toLowerCase() === 'tomorrow' ? 1 : 0);
    add('relday', m.index, m.index + m[0].length, { days }, 0.8, 6);
  });

  // times
  scanAll(R.timeMer, norm, (m) => {
    const h = +m[1];
    if (h < 1 || h > 12) {
      if (h === 0 || h > 12) return;
    }
    add('time', m.index, m.index + m[0].length, { h, mi: m[2] ? +m[2] : 0, mer: /^a/i.test(m[3]) ? 'am' : 'pm' }, 0.96, 8);
  });
  scanAll(R.timeAp, norm, (m) => {
    const h = +m[1];
    if (h < 1 || h > 12) return;
    add('time', m.index, m.index + m[0].length, { h, mi: m[2] ? +m[2] : 0, mer: /^a/i.test(m[3]) ? 'am' : 'pm', weak: !m[2] }, m[2] ? 0.8 : 0.55, 6);
  });
  scanAll(R.time24, norm, (m) => {
    const h = +m[1];
    const mi = +m[2];
    const h24 = h >= 13 || h === 0 || /^0\d/.test(m[1]);
    add('time', m.index, m.index + m[0].length, { h, mi, mer: null, h24 }, h24 ? 0.92 : 0.85, 7);
  });
  scanAll(R.timeH, norm, (m) => {
    const h = +(m[1] || m[3]);
    const mi = +(m[2] || m[4] || 0);
    add('time', m.index, m.index + m[0].length, { h, mi, mer: null, h24: true }, 0.85, 7);
  });
  scanAll(R.timeDot, norm, (m) => {
    const st = span(m, 1)[0];
    add('time', st, m.index + m[0].length, { h: +m[1], mi: +m[2], mer: null, h24: +m[1] >= 13 }, 0.75, 7);
  });
  scanAll(R.noon, norm, (m) => {
    const w = m[1].toLowerCase();
    // 'The Midnight Owls', 'High Noon Saloon': a name, not a time
    if (/^[A-Z]/.test(m[1]) && !/^12/.test(m[0]) && (/^[ \t]+[A-Z]/.test(norm.slice(m.index + m[0].length, m.index + m[0].length + 3)) || /\b(?:the|a|high|after)[ \t]+$/i.test(norm.slice(Math.max(0, m.index - 6), m.index)))) return;
    add('time', m.index, m.index + m[0].length, { h: w === 'midnight' ? 0 : 12, mi: 0, mer: w === 'midnight' ? 'am' : 'pm', word: w === 'midnight' ? 'midnight' : 'noon' }, 0.95, 8);
  });
  scanAll(R.oclock, norm, (m) => {
    const h = numberOf(m[1]);
    if (!h || h > 12) return;
    add('time', m.index, m.index + m[0].length, { h, mi: 0, mer: null }, 0.85, 7);
  });
  scanAll(R.wordTime, norm, (m) => {
    let h = numberOf(m[3]);
    if (!h || h > 12) return;
    const q = m[1].toLowerCase() === 'half' ? 30 : 15;
    let mi = q;
    if (/^to$/i.test(m[2])) {
      if (q === 30) return;
      h = h === 1 ? 12 : h - 1;
      mi = 45;
    }
    add('time', m.index, m.index + m[0].length, { h, mi, mer: null }, 0.8, 7);
  });
  scanAll(R.cued, norm, (m) => {
    const h = +m[2];
    if (h < 1 || h > 12) return;
    const st = span(m, 2)[0];
    add('time', st, m.index + m[0].length, { h, mi: 0, mer: null, bare: true }, 0.6, 3);
  });
  scanAll(R.ish, norm, (m) => {
    const h = +m[1];
    if (h < 1 || h > 12) return;
    add('time', m.index, m.index + m[0].length, { h, mi: m[2] ? +m[2] : 0, mer: null, approx: true }, 0.6, 4);
  });
  scanAll(R.numrange, norm, (m) => {
    const h1 = +m[1];
    const h2 = +m[4];
    if (h1 > 23 || h2 > 23) return;
    const colon = m[2] != null || m[5] != null;
    if (!colon && (h1 > 12 || h2 > 12 || h1 === 0 || h2 === 0)) return;
    add('numrange', m.index, m.index + m[0].length, { from: { h: h1, mi: m[2] ? +m[2] : 0, mer: null, h24: h1 >= 13 }, to: { h: h2, mi: m[5] ? +m[5] : 0, mer: null, h24: h2 >= 13 }, colon }, colon ? 0.8 : 0.5, 4);
  });
  scanAll(R.endword, norm, (m) => add('endword', m.index, m.index + m[0].length, { word: m[1].toLowerCase() }, 0.5, 1));

  // zones
  scanAll(R.tzAbbr, text, (m) => {
    let zone = ABBREVIATIONS[m[1]];
    if (m[2] && (m[1] === 'UTC' || m[1] === 'GMT' || m[1] === 'UT')) {
      const mins = (m[2] === '-' ? -1 : 1) * (+m[3] * 60 + (m[4] ? +m[4] : 0));
      if (Math.abs(mins) > 14 * 60) return;
      zone = offsetZone(mins);
    } else if (m[2]) return;
    if (m[1] === 'Z') {
      if (!/\d$/.test(norm.slice(Math.max(0, m.index - 1), m.index))) return;
    }
    const weak = /^(?:CT|MT|PT|ET|AST|IST|GST|BST|EAT|ART|ICT|WAT|UT|Z)$/.test(m[1]);
    add('tz', m.index, m.index + m[0].length, { zone, abbr: m[1], weak }, weak ? 0.6 : 0.9, 6);
  });
  scanAll(R.tzName, norm, (m) => {
    const zone = ABBREVIATIONS[m[1].toUpperCase().replace(/AN$/, '')] || PLACES[m[1].toLowerCase()];
    if (!zone) return;
    add('tz', m.index, m.index + m[0].length, { zone, weak: !m[3] }, m[3] ? 0.9 : 0.55, m[3] ? 6 : 2);
  });
  scanAll(R.tzLong, norm, (m) => {
    const t = m[1].toLowerCase();
    const zone = /greenwich|universal/.test(t) ? 'UTC' : /british/.test(t) ? 'Europe/London' : /central european/.test(t) ? 'Europe/Paris' : /eastern european/.test(t) ? 'Europe/Athens' : /indian/.test(t) ? 'Asia/Kolkata' : /japan/.test(t) ? 'Asia/Tokyo' : 'Australia/Sydney';
    add('tz', m.index, m.index + m[0].length, { zone }, 0.92, 7);
  });
  if (ctx.placeRe) {
    scanAll(ctx.placeRe, norm, (m) => {
      const zone = PLACES[m[1].toLowerCase().replace(/\s+/g, ' ')];
      if (zone) add('tz', m.index, m.index + m[0].length, { zone }, 0.88, 6);
    });
  }

  // durations
  scanAll(R.duration, norm, (m) => {
    const n = numberOf(m[1]);
    if (n == null) return;
    const unit = m[2].toLowerCase();
    let minutes = unit.startsWith('h') ? n * 60 : n;
    if (m[3]) minutes += +m[3];
    if (m[5]) minutes += 30;
    if (unit === 'h' && !/\d$/.test(m[1])) return;
    if (!(minutes > 0) || minutes > 24 * 60 * 14) return;
    add('duration', m.index, m.index + m[0].length, { minutes: Math.round(minutes) }, 0.85, 5);
  });
  scanAll(R.allDay, norm, (m) => add('duration', m.index, m.index + m[0].length, { allDay: true, minutes: 1440 }, 0.85, 5));

  // recurrence words
  scanAll(R.every, norm, (m) => {
    const what = m[4].toLowerCase();
    const other = m[2] ? m[2].toLowerCase() : null;
    let interval = other ? (/third|3rd/.test(other) ? 3 : 2) : 1;
    if (m[3]) interval = numberOf(m[3]) || interval;
    const rule = everyRule(what, interval);
    if (!rule) return;
    add('recur', m.index, m.index + m[0].length, { rule }, 0.92, 7);
  });
  scanAll(R.adverb, norm, (m) => {
    const w = m[1].toLowerCase().replace('-', '');
    const rule =
      w === 'daily' || w === 'nightly'
        ? { freq: 'DAILY', interval: 1 }
        : w === 'weekly'
          ? { freq: 'WEEKLY', interval: 1 }
          : w === 'biweekly' || w === 'fortnightly'
            ? { freq: 'WEEKLY', interval: 2 }
            : w === 'monthly'
              ? { freq: 'MONTHLY', interval: 1 }
              : w === 'bimonthly'
                ? { freq: 'MONTHLY', interval: 2 }
                : w === 'quarterly'
                  ? { freq: 'MONTHLY', interval: 3 }
                  : w === 'yearly' || w === 'annually'
                    ? { freq: 'YEARLY', interval: 1 }
                    : w === 'weekdays' || w === 'weeknights'
                      ? { freq: 'WEEKLY', interval: 1, byDay: [1, 2, 3, 4, 5] }
                      : null;
    if (rule) add('recur', m.index, m.index + m[0].length, { rule, adverb: true }, 0.8, 6);
  });
  for (const re of [R.nth, R.everyNth]) {
    scanAll(re, norm, (m) => {
      const n = ORDINAL[m[1].toLowerCase()];
      const wd = weekdayIndex(m[2]);
      if (!n || wd < 0) return;
      add('recur', m.index, m.index + m[0].length, { rule: { freq: 'MONTHLY', interval: 1, byDay: [wd], setPos: n } }, 0.9, 8);
    });
  }
  scanAll(R.monthDay, norm, (m) => {
    const d = +(m[1] || m[2] || m[3]);
    if (d < 1 || d > 31) return;
    add('recur', m.index, m.index + m[0].length, { rule: { freq: 'MONTHLY', interval: 1, byMonthDay: d } }, 0.9, 8);
  });
  scanAll(R.count, norm, (m) => {
    const n = numberOf(m[1] || m[3]);
    if (!n) return;
    add('count', m.index, m.index + m[0].length, { count: n, unit: (m[2] || m[4] || '').toLowerCase() }, 0.8, 5);
  });

  // links and contacts
  scanAll(R.url, text, (m) => {
    let t = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
    add('url', m.index, m.index + t.length, { value: /^www\./i.test(t) ? 'https://' + t : /^https?:/i.test(t) ? t : 'https://' + t }, 0.95, 10);
  });
  scanAll(R.email, text, (m) => add('email', m.index, m.index + m[0].length, { value: m[0] }, 0.97, 10));
  scanAll(R.phone, norm, (m) => {
    const digits = m[0].replace(/\D/g, '');
    const plus = m[0][0] === '+';
    if (digits.length < (plus ? 8 : 10) || digits.length > 15) return;
    if (!plus && !/[ .\-()]/.test(m[0]) && digits.length < 10) return;
    if (/^(?:19|20)\d{2}[-/.]\d/.test(m[0])) return;
    // a meeting ID, passcode, order or ticket number is not a phone number
    if (/\b(?:id|code|pin|passcode|password|order|ticket|ref(?:erence)?|confirmation|booking|account|#)[ \t]*[:#]?[ \t]*$/i.test(norm.slice(Math.max(0, m.index - 24), m.index))) return;
    add('phone', m.index, m.index + m[0].length, { value: (plus ? '+' : '') + digits }, 0.85, 7);
  });
  scanAll(R.address, text, (m) => {
    // (a sentence's full stop after the city is no part of it: '..., Chicago. Closed-toe shoes')
    const v = /[a-z]{3}\.$/.test(m[0]) ? m[0].slice(0, -1) : m[0];
    add('location', m.index, m.index + v.length, { value: v.replace(/\s+/g, ' ').trim(), address: true }, 0.85, 7);
  });
  // a grid address with the street type left off, as people text it: '4812 S Woodlawn'
  scanAll(/\b\d{3,5}[ \t]+[NSEW]\.?[ \t]+[A-Z][a-z]{2,}(?:[ \t]+[A-Z][a-z]{2,})?\b(?![ \t]*\d)/dg, text, (m) => add('location', m.index, m.index + m[0].length, { value: m[0].replace(/\s+/g, ' ').trim(), address: true }, 0.7, 6));
  scanAll(R.room, text, (m) => {
    const t = m[0].replace(/\s+/g, ' ').trim();
    if (/^(?:The|This|That|Our|My|Your|Every|Each|All)\s/.test(t) && !/\s(?:Hall|Center|Centre|Library|Park|Museum|Gallery)\b/.test(t)) return;
    add('location', m.index, m.index + m[0].length, { value: t }, 0.65, 3);
  });
  scanAll(R.corner, text, (m) => {
    if (/^\d{1,3}(?:st|nd|rd|th)\s*(?:&|and|at|\/)\s*\d{1,3}(?:st|nd|rd|th)$/.test(m[0])) return; // '1st and 2nd'
    add('location', m.index, m.index + m[0].length, { value: m[0].replace(/\s+/g, ' ').trim(), corner: true }, 0.75, 6);
  });
  scanAll(R.label, text, (m) => {
    const [vs, ve] = span(m, 2);
    const v = text.slice(vs, ve).replace(/\s+$/, '');
    add('location', vs, vs + v.length, { value: v.trim(), labelled: true }, 0.9, 11);
  });
  return out;
}

function zoneFromOffset(s) {
  if (s === 'Z') return 'UTC';
  const m = /([+-])(\d{2}):?(\d{2})/.exec(s);
  return m ? offsetZone((m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3])) : null;
}

// '10/21' or '21/10': order known when one side is over 12, otherwise the dialect's (flagged).
function numericDate(a, b, y, sep, ctx) {
  const mdy = validDate(y || 2024, a, b);
  const dmy = validDate(y || 2024, b, a);
  if (!mdy && !dmy) return null;
  if (mdy && !dmy) return dateSpec(a, b, y, { order: 'MDY', numeric: true });
  if (dmy && !mdy) return dateSpec(b, a, y, { order: 'DMY', numeric: true });
  if (a === b) return dateSpec(a, b, y, { order: 'MDY', numeric: true });
  // dots are a European habit: '21.10.2026' is day first
  if (sep === '.') return dateSpec(b, a, y, { order: null, numeric: true, guess: 'DMY', alt: { m: a, d: b } });
  return dateSpec(ctx.uk ? b : a, ctx.uk ? a : b, y, { order: null, numeric: true, guess: ctx.uk ? 'DMY' : 'MDY', alt: ctx.uk ? { m: a, d: b } : { m: b, d: a } });
}

// 'MWF', 'TTh', 'TR', 'M/W/F' -> weekday indexes (0 = Sunday), or null when it isn't a code.
const CODE_DAYS = { M: 1, Tu: 2, T: 2, W: 3, Th: 4, R: 4, F: 5, Sa: 6, S: 6, Su: 0, U: 0 };
const NOT_CODES = new Set(['MS', 'MT', 'ST', 'SS', 'TT', 'FF', 'MM', 'WW', 'RR', 'TS', 'FM', 'TM', 'WS', 'MF', 'SF', 'TF', 'FT', 'MR', 'RT', 'WR', 'SU', 'US', 'UT', 'TU', 'FR', 'SM', 'MSU', 'TSU', 'RF', 'FW', 'WTF', 'MST', 'MTW']);
function dayCodes(s) {
  const flat = s.replace(/[\s/,&]/g, '');
  if (NOT_CODES.has(flat.toUpperCase()) && !/[/,&]/.test(s)) return null;
  const toks = flat.match(/Tu|Th|Sa|Su|M|T|W|R|F|S|U/g);
  if (!toks || toks.join('') !== flat) return null;
  const days = toks.map((t) => CODE_DAYS[t]);
  if (days.length < 2) return null;
  // a code lists days in week order (Monday first), each once
  const order = days.map((d) => (d === 0 ? 7 : d));
  for (let i = 1; i < order.length; i++) if (order[i] <= order[i - 1]) return null;
  if (flat.length === 2 && !/^(?:MW|WF|TR|MF|SaSu)$/.test(flat) && !/[/,&]/.test(s)) return null;
  if (flat === 'MF' && !/[/,&]/.test(s)) return null;
  return days;
}

function everyRule(what, interval) {
  const w = what.replace(/\s+/g, ' ');
  if (/^days?$|^mornings?$|^evenings?$|^nights?$/.test(w)) return { freq: 'DAILY', interval };
  if (/^week ?days?$/.test(w)) return { freq: 'WEEKLY', interval, byDay: [1, 2, 3, 4, 5] };
  if (/^weekends?$/.test(w)) return { freq: 'WEEKLY', interval, byDay: [6, 0] };
  if (/^weeks?$/.test(w)) return { freq: 'WEEKLY', interval };
  if (w === 'fortnight') return { freq: 'WEEKLY', interval: 2 };
  if (/^months?$/.test(w)) return { freq: 'MONTHLY', interval };
  if (/^years?$/.test(w)) return { freq: 'YEARLY', interval };
  const days = [];
  const re = new RegExp(WD, 'gi');
  let x;
  while ((x = re.exec(w))) {
    const i = weekdayIndex(x[0]);
    if (i >= 0 && !days.includes(i)) days.push(i);
  }
  return days.length ? { freq: 'WEEKLY', interval, byDay: days } : null;
}

// Overlapping atoms: the stronger (priority, then length, then confidence) wins.
function pick(list) {
  const sorted = list.slice().sort((a, b) => b.p - a.p || b.e - b.s - (a.e - a.s) || b.c - a.c || a.s - b.s);
  const kept = [];
  // (a date's weekday prefix gives way to a weekday range: 'Mon-Wed, Oct 19-21', and to a rule
  // that ends in it: 'every Monday, Nov 2 - Dec 14')
  const shrink = (x, o) => {
    if (x.core == null || o.e > x.core || (o.s < x.s - 1 && !(o.k === 'recur' && x.k === 'daterange'))) return false;
    x.s = x.core;
    x.core = null;
    if (x.v.date) x.v.date = { ...x.v.date, wd: -1 };
    return true;
  };
  // The kept atoms by 256-character bucket, so a clash is looked for only near the atom (a chat
  // export has tens of thousands of atoms). A shrink only moves a kept atom's start forward
  // inside its own span, so the buckets stay a superset; clashes keep the order of keeping.
  const B = 256;
  const buckets = new Map();
  const order = new Map();
  const clashes = (a) => {
    const out = [];
    const b0 = Math.floor(a.s / B);
    const b1 = Math.floor(Math.max(a.s, a.e - 1) / B);
    for (let b = b0; b <= b1; b++) {
      for (const k of buckets.get(b) || []) if (a.s < k.e && k.s < a.e && !out.includes(k)) out.push(k);
    }
    return out.length > 1 ? out.sort((x, y) => order.get(x) - order.get(y)) : out;
  };
  for (const a of sorted) {
    const clash = clashes(a);
    if (clash.length && !clash.every((k) => shrink(k, a) || shrink(a, k))) continue;
    if (clash.length && clashes(a).length) continue;
    order.set(a, kept.length);
    kept.push(a);
    for (let b = Math.floor(a.s / B), b1 = Math.floor(Math.max(a.s, a.e - 1) / B); b <= b1; b++) {
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(a);
    }
  }
  return kept.sort((a, b) => a.s - b.s);
}

/* ---------- composition ---------- */

const isDateK = (k) => k === 'date' || k === 'weekday' || k === 'relday';
const isTimeK = (k) => k === 'time' || k === 'timerange';

// atom -> entity skeleton
function entityOf(a) {
  const base = { s: a.s, e: a.e, c: a.c };
  switch (a.k) {
    case 'date':
      return { ...base, type: 'date', date: a.v.date, short: !!a.v.short };
    case 'datetime':
      return { ...base, type: 'datetime', date: a.v.date, time: a.v.time, zone: a.v.zone || null };
    case 'daterange':
      return { ...base, type: 'daterange', date: a.v.date, endDate: a.v.endDate };
    case 'weekday':
      if (a.v.plural) return { ...base, type: 'recurrence', rule: { freq: 'WEEKLY', interval: 1, byDay: [a.v.wd] }, weak: true, c: 0.7 };
      return { ...base, type: 'weekday', date: { wd: a.v.wd, rel: { weekday: a.v.wd, mode: a.v.prefix || 'bare', suffix: a.v.suffix } }, weak: a.v.weak };
    case 'wdset':
      return { ...base, type: 'recurrence', rule: { freq: 'WEEKLY', interval: 1, byDay: a.v.days }, weak: !a.v.plural, codes: !!a.v.codes };
    case 'wdrange':
      return { ...base, type: 'daterange', date: { wd: a.v.from, rel: { weekday: a.v.from, mode: 'bare' } }, endDate: { wd: a.v.to, rel: { weekday: a.v.to, mode: 'after' } }, wdrange: a.v, plural: a.v.plural };
    case 'relday':
      return { ...base, type: 'date', date: { rel: { days: a.v.days, months: a.v.months || 0 }, part: a.v.part } };
    case 'relspan':
      if (a.v.unit === 'weekend') return { ...base, type: 'daterange', date: { rel: { weekend: a.v.which } }, endDate: { rel: { weekend: a.v.which, end: true } } };
      if (a.v.unit === 'week') return { ...base, type: 'daterange', date: { rel: { week: a.v.which } }, endDate: { rel: { week: a.v.which, end: true } }, c: 0.55 };
      return null;
    case 'time':
      return { ...base, type: 'time', time: a.v, weak: !!(a.v.weak || a.v.bare) };
    case 'numrange':
      return { ...base, type: 'numrange', time: a.v.from, endTime: a.v.to, colon: a.v.colon };
    case 'endword':
      return { ...base, type: 'endword', word: a.v.word };
    case 'tz':
      return { ...base, type: 'timezone', zone: a.v.zone, weak: a.v.weak };
    case 'duration':
      return { ...base, type: 'duration', minutes: a.v.minutes, allDay: !!a.v.allDay };
    case 'recur':
      return { ...base, type: 'recurrence', rule: a.v.rule, adverb: !!a.v.adverb };
    case 'count':
      return { ...base, type: 'count', count: a.v.count, unit: a.v.unit };
    case 'month':
      return { ...base, type: 'month', m: a.v.m, y: a.v.y, season: !!a.v.season };
    default:
      return { ...base, type: a.k, value: a.v.value, extra: a.v };
  }
}

function timesFromNumrange(e) {
  return { time: { ...e.time, bare: !e.colon }, endTime: { ...e.endTime, bare: !e.colon } };
}

function compose(ents, norm) {
  const gapOf = (a, b) => norm.slice(a.e, b.s);
  const before = (a, n = 30) => norm.slice(Math.max(0, a.s - n), a.s);
  const after = (a, n = 30) => norm.slice(a.e, a.e + n);
  const merge = (a, b, fields) => Object.assign({ s: Math.min(a.s, b.s), e: Math.max(a.e, b.e), c: Math.min(a.c, b.c) }, fields);
  const hasTime = (e) => e.time && (e.type === 'time' || e.type === 'datetime' || e.type === 'timerange' || e.type === 'recurrence');
  const dateish = (e) => e.type === 'date' || e.type === 'weekday';

  const timeLike = (e) => e.type === 'time' || e.type === 'timerange' || e.type === 'numrange';
  const timesOf = (b) => (b.type === 'numrange' ? timesFromNumrange(b) : { time: b.time, endTime: b.endTime || null });

  // weekday + date: 'Friday, Oct 23', 'Fri 10/23', 'Fri-Sun, Oct 23-25', 'Oct 23 (Fri)'
  const rWdDate = (a, b, g) => {
    if (a.type === 'weekday' && !a.date.rel.suffix && (b.type === 'date' || b.type === 'daterange' || b.type === 'datetime' || b.type === 'timerange') && b.date && b.date.wd < 0 && b.date.m && /^,?[ \t]*\n?[ \t]*(?:the[ \t]+)?$/i.test(g)) {
      return merge(a, b, { ...b, s: a.s, date: { ...b.date, wd: a.date.wd }, c: Math.max(b.c, 0.9) });
    }
    if (a.type === 'daterange' && a.wdrange && (b.type === 'daterange' || b.type === 'date' || b.type === 'datetime' || b.type === 'timerange') && b.date && b.date.m && /^,?[ \t]*$/.test(g)) return merge(a, b, { ...b, s: a.s, c: b.c });
    if ((a.type === 'date' || a.type === 'datetime') && a.date.m && b.type === 'weekday' && /^[ \t]*[(,]?[ \t]*$/.test(g) && b.date.rel.mode === 'bare') {
      const close = /^[ \t]*\)/.exec(norm.slice(b.e));
      return merge(a, b, { ...a, e: b.e + (close ? close[0].length : 0), date: { ...a.date, wd: a.date.wd >= 0 ? a.date.wd : b.date.wd } });
    }
    return null;
  };
  // date range: 'Oct 21 - Oct 23', 'Dec 28, 2026 to Jan 3, 2027', 'Mon to Wed'
  const rDateRange = (a, b, g) => {
    const and = /and/i.test(g);
    const between = /between[ \t]*$/i.test(before(a, 9));
    if (a.type === 'date' && b.type === 'date' && !a.date.rel && !b.date.rel && RANGE_GAP.test(g) && (!and || between)) return merge(a, b, { type: 'daterange', date: a.date, endDate: b.date });
    if (a.type === 'weekday' && b.type === 'weekday' && RANGE_GAP.test(g) && !and) return merge(a, b, { type: 'daterange', date: a.date, endDate: { ...b.date, rel: { ...b.date.rel, mode: 'after' } }, wdrange: { from: a.date.wd, to: b.date.wd } });
    return null;
  };
  // time range: '3pm - 4:30pm', '7pm until late', 'between 2 and 4pm'
  const rTimeRange = (a, b, g) => {
    const and = /and/i.test(g);
    // ('9:00 AM PT - 12:00 PM ET' is one moment said twice, not a range)
    if (a.type === 'time' && b.type === 'time' && (a.zone || b.zone)) return null;
    if (a.type === 'time' && b.type === 'time' && RANGE_GAP.test(g) && (!and || /between[ \t]*$/i.test(before(a, 9)))) return merge(a, b, { type: 'timerange', time: a.time, endTime: b.time, zone: a.zone || b.zone, c: Math.max(a.c, b.c) });
    if (a.type === 'time' && b.type === 'endword' && RANGE_GAP.test(g)) return merge(a, b, { type: 'timerange', time: a.time, endTime: null, open: b.word, zone: a.zone });
    // '11AM 9PM DAILY': the dash lost (OCR), two times with am/pm side by side; '6:00   8:00 PM'
    // (a time without am/pm before one with it, the dash between lost)
    if (a.type === 'time' && b.type === 'time' && /^ {1,3}$/.test(g) && a.time.mer && b.time.mer && !a.time.word && !b.time.word) return merge(a, b, { type: 'timerange', time: a.time, endTime: b.time, c: Math.min(a.c, b.c, 0.7) });
    if (a.type === 'time' && b.type === 'time' && /^[ \t]{1,3}$/.test(g) && !a.time.mer && !a.time.h24 && a.time.mi != null && !a.time.bare && b.time.mer && !b.time.word) return merge(a, b, { type: 'timerange', time: a.time, endTime: b.time, c: Math.min(a.c, b.c, 0.6) });
    return null;
  };
  // date + time: 'Oct 21, 7pm', 'tomorrow at 3', 'Sat 10/24 @ 7:30', 'Oct 21-23, 10am-6pm'
  const rDateTime = (a, b, g) => {
    const tabbed = TAB_GAP.test(g);
    if ((dateish(a) || (a.type === 'daterange' && !a.time)) && timeLike(b) && (DT_GAP.test(g) || tabbed)) {
      const t = timesOf(b);
      if (a.type === 'daterange') return merge(a, b, { type: 'timerange', date: a.date, endDate: a.endDate, time: t.time, endTime: t.endTime, open: b.open, daily: true, wdrange: a.wdrange, zone: b.zone });
      if (t.endTime || b.open || b.durationMin) return merge(a, b, { type: 'timerange', date: a.date, time: t.time, endTime: t.endTime, open: b.open, durationMin: b.durationMin, part: a.date.part, zone: b.zone, wdOnly: a.type === 'weekday' });
      return merge(a, b, { type: 'datetime', date: a.date, time: t.time, part: a.date.part, zone: b.zone, wdOnly: a.type === 'weekday' });
    }
    if (a.type === 'recurrence' && timeLike(b) && !b.date && !a.time && (DT_GAP.test(g) || tabbed || /^[ \t]*,?[ \t]*(?:from|at)?[ \t]*$/i.test(g))) {
      const t = timesOf(b);
      return merge(a, b, { ...a, time: t.time, endTime: t.endTime, open: b.open, durationMin: b.durationMin, zone: b.zone || a.zone, weak: false, e: b.e });
    }
    return null;
  };
  // time + date: '7pm on Friday', '8am tomorrow', '7:30, Oct 21', '6-8pm Tuesdays'
  const rTimeDate = (a, b, g) => {
    if (timeLike(a) && (dateish(b) || (b.type === 'daterange' && !b.time)) && TD_GAP.test(g)) {
      const t = timesOf(a);
      if (b.type === 'daterange') return merge(a, b, { type: 'timerange', date: b.date, endDate: b.endDate, time: t.time, endTime: t.endTime, daily: true, zone: a.zone, wdrange: b.wdrange });
      if (t.endTime || a.open || a.durationMin) return merge(a, b, { type: 'timerange', date: b.date, time: t.time, endTime: t.endTime, open: a.open, durationMin: a.durationMin, part: b.date.part, zone: a.zone, wdOnly: b.type === 'weekday' });
      return merge(a, b, { type: 'datetime', date: b.date, time: t.time, part: b.date.part, zone: a.zone, wdOnly: b.type === 'weekday' });
    }
    if (timeLike(a) && !a.date && b.type === 'recurrence' && !b.time && /^[ \t]*,?[ \t]*(?:on|every)?[ \t]*$/i.test(g)) {
      const t = timesOf(a);
      return merge(a, b, { ...b, s: a.s, time: t.time, endTime: t.endTime, durationMin: a.durationMin, zone: a.zone || b.zone, weak: false });
    }
    return null;
  };
  // datetime + end: 'Oct 21 7pm - 10pm', 'Fri 6pm - Sun 4pm'
  const rDtEnd = (a, b, g) => {
    if (a.type === 'datetime' && RANGE_GAP.test(g) && !/and/i.test(g)) {
      if (b.type === 'time') return merge(a, b, { type: 'timerange', date: a.date, time: a.time, endTime: b.time, zone: a.zone || b.zone, part: a.part, wdOnly: a.wdOnly });
      if (b.type === 'datetime') return merge(a, b, { type: 'timerange', date: a.date, time: a.time, endDate: b.date, endTime: b.time, zone: a.zone || b.zone, wdOnly: a.wdOnly });
      if (b.type === 'endword') return merge(a, b, { type: 'timerange', date: a.date, time: a.time, endTime: null, open: b.word, zone: a.zone, wdOnly: a.wdOnly });
    }
    return null;
  };
  // zone: '3pm ET', '15:00 (UTC)', '3 PM Eastern'
  const rZone = (a, b, g) => {
    if (b.type === 'timezone' && (hasTime(a) || timeLike(a)) && /^[ \t]*[([]?[ \t]*$/.test(g) && !a.zone) {
      const close = /^[ \t]*[)\]]/.exec(norm.slice(b.e));
      return merge(a, b, { ...a, zone: b.zone, e: b.e + (close && /[([]/.test(g) ? close[0].length : 0), c: a.c });
    }
    return null;
  };
  // duration: '7pm for 2 hours', 'Oct 21 at 3pm (90 minutes)'
  const rDuration = (a, b, g) => {
    if (b.type === 'duration' && !b.allDay && (a.type === 'time' || a.type === 'datetime' || (a.type === 'recurrence' && a.time && !a.endTime)) && /^[ \t]*[,(-]?[ \t]*(?:for|lasting|approx\.?|about|duration:?)?[ \t]*(?:about|approx\.?|approximately)?[ \t]*$/i.test(g)) {
      const close = /^[ \t]*\)/.exec(norm.slice(b.e));
      const base = a.type === 'recurrence' ? { ...a } : { ...a, type: 'timerange' };
      return merge(a, b, { ...base, endTime: null, durationMin: b.minutes, e: b.e + (close && /\(/.test(g) ? close[0].length : 0) });
    }
    return null;
  };
  // recurrence bounds and counts: 'every Tuesday until Dec 10', 'Sep 8 - Dec 11, MWF', 'for 6 weeks'
  const rRecur = (a, b, g) => {
    // '6-week course starting Tue Oct 27, 6-8pm': weekly from that day, six times
    if (a.type === 'count' && /week|session|class|lesson|meeting/.test(a.unit) && (b.type === 'datetime' || b.type === 'timerange' || b.type === 'date') && b.date && !b.date.rel && /^[ \t]*[,:;]?[ \t]*(?:starting|beginning|from|commencing|begins|starts|on)?[ \t]*(?:on|from)?[ \t]*$/i.test(g)) {
      return merge(a, b, { type: 'recurrence', rule: { freq: 'WEEKLY', interval: 1 }, from: b.date, time: b.time || null, endTime: b.endTime || null, durationMin: b.durationMin, zone: b.zone, count: a.count, c: 0.85 });
    }
    if (a.type === 'recurrence') {
      if (b.type === 'date' && !b.date.rel && UNTIL_GAP.test(g)) return merge(a, b, { ...a, until: b.date, e: b.e });
      if ((b.type === 'date' || b.type === 'datetime') && FROM_GAP.test(g)) return merge(a, b, { ...a, from: b.date, time: a.time || b.time || null, e: b.e });
      if (b.type === 'daterange' && !b.time && !b.wdrange && /^[ \t]*[,;(]?[ \t]*(?:from|between|during|starting)?[ \t]*$/i.test(g)) return merge(a, b, { ...a, from: b.date, until: b.endDate, e: b.e, weak: false });
      // 'Lab Tuesdays, Oct 20 - Dec 8, 2-4pm': the span and its hours were joined first (the
      // daily hours of a date span); with a rule in front the span bounds the rule
      if (b.type === 'timerange' && b.daily && b.endDate && /^[ \t]*[,;(]?[ \t]*(?:from|between|during|starting)?[ \t]*$/i.test(g)) {
        return merge(a, b, { ...a, from: b.date, until: b.endDate, time: a.time || b.time, endTime: a.endTime || b.endTime || null, zone: a.zone || b.zone, e: b.e, weak: false });
      }
      if (b.type === 'count' && /^[ \t]*[,;(]?[ \t]*$/.test(g)) return merge(a, b, { ...a, count: b.count, e: b.e });
      if (b.type === 'weekday' && /^[ \t]*(?:on)?[ \t]*$/i.test(g) && a.rule.freq === 'WEEKLY' && !a.rule.byDay) return merge(a, b, { ...a, rule: { ...a.rule, byDay: [b.date.wd] }, e: b.e });
      // 'every 2 weeks on Monday at 9:30am'
      if ((b.type === 'datetime' || b.type === 'timerange') && b.wdOnly && b.date.rel && b.date.rel.mode === 'bare' && /^[ \t]*,?[ \t]*(?:on)?[ \t]*$/i.test(g) && a.rule.freq === 'WEEKLY' && !a.rule.byDay && !a.time) {
        return merge(a, b, { ...a, rule: { ...a.rule, byDay: [b.date.wd] }, time: b.time, endTime: b.endTime || null, durationMin: b.durationMin, zone: b.zone || a.zone, e: b.e });
      }
      if (b.type === 'recurrence' && /^[ \t]*,?[ \t]*(?:on)?[ \t]*$/i.test(g)) {
        // 'weekly on Tuesdays', 'every week, Mon/Wed'
        const x = a.adverb || !a.rule.byDay ? b : a;
        const y = x === a ? b : a;
        if ((x.rule.byDay || x.rule.setPos || x.rule.byMonthDay) && (!y.rule.byDay || y.adverb)) return merge(a, b, { ...x, s: a.s, e: b.e, rule: { ...x.rule, interval: Math.max(x.rule.interval || 1, y.rule.interval || 1), freq: x.rule.setPos || x.rule.byMonthDay ? 'MONTHLY' : x.rule.freq }, time: a.time || b.time, endTime: a.endTime || b.endTime, from: a.from || b.from, until: a.until || b.until, count: a.count || b.count, zone: a.zone || b.zone, weak: false });
      }
      if ((b.type === 'datetime' || b.type === 'timerange') && b.date && !b.date.rel && FROM_GAP.test(g)) return merge(a, b, { ...a, from: b.date, until: b.daily && b.endDate ? b.endDate : a.until, time: a.time || b.time, endTime: a.endTime || b.endTime || null, zone: a.zone || b.zone, e: b.e });
    }
    if (b.type === 'recurrence') {
      // 'Nov 6-8, 10am-6pm daily': the daily hours of a date span
      if (a.type === 'timerange' && a.daily && b.adverb && b.rule.freq === 'DAILY' && /^[ \t]*,?[ \t]*$/.test(g)) return merge(a, b, { ...a, e: b.e });
      if (a.type === 'daterange' && !a.wdrange && !a.time && /^[ \t]*[,;:|\t]?[ \t]*(?:on|every)?[ \t]*$/i.test(g)) return merge(a, b, { ...b, s: a.s, from: a.date, until: a.endDate, weak: false });
      if (a.type === 'date' && !a.date.rel && /^[ \t]*[,;:]?[ \t]*(?:and[ \t]+)?(?:then)?[ \t]*$/i.test(g) && /(?:starting|beginning|from|commencing|starts|begins)[ \t]*(?:on)?[ \t]*$/i.test(before(a, 14))) return merge(a, b, { ...b, s: a.s, from: a.date });
      if ((a.type === 'datetime' || a.type === 'timerange') && a.date && !a.daily && !a.date.rel && /^[ \t]*[,;]?[ \t]*(?:and[ \t]+)?(?:then|repeats?|repeating)?[ \t]*$/i.test(g) && !b.time) return merge(a, b, { ...b, s: a.s, from: a.date, time: a.time, endTime: a.endTime || null, durationMin: a.durationMin, zone: a.zone || b.zone, weak: false });
    }
    return null;
  };

  const pass = (list, rules) => {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 6) {
      changed = false;
      const next = [];
      for (let i = 0; i < list.length; i++) {
        let a = list[i];
        while (i + 1 < list.length) {
          const b = list[i + 1];
          const g = gapOf(a, b);
          // nothing joins across a line break, except a weekday over its date ('FRIDAY' / 'OCT 30',
          // '...scheduled for Mon,' / 'Nov 23 at 5:15 AM')
          const nl = /\n/.test(g);
          if (g.length > 24 || (nl && !(/^[ \t,]*\n[ \t]*$/.test(g) && a.type === 'weekday' && a.date.rel.mode === 'bare' && b.date && b.date.m))) break;
          let got = null;
          for (const r of rules) {
            got = r(a, b, g);
            if (got) break;
          }
          if (!got) break;
          a = got;
          i++;
          changed = true;
        }
        next.push(a);
      }
      list = next;
    }
    return list;
  };

  let list = pass(ents.filter(Boolean), [rWdDate, rDateRange, rTimeRange]);
  extendBare(list, norm);
  list = pass(list, [rTimeRange, rZone]);
  list = pass(list, [rWdDate, rDateTime, rTimeDate]);
  list = pass(list, [rDtEnd, rZone, rDuration]);
  list = pass(list, [rRecur, rDateTime, rTimeDate, rZone, rDuration]);
  return list;
}

// A bare number before a range sign and a time: '3-4:30pm', '7 until midnight', '7 until late';
// and after one: '11am-1', '7pm - 10'.
function extendBare(list, norm) {
  // 'is any other atom over [s, t)?', through the atoms sorted by their first start (here a
  // start moves at most 16 characters back and an end at most 12 forward): asked for every time
  const byS = list.map((o) => ({ o, s: o.s })).sort((p, q) => p.s - q.s);
  const span = list.reduce((n, o) => Math.max(n, o.e - o.s), 0) + 28;
  const over = (e, s, t) => {
    let lo = 0;
    let hi = byS.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (byS[m].s < s - span - 16) lo = m + 1;
      else hi = m;
    }
    for (let k = lo; k < byS.length && byS[k].s < t + 16; k++) {
      const o = byS[k].o;
      if (o !== e && o.s < t && o.e > s) return true;
    }
    return false;
  };
  for (const e of list) {
    if (!(e.type === 'time' || e.type === 'endword') || e.extended) continue;
    const b = norm.slice(Math.max(0, e.s - 16), e.s);
    const m = /(?:^|[^\w:.$£€/])(\d{1,2})(?:[:.]([0-5]\d))?[ \t]*(?:-|to|until|till|til|thru)[ \t]*$/i.exec(b);
    if (!m) continue;
    const h = +m[1];
    if (h > 23) continue;
    const lead = /^[^\d]/.test(m[0]) ? 1 : 0;
    const at = e.s - b.length + m.index + lead;
    if (over(e, at, e.s)) continue;
    if (e.type === 'endword') {
      Object.assign(e, { type: 'timerange', time: { h, mi: m[2] ? +m[2] : 0, mer: null, bare: true }, endTime: null, open: e.word, s: at, c: 0.6 });
    } else {
      Object.assign(e, { type: 'timerange', endTime: e.time, time: { h, mi: m[2] ? +m[2] : 0, mer: null, bare: !m[2] }, s: at, c: Math.min(e.c, 0.9) });
    }
    e.extended = true;
  }
  for (const e of list) {
    if (e.type !== 'time' || e.extended) continue;
    const m = /^[ \t]*(?:-|to|until|till|til)[ \t]*(\d{1,2})(?:[:.]([0-5]\d))?(?![\w:./]|[ \t]?[ap]\.?m)/i.exec(norm.slice(e.e, e.e + 12));
    if (!m || +m[1] > 23) continue;
    const end = e.e + m[0].length;
    if (over(e, e.e, end)) continue;
    Object.assign(e, { type: 'timerange', endTime: { h: +m[1], mi: m[2] ? +m[2] : 0, mer: null, bare: true }, e: end });
    e.extended = true;
  }
}

/* ---------- context words for am/pm ---------- */

const EVENING = /\b(?:tonight|tonite|evening|night|dinner|supper|drinks|cocktails?|party|concert|show|gig|doors|happy[ \t]+hour|late|pm|p\.m\.|nightcap|bar|club|dj|karaoke|trivia|movie|film|screening|gala|reception|after[ \t]+work|after[ \t]+school)\b/i;
const MORNING = /\b(?:morning|breakfast|brunch|am|a\.m\.|sunrise|coffee|commute)\b/i;
const AFTERNOON = /\b(?:afternoon|lunch|matinee|tea)\b/i;

// Hours with no am/pm: 'at 7' (evening words around: 7pm), '9 to 5' (9am-5pm), '10:30' (am).
function inferMer(t, hint) {
  if (t.mer || t.h24 || t.h > 12 || t.h === 0) return { ...t, inferred: false };
  let mer;
  if (hint === 'pm') mer = t.h === 12 ? 'pm' : 'pm';
  else if (hint === 'am') mer = t.h === 12 ? 'am' : 'am';
  else if (hint === 'afternoon') mer = t.h <= 6 || t.h === 12 ? 'pm' : 'am';
  else mer = t.h === 12 || t.h <= 7 ? 'pm' : 'am';
  if (hint === 'pm' && t.h >= 7 && t.h <= 11 && false) mer = 'pm';
  return { ...t, mer, inferred: true };
}

function to24(t) {
  let h = t.h % 12;
  if (t.mer === 'pm') h += 12;
  if (t.mer == null) h = t.h;
  if (t.word === 'midnight') h = 0;
  return h;
}

function hintAround(norm, s, e, part) {
  if (part === 'night' || part === 'evening') return 'pm';
  if (part === 'morning') return 'am';
  if (part === 'afternoon') return 'afternoon';
  // the line around it, at most 80 characters before and 60 after (a document that is one long
  // line has thousands of times: never scan the whole line for each)
  const lo = Math.max(0, s - 80);
  const w = norm.slice(lo, Math.min(norm.length, e + 60));
  const ls = w.lastIndexOf('\n', s - lo) + 1;
  const le = w.indexOf('\n', e - lo);
  const line = w.slice(ls, le < 0 ? w.length : le);
  if (EVENING.test(line)) return 'pm';
  if (MORNING.test(line)) return 'am';
  if (AFTERNOON.test(line)) return 'afternoon';
  return null;
}

// A time range's am/pm: a side without one takes the other's ('3-4:30pm', '10-11am', '11-1pm'
// = 11am-1pm), and two bare hours read as a working day when the second is smaller ('9 to 5').
function rangeMer(a, b, hint) {
  let x = { ...a };
  let y = b ? { ...b } : null;
  const fixed = (t) => t.mer || t.h24 || t.h > 12 || t.h === 0;
  if (y && fixed(y) && !fixed(x)) {
    const ey = to24(y);
    const mer = y.mer || (ey >= 12 ? 'pm' : 'am');
    x.mer = mer;
    let sx = to24(x);
    if (sx > ey || (sx === ey && x.mi >= y.mi)) x.mer = mer === 'pm' ? 'am' : 'pm';
    if (x.h === 12 && x.mer === 'am' && y.mer === 'pm') x.mer = 'pm';
    x.inferred = true;
  } else if (y && fixed(x) && !fixed(y)) {
    const sx = to24(x);
    y.mer = x.mer || (sx >= 12 ? 'pm' : 'am');
    if (to24(y) <= sx) y.mer = y.mer === 'am' ? 'pm' : 'am';
    y.inferred = true;
  } else if (y && !fixed(x) && !fixed(y)) {
    if (y.h < x.h || (y.h === 12 && x.h < 12)) {
      x.mer = x.h === 12 ? 'pm' : 'am';
      y.mer = 'pm';
      if (hint === 'pm' && x.h >= 5) {
        x.mer = 'pm';
        y.mer = 'am';
      }
    } else {
      const both = inferMer({ ...x }, hint).mer;
      x.mer = both;
      y.mer = both;
      if (both === 'am' && y.h === 12) y.mer = 'pm';
    }
    x.inferred = y.inferred = true;
  } else if (!y) x = inferMer(x, hint);
  return [x, y];
}

/* ---------- resolution ---------- */

function makeCtx(opts) {
  const dialect = opts.dialect === 'en-GB' ? 'en-GB' : 'en-US';
  const timeZone = opts.timeZone || defaultZone() || 'UTC';
  const now = nowIn(opts.now || Date.now(), timeZone);
  const places = Object.keys(PLACES)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ \\t]+'));
  return { dialect, uk: dialect === 'en-GB', timeZone, now, ref: now, dateOrder: opts.dateOrder || null, placeRe: new RegExp(`\\b(${places.join('|')})[ \\t]+time\\b`, 'dgi') };
}

const isoOf = (y, m, d) => isoDate(y, m, d);

function resolveDates(list, ctx) {
  // the order unambiguous numeric dates in this text use
  let mdy = 0;
  let dmy = 0;
  for (const e of list) {
    for (const d of [e.date, e.endDate, e.until, e.from]) {
      if (d && d.numeric && d.order === 'MDY' && d.m !== d.d) mdy++;
      if (d && d.numeric && d.order === 'DMY') dmy++;
    }
  }
  const docOrder = ctx.dateOrder || (dmy && !mdy ? 'DMY' : mdy && !dmy ? 'MDY' : null);
  // explicit years nearby
  const anchors = [];
  for (const e of list) {
    for (const d of [e.date, e.endDate, e.until, e.from]) if (d && d.yearGiven && d.m && !e.header) anchors.push({ at: e.s, n: dayNumber(d.y, d.m, Math.min(d.d, daysIn(d.y, d.m))) });
    if (e.type === 'month' && e.y) anchors.push({ at: e.s, n: dayNumber(e.y, e.m, 15), weak: true });
  }
  const today = dayNumber(ctx.ref.y, ctx.ref.m, ctx.ref.d);
  const decided = []; // dates whose year came from 'now', in text order
  const order = (d) => {
    if (!d || !d.numeric || d.order || d.ordered) return;
    const o = docOrder || d.guess;
    if (o !== d.guess) [d.m, d.d, d.alt] = [d.alt.m, d.alt.d, { m: d.m, d: d.d }];
    d.ambiguous = !docOrder;
    d.orderFrom = docOrder ? 'document' : 'dialect';
    d.ordered = true;
    // a weekday written with it settles the order the document does not: 'Tue 3/11' read in
    // October 2026 is 3 November (a Tuesday), not 11 March (a Thursday)
    if (!docOrder && d.wd >= 0 && d.alt && validDate(2024, d.alt.m, d.alt.d)) {
      const fits = (m, dd) => {
        let y = ctx.ref.y;
        if (!validDate(y, m, dd) || dayNumber(y, m, dd) < today - 31) y++;
        return validDate(y, m, dd) && weekdayOf(y, m, dd) === d.wd;
      };
      const a = fits(d.m, d.d);
      const b = fits(d.alt.m, d.alt.d);
      if (b && !a) {
        [d.m, d.d, d.alt] = [d.alt.m, d.alt.d, { m: d.m, d: d.d }];
        d.orderFrom = 'weekday';
      }
      if (a !== b) d.ambiguous = false;
    }
  };
  // the nearest anchor (a year after the date counts 5 characters further, a month's year 400),
  // the first one on a tie: by binary search, as each date asks (a chat export has thousands)
  const sortedAnchors = (weak) => anchors.map((a, i) => ({ ...a, i })).filter((a) => !!a.weak === weak).sort((p, q) => p.at - q.at || p.i - q.i);
  const strong = sortedAnchors(false);
  const weakOnes = sortedAnchors(true);
  const nearest = (arr, at) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].at <= at) lo = m + 1;
      else hi = m;
    }
    const out = [];
    if (lo > 0) {
      let k = lo - 1;
      while (k > 0 && arr[k - 1].at === arr[lo - 1].at) k--;
      out.push(arr[k]);
    }
    if (lo < arr.length) out.push(arr[lo]);
    return out;
  };
  const yearFor = (d, at, ongoing) => {
    let best = null;
    for (const a of [...nearest(strong, at), ...nearest(weakOnes, at)]) {
      const dist = Math.abs(a.at - at) + (a.at > at ? 5 : 0) + (a.weak ? 400 : 0);
      if (!best || dist < best.dist || (dist === best.dist && a.i < best.i)) best = { ...a, dist };
    }
    if (best) {
      const Y = fromDayNumber(best.n).y;
      let y = null;
      let bestDiff = Infinity;
      for (const yy of [Y - 1, Y, Y + 1]) {
        if (!validDate(yy, d.m, d.d)) continue;
        const diff = Math.abs(dayNumber(yy, d.m, d.d) - best.n);
        if (diff < bestDiff) {
          bestDiff = diff;
          y = yy;
        }
      }
      if (y != null) return { y, from: 'document' };
    }
    let y = ctx.ref.y;
    // prefer the future; a series that started a while ago is still running
    const past = validDate(y, d.m, d.d) ? today - dayNumber(y, d.m, d.d) : 1;
    if (past > 0 && !(ongoing && past <= 200)) y++;
    while (!validDate(y, d.m, d.d) && y < ctx.ref.y + 8) y++;
    return { y, from: 'now' };
  };
  // a weekday written with the date picks the year it is true in: a year either side of a
  // year the document gives ('Sun, Oct 25' under '2027 Calendar' is 2026), or this year when
  // 'the next one' was next year and the day is at most a month gone; otherwise the date is
  // kept and flagged (weekdayMismatch)
  const weekdayYear = (d) => {
    if (d.wd < 0 || !validDate(d.y, d.m, d.d) || weekdayOf(d.y, d.m, d.d) === d.wd) return;
    const cands = d.yearFrom === 'now' ? [d.y - 1].filter((yy) => validDate(yy, d.m, d.d) && dayNumber(yy, d.m, d.d) >= today - 31) : [d.y - 1, d.y + 1];
    for (const yy of cands) {
      if (validDate(yy, d.m, d.d) && weekdayOf(yy, d.m, d.d) === d.wd) {
        d.y = yy;
        d.yearFrom = 'weekday';
        return;
      }
    }
    d.weekdayMismatch = true;
  };
  const settle = (d, at, ongoing) => {
    if (!d || d.resolved || d.rel || !d.m) return;
    order(d);
    if (!d.yearGiven) {
      const r = yearFor(d, at, ongoing);
      d.y = r.y;
      d.yearFrom = r.from;
      d.inferredYear = true;
      weekdayYear(d);
      if (d.yearFrom === 'now') decided.push(d);
    }
    d.resolved = true;
  };
  // the start of a range takes its year from the end: 'Oct 10-20' read on Oct 17 is this year's
  const follow = (a, b) => {
    order(a);
    a.y = b.y - (a.m > b.m || (a.m === b.m && a.d > b.d) ? 1 : 0);
    a.inferredYear = true;
    a.yearFrom = 'range';
    a.dep = { on: b };
    a.resolved = true;
  };
  for (const e of list) {
    for (const [a, b, ongoing] of [[e.date, e.endDate, false], [e.from, e.until, true]]) {
      const real = (d) => d && d.m && !d.rel;
      if (real(a) && real(b)) {
        order(a);
        order(b);
        if (!a.yearGiven && !b.yearGiven) {
          settle(b, e.s, false);
          follow(a, b);
          // the start's weekday moves the whole range ('Fri-Sun, Oct 23-25')
          const fits = (x, yy) => x.wd < 0 || (validDate(yy, x.m, x.d) && weekdayOf(yy, x.m, x.d) === x.wd);
          if (a.wd >= 0 && !fits(a, a.y)) {
            const shift = a.y - b.y;
            const cands = b.yearFrom === 'now' ? [b.y - 1].filter((yy) => dayNumber(yy + shift, a.m, Math.min(a.d, daysIn(yy + shift, a.m))) >= today - 31) : [b.y - 1, b.y + 1];
            const yy = cands.find((y2) => fits(a, y2 + shift) && fits(b, y2));
            if (yy != null) {
              b.y = yy;
              b.yearFrom = 'weekday';
              a.y = yy + shift;
            }
          }
        } else if (a.yearGiven && !b.yearGiven) {
          settle(a, e.s);
          b.y = a.y + (b.m < a.m || (b.m === a.m && b.d < a.d) ? 1 : 0);
          b.inferredYear = true;
          b.resolved = true;
        } else if (!a.yearGiven && b.yearGiven) {
          settle(b, e.s);
          follow(a, b);
        } else {
          settle(a, e.s);
          settle(b, e.s);
        }
      } else {
        settle(a, e.s, ongoing || e.type === 'recurrence');
        settle(b, e.s, ongoing);
      }
    }
  }
  // a chronological list that started before today keeps its year: Sep..Dec read in October
  for (let i = 0; i < decided.length; i++) {
    const d = decided[i];
    if (d.y !== ctx.ref.y + 1 || d.yearFrom !== 'now' || !validDate(ctx.ref.y, d.m, d.d)) continue;
    // (not against the weekday written with it)
    if (d.wd >= 0 && weekdayOf(ctx.ref.y, d.m, d.d) !== d.wd) continue;
    const earlier = dayNumber(ctx.ref.y, d.m, d.d);
    if (today - earlier > 200) continue;
    for (let j = i + 1; j < decided.length; j++) {
      const o = decided[j];
      if (o.y === ctx.ref.y && dayNumber(o.y, o.m, o.d) >= earlier) {
        d.y = ctx.ref.y;
        d.yearFrom = 'sequence';
        break;
      }
    }
  }
  for (const e of list) {
    for (const d of [e.date, e.endDate, e.from, e.until]) {
      if (d && d.dep) d.y = d.dep.on.y - (d.m > d.dep.on.m || (d.m === d.dep.on.m && d.d > d.dep.on.d) ? 1 : 0);
      // a weekday that does not fit the date it is written with, whatever gave the year
      if (d && d.m && d.wd >= 0 && validDate(d.y, d.m, d.d)) d.weekdayMismatch = weekdayOf(d.y, d.m, d.d) !== d.wd;
    }
  }
}

// The next day-of-month n on or after today (with weekday wd, if given, in the first month
// where that day is that weekday): 'on the 31st', 'Monday the 9th'.
function nextDayOfMonth(n, wd, ctx) {
  const t = ctx.ref;
  let fallback = null;
  for (let k = 0; k < 15; k++) {
    const y = t.y + Math.floor((t.m - 1 + k) / 12);
    const m = ((t.m - 1 + k) % 12) + 1;
    if (n > daysIn(y, m) || (k === 0 && n < t.d)) continue;
    const spec = dateSpec(m, n, null, { wd, resolved: true, inferredYear: true, yearFrom: wd >= 0 ? 'weekday' : 'now', ordinalDay: true });
    spec.y = y;
    if (wd < 0 || weekdayOf(y, m, n) === wd) return spec;
    if (!fallback) fallback = { ...spec, yearFrom: 'now', weekdayMismatch: true };
  }
  return fallback;
}

// Holidays that name a day -> the next one on or after today.
const FIXED_HOLIDAYS = [
  [/^new year'?s eve$/, 12, 31], [/^new year'?s(?: day)?$/, 1, 1], [/^christmas eve$/, 12, 24], [/^christmas(?: day)?$/, 12, 25],
  [/^boxing day$/, 12, 26], [/^hallowe'?en$/, 10, 31], [/^valentine'?s(?: day)?$/, 2, 14], [/^st\.? patrick'?s(?: day)?$/, 3, 17],
  [/^(?:independence day|(?:the )?fourth of july)$/, 7, 4], [/^juneteenth$/, 6, 19], [/^veterans'? day$/, 11, 11], [/^(?:bonfire|guy fawkes) night$/, 11, 5],
];
const NTH_HOLIDAYS = [
  [/^thanksgiving(?: day)?$/, 11, 4, 4], [/^labou?r day$/, 9, 1, 1], [/^memorial day$/, 5, 1, -1], [/^(?:mlk|martin luther king(?: jr\.?)?) day$/, 1, 1, 3],
  [/^presidents'? day$/, 2, 1, 3], [/^mother'?s day$/, 5, 0, 2], [/^father'?s day$/, 6, 0, 3],
];
function easter(y) {
  // anonymous Gregorian computus
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return { m: Math.floor((h + l - 7 * m + 114) / 31), d: ((h + l - 7 * m + 114) % 31) + 1 };
}
function holidayDate(name, ctx) {
  const w = String(name).toLowerCase().replace(/[ \t]+/g, ' ');
  if (ctx.uk && /^(?:mother|father|thanksgiving|labor|memorial|mlk|martin|presidents|independence|juneteenth|veterans|(?:the )?fourth)/.test(w)) return null;
  if (!ctx.uk && /^(?:boxing|bonfire|guy fawkes|labour)/.test(w)) return null;
  const today = dayNumber(ctx.ref.y, ctx.ref.m, ctx.ref.d);
  for (let y = ctx.ref.y; y <= ctx.ref.y + 1; y++) {
    let md = null;
    for (const [re, m, d] of FIXED_HOLIDAYS) if (re.test(w)) md = { m, d };
    for (const [re, m, wd, n] of NTH_HOLIDAYS) {
      if (!re.test(w)) continue;
      const iso = nthWeekdayOfMonth(y, m, wd, n);
      if (iso) md = { m, d: +iso.slice(8, 10) };
    }
    if (/^(?:easter|good friday)/.test(w)) {
      const e = easter(y);
      const t = fromDayNumber(dayNumber(y, e.m, e.d) - (/^good/.test(w) ? 2 : 0));
      md = { m: t.m, d: t.d };
    }
    if (!md) return null;
    if (y === ctx.ref.y && dayNumber(y, md.m, md.d) < today) continue;
    const spec = dateSpec(md.m, md.d, null, { resolved: true, inferredYear: true, yearFrom: 'now' });
    spec.y = y;
    return spec;
  }
  return null;
}

// A relative or weekday-only date -> ISO.
function relDate(d, ctx, other) {
  const r = d.rel;
  const todayIso = ctx.ref.iso;
  if (r.days != null) return addDays(todayIso, r.days);
  if (r.months) {
    const t = ctx.ref;
    let m = t.m + r.months;
    let y = t.y + Math.floor((m - 1) / 12);
    m = ((m - 1) % 12) + 1;
    return isoDate(y, m, Math.min(t.d, daysIn(y, m)));
  }
  if (r.weekend) {
    const sat = nextWeekday(todayIso, 6);
    let start = ctx.ref.wd === 0 ? todayIso : sat;
    if (r.weekend === 'next') start = ctx.ref.wd === 0 || ctx.ref.wd === 6 ? nextWeekday(addDays(todayIso, 1), 6) : addDays(sat, 7);
    const sun = ctx.ref.wd === 0 && r.weekend !== 'next' ? todayIso : addDays(start, 1);
    return r.end ? sun : start;
  }
  if (r.week) {
    const mon = r.week === 'next' ? nextWeekday(addDays(todayIso, 1), 1) : addDays(todayIso, -((ctx.ref.wd + 6) % 7));
    return r.end ? addDays(mon, 6) : mon;
  }
  if (r.weekday != null) {
    const wd = r.weekday;
    // an end day counts from the start: 'Fri 6pm to Sun 4pm'
    if ((r.mode === 'after' || r.mode === 'bare') && other) return nextWeekday(other, wd);
    if (r.mode === 'last') return addDays(nextWeekday(todayIso, wd), -7);
    if (r.suffix === 'next week' || r.mode === 'next' || r.mode === 'following') {
      // the one in next week (Monday to Sunday)
      const mon = nextWeekday(addDays(todayIso, 1), 1);
      return addDays(mon, (wd + 6) % 7);
    }
    if (r.suffix === 'after next' || r.suffix === 'week after next') return addDays(nextWeekday(addDays(todayIso, 1), 1), 7 + ((wd + 6) % 7));
    return nextWeekday(todayIso, wd);
  }
  return todayIso;
}

function dateIso(d, ctx, other) {
  if (!d) return null;
  if (d.rel) return relDate(d, ctx, other);
  if (!d.m || !validDate(d.y, d.m, d.d)) return null;
  return isoOf(d.y, d.m, d.d);
}

function ruleString(rule, extra) {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay && rule.byDay.length) parts.push(`BYDAY=${rule.byDay.map((d) => (rule.setPos ? rule.setPos : '') + DAY_CODES[d]).join(',')}`);
  if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  if (extra && extra.count) parts.push(`COUNT=${extra.count}`);
  else if (extra && extra.until) parts.push(`UNTIL=${extra.until.replace(/-/g, '')}`);
  return parts.join(';');
}

// The first date on or after `from` that the rule produces.
export function firstOccurrence(rule, from) {
  const p = parseIso(from);
  if (rule.freq === 'WEEKLY' && rule.byDay && rule.byDay.length) {
    let best = null;
    for (const wd of rule.byDay) {
      const d = nextWeekday(from, wd);
      if (!best || d < best) best = d;
    }
    return best;
  }
  if (rule.freq === 'MONTHLY' && rule.setPos && rule.byDay) {
    for (let k = 0; k < 14; k++) {
      let m = p.m + k;
      const y = p.y + Math.floor((m - 1) / 12);
      m = ((m - 1) % 12) + 1;
      const d = nthWeekdayOfMonth(y, m, rule.byDay[0], rule.setPos);
      if (d && d >= from) return d;
    }
  }
  if (rule.freq === 'MONTHLY' && rule.byMonthDay) {
    for (let k = 0; k < 14; k++) {
      let m = p.m + k;
      const y = p.y + Math.floor((m - 1) / 12);
      m = ((m - 1) % 12) + 1;
      if (rule.byMonthDay <= daysIn(y, m)) {
        const d = isoDate(y, m, rule.byMonthDay);
        if (d >= from) return d;
      }
    }
  }
  return from;
}

// Entity skeletons -> public entities.
function finish(list, text, norm, ctx) {
  const out = [];
  for (const e of list) {
    if (!e) continue;
    if (e.type === 'endword' || e.type === 'count' || e.type === 'month') continue;
    if (e.type === 'numrange') {
      const b = norm.slice(Math.max(0, e.s - 24), e.s);
      const cue = /\b(?:from|open|opens|hours?|time|times|doors|between|daily|nightly)[ \t]*:?[ \t]*$/i.test(b) || /^(?:[ \t]*(?:daily|nightly|every|each|weekdays|weekends))/i.test(norm.slice(e.e, e.e + 12)) || e.colon;
      if (!cue) continue;
      Object.assign(e, { type: 'timerange', ...timesFromNumrange(e) });
    }
    if (e.type === 'weekday' && e.weak) continue;
    if (e.type === 'time' && e.weak && !e.time.mi) {
      const b = norm.slice(Math.max(0, e.s - 12), e.s);
      if (!/(?:at|@|from|by|around|about|after|before|starts?|begins?|doors(?: open)?|meet(?: at| up)?|arrive(?: by)?)[ \t]*$/i.test(b)) continue;
    }
    if (e.type === 'date' && e.short) {
      // '3/4' alone is a fraction or a score; with a cue or on its own line it is a date
      const b = norm.slice(Math.max(0, e.s - 14), e.s);
      const a = norm.slice(e.e, e.e + 14);
      const ls = norm.lastIndexOf('\n', e.s - 1) + 1;
      let le = norm.indexOf('\n', e.e);
      if (le < 0) le = norm.length;
      const alone = (!norm.slice(ls, e.s).trim() || /\t[ \t]*$/.test(norm.slice(ls, e.s))) && /^[ \t]*(?:\t|$)/.test(norm.slice(e.e, le));
      const cue = /\b(?:on|by|due|until|till|from|since|before|after|through|thru|starting|ending|dated?|deadline|week[ \t]+of|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\.?,?[ \t]*$/i.test(b) || /^[ \t]*(?:@|at\b|-[ \t]*\d|\d{1,2}(?::\d{2})?[ \t]?(?:am|pm))/i.test(a);
      if (!alone && !cue) continue;
    }
    if (e.type === 'recurrence' && e.weak && !e.time) {
      // 'Mondays' or 'MWF' with no time: still a recurrence when alone in a cell or after 'on'
      const b = norm.slice(Math.max(0, e.s - 8), e.s);
      const ls = norm.lastIndexOf('\n', e.s - 1) + 1;
      let le = norm.indexOf('\n', e.e);
      if (le < 0) le = norm.length;
      const alone = (!norm.slice(ls, e.s).trim() || /\t[ \t]*$/.test(norm.slice(ls, e.s))) && /^[ \t]*(?:\t|$)/.test(norm.slice(e.e, le));
      if (!alone && !/\b(?:on|every|each)[ \t]*$/i.test(b) && e.codes) continue;
      if (!alone && !/\b(?:on|every|each)[ \t]*$/i.test(b) && !e.from && !e.until) e.c = Math.min(e.c, 0.5);
    }
    const ent = publicEntity(e, text, norm, ctx);
    if (ent) out.push(ent);
  }
  return out;
}

function publicEntity(e, text, norm, ctx) {
  const base = { type: e.type, start: e.s, end: e.e, text: text.slice(e.s, e.e), confidence: Math.round(e.c * 100) / 100 };
  const zone = e.zone || null;
  const hint = () => hintAround(norm, e.s, e.e, e.part || (e.date && e.date.part));
  const flag = (out, d) => {
    if (!d) return out;
    if (d.ambiguous) {
      out.ambiguous = true;
      if (d.alt && validDate(d.y, d.alt.m, d.alt.d)) out.alternatives = [isoOf(d.y, d.alt.m, d.alt.d)];
      out.confidence = Math.min(out.confidence, 0.6);
    }
    if (d.rel) out.relative = true;
    if (d.inferredYear) out.inferredYear = true;
    if (d.weekdayMismatch) {
      out.weekdayMismatch = true;
      out.weekdayWritten = DAY_CODES[d.wd];
      out.confidence = Math.min(out.confidence, 0.5);
    }
    return out;
  };
  const time = (t, h) => {
    const r = inferMer(t, h);
    return { iso: isoTime(to24(r), r.mi), inferred: !!r.inferred };
  };
  switch (e.type) {
    case 'date': {
      const iso = dateIso(e.date, ctx);
      if (!iso) return null;
      return flag({ ...base, value: iso }, e.date);
    }
    case 'weekday': {
      const iso = dateIso(e.date, ctx);
      return { ...base, value: DAY_CODES[e.date.wd], date: iso, relative: true };
    }
    case 'daterange': {
      const a = dateIso(e.date, ctx);
      const b = dateIso(e.endDate, ctx, a);
      if (!a || !b || b < a) return null;
      const out = flag({ ...base, value: { start: a, end: b } }, e.date);
      if (e.wdrange) out.weekdays = true;
      if (e.endDate && e.endDate.weekdayMismatch && !out.weekdayMismatch) {
        out.weekdayMismatch = true;
        out.weekdayWritten = DAY_CODES[e.endDate.wd];
        out.confidence = Math.min(out.confidence, 0.5);
      }
      return out;
    }
    case 'time': {
      const t = time(e.time, hint());
      const out = { ...base, value: t.iso };
      if (t.inferred) {
        out.inferred = true;
        out.confidence = Math.min(out.confidence, 0.7);
      }
      if (e.time.approx) out.approximate = true;
      if (zone) out.timeZone = zone;
      return out;
    }
    case 'datetime': {
      let d = dateIso(e.date, ctx);
      if (!d) return null;
      const t = time(e.time, hint());
      // a bare weekday whose time has passed today means next week's
      if (e.wdOnly && e.date.rel && e.date.rel.mode === 'bare' && d === ctx.ref.iso && t.iso < ctx.ref.time) d = addDays(d, 7);
      const out = flag({ ...base, value: `${d}T${t.iso}` }, e.date);
      if (t.inferred) {
        out.inferred = true;
        out.confidence = Math.min(out.confidence, 0.75);
      }
      if (zone) out.timeZone = zone;
      if (e.wdOnly) {
        out.relative = true;
        if (e.date.wd >= 0) out.weekday = DAY_CODES[e.date.wd];
      }
      return out;
    }
    case 'timerange': {
      const [x, y] = rangeMer(e.time, e.endTime, e.open ? 'pm' : hint());
      const a = isoTime(to24(x), x.mi);
      let b = y ? isoTime(to24(y), y.mi) : null;
      if (e.durationMin) {
        const mins = to24(x) * 60 + x.mi + e.durationMin;
        b = isoTime(Math.floor(mins / 60) % 24, mins % 60);
      }
      let d = e.date ? dateIso(e.date, ctx) : null;
      if (d && e.wdOnly && e.date.rel && e.date.rel.mode === 'bare' && !e.daily && d === ctx.ref.iso && a < ctx.ref.time) d = addDays(d, 7);
      const out = { ...base };
      if (d) {
        let endDay = e.endDate && !e.daily ? dateIso(e.endDate, ctx, d) : d;
        if (b && !e.daily && endDay === d && b <= a) endDay = addDays(d, 1);
        if (e.durationMin && endDay === d) endDay = addDays(d, Math.floor((to24(x) * 60 + x.mi + e.durationMin) / 1440));
        out.value = { start: `${d}T${a}`, end: b ? `${endDay}T${b}` : null };
        if (e.daily && e.endDate) {
          const last = dateIso(e.endDate, ctx, d);
          out.days = { start: d, end: last };
          if (b && b <= a) out.value.end = `${addDays(d, 1)}T${b}`;
        }
        flag(out, e.date);
        if (e.wdOnly) {
          out.relative = true;
          if (e.date.wd >= 0) out.weekday = DAY_CODES[e.date.wd];
        }
      } else out.value = { start: a, end: b };
      if (e.open) out.open = e.open;
      if (x.inferred || (y && y.inferred)) {
        out.inferred = true;
        out.confidence = Math.min(out.confidence, x.inferred && (!y || y.inferred) && (x.bare || (y && y.bare)) ? 0.65 : 0.85);
      }
      if (zone) out.timeZone = zone;
      return out;
    }
    case 'recurrence': {
      const rule = e.rule;
      const from = e.from ? dateIso(e.from, ctx) : ctx.ref.iso;
      const until = e.until ? dateIso(e.until, ctx, from) : null;
      const first = firstOccurrence(rule, from || ctx.ref.iso);
      const value = {
        rrule: ruleString(rule, { until, count: e.count }),
        freq: rule.freq,
        interval: rule.interval || 1,
        byDay: rule.byDay ? rule.byDay.map((d) => (rule.setPos ? rule.setPos : '') + DAY_CODES[d]) : null,
        byMonthDay: rule.byMonthDay || null,
        until,
        count: e.count || null,
        start: first,
        from: e.from ? from : null,
      };
      if (e.time) {
        const [x, y] = rangeMer(e.time, e.endTime || null, hint());
        value.time = { start: isoTime(to24(x), x.mi), end: y ? isoTime(to24(y), y.mi) : null };
        if (e.durationMin) {
          const mins = to24(x) * 60 + x.mi + e.durationMin;
          value.time.end = isoTime(Math.floor(mins / 60) % 24, mins % 60);
        }
        if (x.inferred) value.time.inferred = true;
        // a series with no start of its own that would begin earlier today begins next time
        if (!e.from && value.start === ctx.ref.iso && value.time.start < ctx.ref.time) value.start = firstOccurrence(rule, addDays(ctx.ref.iso, 1));
      }
      const out = { ...base, value };
      if (zone) out.timeZone = zone;
      return out;
    }
    case 'duration': {
      const h = Math.floor(e.minutes / 60);
      const m = e.minutes % 60;
      const value = e.allDay ? 'P1D' : `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}`;
      return { ...base, value, minutes: e.minutes, allDay: e.allDay };
    }
    case 'timezone': {
      if (e.weak) {
        const b = norm.slice(Math.max(0, e.s - 28), e.s);
        if (!/\b(?:times?|zone|all|are|in|tz)\b[^\n]{0,12}$/i.test(b) && !/\(\s*$/.test(b)) return null;
      }
      return { ...base, value: e.zone };
    }
    case 'url':
    case 'email':
    case 'phone':
    case 'location': {
      const out = { ...base, value: e.value };
      if (e.extra && e.extra.address) out.address = true;
      if (e.extra && e.extra.labelled) out.labelled = true;
      return out;
    }
    default:
      return null;
  }
}

/**
 * findEntities(textOrLayout, { dialect, now, timeZone, dateOrder, types })
 *   textOrLayout: a string, or a Layout (extractLayout) whose text is read; offsets refer to
 *   that text. now: Date | ms | ISO string (default: the clock). timeZone: the user's zone
 *   (default: the device's), used for 'today' and relative dates.
 */
export function findEntities(input, opts = {}) {
  const text = typeof input === 'string' ? input : input && typeof input.text === 'string' ? input.text : '';
  const ctx = makeCtx(opts);
  const norm = normalize(text);
  const picked = pick(atoms(text, norm, ctx));
  let ents = compose(picked.map(entityOf), norm);
  // an email's own date is 'today' for its 'tomorrow' and 'next Friday'
  const ref = emailDate(text, norm, ents, ctx);
  if (ref) ctx.ref = ref;
  resolveDates(ents, ctx);
  let out = finish(ents, text, norm, ctx);
  if (opts.types) out = out.filter((e) => opts.types.includes(e.type));
  if (input && typeof input !== 'string' && Array.isArray(input.lines)) {
    for (const e of out) e.line = lineAt(input.lines, e.start);
  }
  return out;
}

// The 'Sent:' or 'Date:' line of an email header (with From/To/Subject around it).
function emailDate(text, norm, ents, ctx) {
  R.emailHeader.lastIndex = 0;
  let m;
  while ((m = R.emailHeader.exec(norm))) {
    const around = norm.slice(Math.max(0, m.index - 300), m.index + 300);
    if (!/^[ \t]*(?:from|to|subject|cc)[ \t]*:/im.test(around)) continue;
    const e = ents.find((x) => x.s >= m.index && x.s < m.index + m[0].length && (x.type === 'datetime' || x.type === 'date') && x.date && x.date.yearGiven);
    if (!e) continue;
    const d = e.date;
    if (!validDate(d.y, d.m, d.d)) continue;
    const iso = isoDate(d.y, d.m, d.d);
    if (iso > ctx.now.iso) continue;
    e.header = true;
    return { ...ctx.now, y: d.y, m: d.m, d: d.d, wd: weekdayOf(d.y, d.m, d.d), iso };
  }
  return null;
}

export function lineAt(lines, offset) {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lines[mid];
    if (offset < l.start) hi = mid - 1;
    else if (offset >= l.end + 1) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export { ruleString, inferMer, rangeMer, makeCtx };
