// findEvents(textOrLayout, { dialect, now, timeZone, defaultDuration }) -> Event[]
//
//   Event = { title, start, end, allDay, timeZone, location, recurrence, description, url,
//             confidence, endInferred, sources: { title: [s, e], start, end, location, recurrence, url },
//             warnings? [{ type: 'weekday-mismatch', text, span }] }
//   start/end  wall-clock times in timeZone ('2026-10-21T19:00'), or dates for all-day events
//              ('2026-10-21', end exclusive: the day after the last day, as in iCalendar)
//   timeZone   the zone the text names ('3pm ET'), else a zone the document states ('All times
//              Eastern'), else opts.timeZone, else null (floating: the same clock time anywhere)
//   recurrence an RRULE value without 'RRULE:' ('FREQ=WEEKLY;BYDAY=TU;UNTIL=20261216T055959Z');
//              start is then the first occurrence
//   sources    offsets in the layout's text (= the input string for plain text)
//
// The layout says what belongs together, tried in this order: tables with a date column
// (a syllabus, a class schedule: one event per row, the title from the topic column), agendas
// (lines that start with a time under a date heading: one event per session, ending when the
// next begins), labelled forms ('Date:', 'Time:', 'Where:', or a flyer's 'WHEN' above its
// value), then free text (a chat, an email, an invite: each date with the time, place and
// words around it). Titles come from a label, a table cell, the session line, the words beside
// the date ('Team lunch Friday at noon'), the page's biggest heading, or an email's subject.

import { findEntities, firstOccurrence } from './entities.js';
import { layoutFromText, layoutFromPages, labelKey } from '../layout/layout.js';
import { addDays, addMinutes, parseIso, datePart, timePart, weekdayOf, DAY_CODES, daysBetween, minutesBetween } from './civil.js';
import { isoToUtc, isFixedZone, zoneOfPlace, localToUtc, utcToLocal, offsetAt, offsetZone } from './tz.js';
import { schemaEvent, schemaTime } from './schema.js';
import { splitSentences } from '../speech/split.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TEMPORAL = new Set(['date', 'datetime', 'daterange', 'timerange', 'time', 'weekday', 'recurrence']);
const hasT = (v) => typeof v === 'string' && v.length > 10;

// what kind of thing a temporal entity gives
function shapeOf(e) {
  if (!e) return null;
  switch (e.type) {
    case 'date':
    case 'weekday':
      return 'date';
    case 'daterange':
      return 'days';
    case 'datetime':
      return 'moment';
    case 'timerange':
      return hasT(e.value.start) ? 'moment' : 'time';
    case 'time':
      return 'time';
    case 'recurrence':
      return 'rule';
    default:
      return null;
  }
}

const isDateShape = (s) => s === 'date' || s === 'days' || s === 'moment' || s === 'rule';

/* ---------- words ---------- */

const FILLER_START = /^(?:(?:(?:hi|hello|hey|dear)\s+[A-Z][a-z]+\s*[,!:]\s*)|(?:hey|hi|hello|ok|okay|so|yes|yeah|yep|sure|great|cool|reminder|remember|psst|fyi|btw|also|and|but|just|quick)\b[ ,!:.-]*)+|^(?:(?:this\s+is\s+)?(?:just\s+)?a\s+(?:friendly\s+|quick\s+)?reminder\s+(?:of|for|about|that)(?:\s+(?:your|the|our))?\s+)|^(?:please\s+)?(?:come\s+)?(?:join\s+(?:us|me)\s+(?:for|at|on|in)?|you(?:'re|’re| are)\s+invited\s+to|we(?:'re|’re| are)\s+(?:having|hosting|holding)|we\s+will\s+(?:hold|have|host)|we'll\s+(?:hold|have|host)|there(?:'s|’s| is| will be)|don'?t\s+(?:forget|miss)(?:\s+(?:about|out on))?|reminder\s+that|just\s+a\s+(?:reminder|heads[ -]up)(?:\s+that)?|let'?s(?:\s+(?:do|have|grab|get))?|want\s+to(?:\s+(?:grab|get|do))?|wanna(?:\s+(?:grab|get|do))?|how\s+about|are\s+you\s+(?:free|around|up)\s+for|r\s+u\s+free\s+for|can\s+we\s+(?:do|have|move|push|shift|reschedule|bump|change)|(?:unfortunately,?\s+)?(?:i|we)\s+(?:need|have|want|would\s+like|'d\s+like|will\s+have)\s+to\s+(?:move|reschedule|push|shift|change|bump)(?:\s+(?:our|the|my|your|this))?|shall\s+we(?:\s+(?:do|have))?|could\s+we\s+(?:do|have)|save\s+the\s+date(?:\s+for)?|mark\s+your\s+calendars?(?:\s+for)?|come\s+to|come\s+(?:out\s+)?for|attend|your)(?:\s+|$)/i;
const FILLER_END = /(?:\s+(?:on|at|this|next|from|starting|is|are|will\s+be|will\s+take\s+place|takes\s+place|happens|scheduled\s+for|set\s+for|planned\s+for|for|by|in|the|of|and|or|with|until|till|to|moved|changed|rescheduled|pushed(?:\s+back)?|has\s+been|have\s+been|been|was|were|is\s+being|is\s+now|now|will\s+start|starts|begins|returns|is\s+back|kicks\s+off|opens|meets|meet|-|–|—))+\s*$/i;
const GENERIC_TITLE = /^(?:your\s+)?(?:(?:please\s+)?(?:come\s+)?join\s+(?:us|me)|(?:tickets?|order|booking|reservation|registration|appointment)\s+(?:is\s+|are\s+|has\s+been\s+)?(?:confirmed|confirmation|booked|reminder|details|receipt)|confirmation|order\s+confirmation|reminder|appointment\s+reminder|save\s+the\s+date|you(?:'re|’re|\s+are)\s+(?:invited|going|registered|all\s+set|booked)|hi\b.*|hello\b.*|dear\b.*|thanks?\b.*|thank\s+you\b.*|receipt|invoice|itinerary|e-?tickets?|admit\s+one|event\s+details|details|(?:race|match|game|show|class|trip|visit|appointment|booking|order|ticket|session|meeting|flight|travel|reservation)\s+(?:details|info|information|summary)|upcoming\s+(?:visits?|appointments?|events?)|(?:your|next)\s+(?:visit|appointment)|when|where|date|time|location|venue|schedule|agenda|program|programme|today|tomorrow|tonight|new\s+message|messages|imessage|text\s+message|inbox|re|fwd?|see\s+you\s+(?:there|then)|perfect|sounds\s+good|yes|no|ok|okay|confirmed|(?:general\s+)?admission|ga|delivered|read|sent)\s*[!.?]*$/i;
const EVENT_NOUNS = 'dinner|lunch|brunch|breakfast|coffee|drinks|happy hour|party|meeting|meetup|meet-up|call|appointment|appt|concert|show|gig|game|match|movie|film|screening|class|lecture|seminar|workshop|webinar|talk|practice|rehearsal|interview|hangout|workout|yoga|run|hike|picnic|barbecue|bbq|potluck|trivia|study session|study group|office hours|conference|summit|festival|fair|market|service|mass|wedding|birthday|shower|reunion|checkup|check-up|cleaning|haircut|exam|midterm|final|quiz|presentation|demo|review|standup|stand-up|sync|retro|retrospective|1:1|one-on-one|offsite|off-site|orientation|training|session|tour|visit|playdate|recital|ceremony|graduation|celebration|gala|fundraiser|auction|open house|reception|tasting|book club|game night|movie night|date night|sleepover|flight|train|trip|drop-off|pick-up|pickup|dropoff|deadline|due date|tutoring|lesson|club|volunteering|shift|tryouts?|banquet|brunch'.split('|');
const NOUN_RE = new RegExp(`\\b(${EVENT_NOUNS.sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})s?\\b`, 'i');
const DEADLINE = /\b(?:rsvp|r\.s\.v\.p\.|register|registration|sign[ -]?ups?|sign\s+and\s+return|return\s+(?:the|this|your)\s+[\w\s-]{0,24}?(?:form|slip|sheet)|turn\s+in|hand\s+in|send\s+back|due|apply|applications?|submit(?:ted|ssions?)?|must\s+be\s+(?:received|returned|in)|order|book|purchase|buy|reply|respond|confirm|cancel(?:lation)?s?|refunds?|early[ -]?bird|deadline|closes?|expires?|valid|offer|sale|discount|tickets?\s+on\s+sale|on\s+sale|presale|enrol(?:l|lment)?|pay(?:ment)?|last\s+day\s+to)\b[^\n.!?]{0,30}$/i;
// a chat export's message stamp, up to the sender's colon (WhatsApp on iOS and on Android)
const CHAT_STAMP = /^[ \t]*(?:\[[ \t]*\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4},?[ \t]+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?[ \t]*(?:[AaPp]\.?[Mm]\.?)?[ \t]*\][ \t]*|\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4},?[ \t]+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?[ \t]*(?:[AaPp]\.?[Mm]\.?)?[ \t]+[-–][ \t]+)(?=[^:\n]{1,40}:)/;
// a chat app's sender line: a name, then 'Today at 6:05 PM' and nothing else
const SENDER_LINE = /^[ \t]*[@\p{L}][\p{L}\p{N}._'’ -]{0,30}?[ \t]+(?:today|yesterday)(?:[ \t]+at)?[ \t]+\d{1,2}:\d{2}[ \t]*(?:[AaPp]\.?[Mm]\.?)?[ \t]*$/iu;
const HEADER_LINE = /^[ \t]*(?:sent|received|posted|updated|last\s+updated|last\s+modified|published|printed|issued|created|generated|modified|copyright|©|dob|date\s+of\s+birth|born|exp(?:iry|ires)?)\b/i;
// a table column that names a role or a task, not an event ('Role: Greeter'), and a heading over
// a roster: such rows are titled 'Fall Food Drive: Greeter'
const ROLE_HEAD = /^(?:roles?|shifts?|tasks?|positions?|jobs?|duty|duties|stations?|assignments?|teams?|groups?|volunteers?|crew)$/i;
const ROSTER_HEAD = /\b(?:volunteers?|shifts?|sign-?ups?|roster|rota|duty|duties)\b/i;
// agenda rows that mark when the one before ends ('2:30 PM Adjourn'), not sessions of their own
const END_MARK = /^(?:adjourn(?:ment|ed)?|end(?:\s+of\s+(?:the\s+)?(?:day|program|programme|event|meeting|session|conference))?|close(?:\s+of\s+(?:day|meeting))?|wrap[\s-]?up\s+and\s+depart|dismissal|finish|doors\s+close|event\s+ends|program\s+ends)\s*[.!]?$/i;
const NO_CLASS = /\b(?:no\s+(?:class|classes|lecture|meeting|school|section)|cancel+ed|holiday|break|recess|campus\s+closed|reading\s+(?:day|period|week)|thanksgiving|no\s+lab)\b/i;
const ROOMISH = /^(?:(?:room|rm\.?|hall|stage|ballroom|atrium|auditorium|lobby|terrace|suite|studio|lab|gym|theater|theatre|salon|lounge|pavilion|track|floor|level|gate|court|field)\b|.*\b(?:room|hall|stage|ballroom|atrium|auditorium|lobby|terrace|suite|studio|lab|center|centre|theater|theatre|salon|lounge|pavilion|library|building|bldg|gallery|plaza|arena|park)\b(?:\s+[A-Z0-9][\w.-]{0,5})?)$/i;

const PLACE_NOUN = /\b(?:room|hall|field|park|library|cafe|café|coffee\s*shop|office|gym|center|centre|pantry|kitchen|lounge|auditorium|theater|theatre|studio|lab|house|place|church|school|building|floor|court|garden|gardens|pool|rink|track|stadium|arena|bar|pub|restaurant|club|campus|quad|commons|plaza|square|station|terminal|gate|lobby|atrium|ballroom|chapel|clinic|hospital|market|beach|shop|store|salon|museum|gallery|apartment|flat|basement|rooftop|backyard|garage|parking\s+lot|lot|hotel|inn|venue|stage|pavilion|bandshell|bistro|diner|brewery|tavern|deli|bakery|community\s+room|conference\s+room|classroom|cafeteria|dining\s+hall|main\s+hall|front\s+desk|reception|courtyard|lawn|green|playground|trailhead|dock|pier|harbor|harbour|blacktop|narthex|sanctuary|nave|vestry|fellowship\s+hall|parish\s+hall|deck|roof\s+deck|patio|terrace|bandstand|boardwalk|pitch)\b/i;

// a short place-like phrase: Title Case words, an address, or words with a place noun
function placeLike(s) {
  // (accents off: 'Sunny Side Café')
  const t = tidy(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t || t.length > 60 || t.split(/\s+/).length > 8) return false;
  if (/^(?:the\s+)?(?:same|that|this|usual|my|your|our|his|her|their)\b/i.test(t)) return false;
  if (/[.!?]$/.test(t) && t.split(/\s+/).length > 3) return false;
  if (PLACE_NOUN.test(t) && !/^(?:Free|Bring|RSVP|Tickets?|Admission|Please|All|Everyone|Required)\b/.test(t)) return true;
  if (/^\d{1,5}\s+\S/.test(t)) return true;
  const ws = t.replace(/[,·•|]/g, ' ').split(/\s+/).filter(Boolean);
  return ws.length <= 7 && ws.every((w) => /^(?:[A-Z0-9][\w'’&.()-]*|of|the|and|&|de|la|at|on)$/.test(w)) && /^[A-Z0-9]/.test(t) && !/^(?:Free|Bring|RSVP|Tickets?|Admission|Lunch|Dinner|Food|Drinks|Snacks|Please|All|Everyone|Open|Doors|Show|Accept|Decline|Tentative|Delivered|Read|Organizer)\b/.test(t);
}

function tidy(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|•·:,;*>]+/, '')
    .replace(/[\s\-–—|•·:,;(]+$/, '')
    .trim();
}

const LABEL_PREFIX = /^(?:(?:booking|order|reservation|registration|appointment|tickets?|payment|event|class|meeting)\s+)?(?:confirmed|confirmation|reminder|update|updated|cancell?ed|rescheduled|note|fyi|announcement|news|alert|notice|invitation|invite|heads[ -]up|new|important|psa)\s*[:!–—-]\s*/i;
const TICKETS_FOR = /^(?:(?:your|my|the|our)\s+)?(?:tickets?|booking|reservation|registration|seats?|order|e-?tickets?|passes|pass)\s+(?:for|to)\s+/i;

function cleanTitle(s) {
  // (what is left of a chat export's stamp once its date is taken out: '[ , ] Dana: hike')
  let t = tidy(tidy(s).replace(/^\[[^\]\p{L}]*\]\s*(?:[-–]\s+)?/u, ''));
  // a speaker in a chat log ('Sam: soccer practice...'), not a label
  // (only before a message: 'Sam: soccer practice...', 'Bright Smile Dental: Hi Tom, ...';
  // 'Breakout A: Transit' and 'Film Night: Paper Moon' are titles)
  const sp = /^([A-Z][\w&'’.-]{0,15}(?:\s[A-Z][\w&'’.-]{0,15}){0,3}):\s+(?=(?:[a-z]|(?:Hi|Hello|Hey|Dear|Hiya|Just|Reminder|This|We|I|You|Your|Our|Can|Could|Are|Is|Don't|Please)\b))/.exec(t);
  if (sp && !labelKey(sp[1])) t = t.slice(sp[0].length);
  t = t
    .replace(LABEL_PREFIX, '')
    .replace(TICKETS_FOR, '')
    .replace(/^(?:re|fwd?|fw)\s*:\s*/i, '')
    .replace(/^(?:updated\s+)?invitation(?:\s+updated)?\s*:\s*/i, '')
    .replace(/^(?:event|what|title|subject|topic|session|class|course|activity|meeting)\s*:\s*/i, '')
    // 'Doors 7pm, show 8pm' with its times cut out: the show, not the doors
    .replace(/^(?:doors|gates)(?:\s+open)?\s*[,;/&|-]+\s*(?=\p{L})/iu, '')
    .replace(/\s+@\s+.*$/, '') // Google Calendar: 'Design review @ Tue Oct 20, 2026 2pm - 3pm (CDT) (you@x)'
    .replace(/\s*\((?:[^()]*@[^()]*)\)\s*$/, '');
  for (let k = 0; k < 3; k++) {
    const before = t;
    t = t.replace(FILLER_START, '').replace(FILLER_END, '');
    t = tidy(t.replace(/[!?.]+$/, ''));
    if (t === before) break;
  }
  // 'A quick call' -> 'quick call' (not 'A Midsummer Night's Dream'); 'our 1:1' -> '1:1'
  return t.replace(/^(?:a|an)\s+(?=[a-z])/i, '').replace(/^(?:[Oo]ur|[Mm]y)\s+(?=[a-z0-9]\S*(?:\s+\S+){0,2}$)/, '');
}

function goodTitle(t) {
  if (!t || t.length < 2 || t.length > 120) return false;
  // (a month on its own is a calendar's page heading, not an event: 'October 2026')
  if (/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:\s+\d{4})?$/i.test(t.trim())) return false;
  if (!/\p{L}{2}/u.test(t)) return false;
  if (GENERIC_TITLE.test(t)) return false;
  // (a pronoun is not a title: 'We' of 'We meet Wed Nov 4')
  if (/^(?:we|i|you|they|he|she|it|us|me|them|our|my|let'?s|we'?ll|i'?ll)$/i.test(t.trim())) return false;
  return true;
}

const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// A chat line ('are you free for dinner?') -> its event word ('Dinner'), with a few words around.
function nounPhrase(text) {
  const m = NOUN_RE.exec(text);
  if (!m) return null;
  let s = m.index;
  let e = m.index + m[0].length;
  const before = text.slice(0, s).split(/\s+/).filter(Boolean);
  const keep = [];
  for (let k = before.length - 1; k >= 0 && keep.length < 3; k--) {
    const w = before[k];
    if (/^(?:the|a|an|for|to|our|my|your|some|this|next|that|about|free|go|grab|get|have|do|at|on|in|and|or|with|is|are|was|be|of|out|up|any|are|you|we|i)$/i.test(w) || /[.!?,:;]$/.test(w)) break;
    if (/^(?:team|family|staff|all-hands|weekly|monthly|annual|holiday|office|game|study|book|movie|trivia|pizza|potluck|birthday|welcome|farewell|goodbye|surprise|dental|doctor'?s|doctors|dentist|eye|vet|annual|quarterly|board|budget|planning|project|design|product|sprint|kickoff|kick-off|launch|cooking|art|dance|piano|guitar|swim|soccer|basketball|baseball|football|tennis|volleyball|chess|math|chemistry|physics|history|english|spanish|french|biology|lab|parent-teacher|ptA|pta|church|bible|school|work|company|lunch|dinner)$/i.test(w) || /^[A-Z]/.test(w) || /['’]s$/.test(w)) keep.unshift(w);
    else break;
  }
  if (keep.length) s = text.lastIndexOf(keep[0], s);
  // 'coffee with Sam', 'appointment with Dr. Raman'
  const tail = /^\s+with\s+((?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+)?[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2}/.exec(text.slice(e));
  if (tail) e += tail[0].length;
  return { text: capFirst(tidy(text.slice(s, e))), s, e };
}

/* ---------- the builder ---------- */

function toLayout(input) {
  if (typeof input === 'string') return layoutFromText(input);
  if (input && Array.isArray(input.lines) && typeof input.text === 'string') return input;
  if (input && input.layout) return input.layout;
  if (input && typeof input.text === 'string') return layoutFromText(input.text);
  return layoutFromText('');
}

/* ---------- schema.org events (web pages) ---------- */

const DAY_URL = /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i;
const isoMinutes = (s) => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(String(s || '').trim());
  return m && (m[1] || m[2] || m[3]) ? (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
};

// A schema.org time in the event's zone: the place's zone when the address names one, else
// the page's, else the user's; a time written with an offset is converted into that zone
// (a page in UTC), or kept in its own offset when no zone is known.
function structuredTime(t, zone) {
  if (!t.time) return t.date;
  if (t.offset == null || !zone) return `${t.date}T${t.time}`;
  const [y, m, d] = t.date.split('-').map(Number);
  const [h, mi] = t.time.split(':').map(Number);
  const ms = Date.UTC(y, m - 1, d, h, mi) - t.offset * 60000;
  const l = utcToLocal(ms, zone);
  return `${l.y}-${String(l.m).padStart(2, '0')}-${String(l.d).padStart(2, '0')}T${String(l.h).padStart(2, '0')}:${String(l.mi).padStart(2, '0')}`;
}

function structuredEvents(items, opts, docZone) {
  const out = [];
  const defMin = opts.defaultDuration > 0 ? opts.defaultDuration : 60;
  for (const o of items) {
    const s = schemaEvent(o);
    if (!s || s.status === 'EventCancelled' || s.status === 'EventPostponed') continue;
    let start = s.start;
    let end = s.end;
    let recurrence = null;
    const sch = s.schedule;
    if (sch) {
      // eventSchedule: { byDay, repeatFrequency 'P1W', startDate, endDate, startTime, endTime, repeatCount }
      const first = schemaTime(sch.startDate) || start;
      const freqM = /^P(\d+)([DWMY])$/i.exec(String(sch.repeatFrequency || '').trim()) || (/^(daily|weekly|monthly|yearly)$/i.test(String(sch.repeatFrequency || '')) ? [null, '1', String(sch.repeatFrequency)[0]] : null);
      const days = [].concat(sch.byDay || []).map((d) => DAY_URL.exec(String(d))).filter(Boolean).map((m) => WEEKDAY_NAMES.findIndex((w) => w.toLowerCase() === m[1].toLowerCase()));
      if (first && (freqM || days.length)) {
        const F = { D: 'DAILY', W: 'WEEKLY', M: 'MONTHLY', Y: 'YEARLY' }[(freqM ? freqM[2] : 'W').toUpperCase()];
        const time = /^(\d{2}):(\d{2})/.exec(String(sch.startTime || '')) ? String(sch.startTime).slice(0, 5) : first.time;
        const endTime = /^(\d{2}):(\d{2})/.exec(String(sch.endTime || '')) ? String(sch.endTime).slice(0, 5) : null;
        let date = first.date;
        if (F === 'WEEKLY' && days.length) {
          // the first listed weekday on or after the schedule's start
          for (let k = 0; k < 7; k++) {
            const dd = addDays(first.date, k);
            if (days.includes(weekdayOf(...dd.split('-').map(Number)))) {
              date = dd;
              break;
            }
          }
        }
        const parts = [`FREQ=${F}`];
        if (freqM && +freqM[1] > 1) parts.push(`INTERVAL=${+freqM[1]}`);
        if (F === 'WEEKLY' && days.length) parts.push(`BYDAY=${days.map((d) => DAY_CODES[d]).join(',')}`);
        start = { date, time, offset: first.offset };
        end = endTime && time ? { date, time: endTime, offset: first.offset } : null;
        const until = schemaTime(sch.endDate);
        if (+sch.repeatCount > 0) parts.push(`COUNT=${+sch.repeatCount}`);
        else if (until) parts.push(`UNTIL=${until.date.replace(/-/g, '')}`);
        recurrence = { rrule: parts.join(';') };
      }
    }
    if (!start) continue;
    const allDay = !start.time;
    let zone = null;
    if (!allDay) {
      const place = s.location ? zoneOfPlace(s.location) : null;
      const dz = docZone && docZone.zone;
      if (start.offset != null) {
        const [y, m, d] = start.date.split('-').map(Number);
        const [h, mi] = start.time.split(':').map(Number);
        const ms = Date.UTC(y, m - 1, d, h, mi) - start.offset * 60000;
        const fits = (z) => z && !isFixedZone(z) && offsetAt(z, ms) === start.offset;
        zone = place || [dz, opts.timeZone].find(fits) || opts.timeZone || offsetZone(start.offset);
      } else zone = place || dz || opts.timeZone || null;
    }
    const ev = {
      title: s.name || 'Event',
      start: structuredTime(start, zone),
      end: null,
      allDay,
      timeZone: allDay ? null : zone,
      location: s.location,
      recurrence: null,
      description: s.description || '',
      url: s.url,
      confidence: 0.95,
      structured: true,
      sources: {},
    };
    if (allDay) {
      const last = end && end.date >= start.date ? end.date : start.date;
      ev.end = addDays(last, 1);
    } else if (end && end.time) {
      ev.end = structuredTime(end, zone);
      if (ev.end <= ev.start) ev.end = addMinutes(ev.start, defMin);
    } else {
      const dur = isoMinutes(s.duration);
      ev.end = addMinutes(ev.start, dur || defMin);
      if (!dur) ev.endInferred = true;
    }
    if (recurrence) {
      let r = recurrence.rrule;
      const u = /UNTIL=(\d{8})/.exec(r);
      if (u && !allDay && zone) r = r.replace(u[0], `UNTIL=${isoToUtc(`${u[1].slice(0, 4)}-${u[1].slice(4, 6)}-${u[1].slice(6, 8)}T23:59`, zone).replace(/[-:]/g, '').replace(/00Z$/, '59Z')}`);
      ev.recurrence = r;
    }
    Object.defineProperty(ev, '_how', { value: 'schema', enumerable: false });
    Object.defineProperty(ev, '_lines', { value: [], enumerable: false });
    if (!out.some((x) => x.start === ev.start && sameish(x.title, ev.title))) out.push(ev);
  }
  return out;
}

// Structured events win; a text event about the same one (same start, or the same day and a
// like title) adds what the markup lacked (an end, a place, a description) and goes.
function mergeStructured(textEvents, structured) {
  if (!structured.length) return textEvents;
  const rest = textEvents.slice();
  for (const s of structured) {
    const day = datePart(s.start);
    const i = rest.findIndex((t) => t.start === s.start || (datePart(t.start) === day && (sameish(t.title, s.title) || t.allDay || s.allDay || (t.endInferred && timePart(t.start) === timePart(s.start)))));
    if (i < 0) continue;
    const t = rest[i];
    rest.splice(i, 1);
    if (!s.location && t.location) s.location = t.location;
    if (!s.description && t.description) s.description = t.description;
    if (!s.url && t.url) s.url = t.url;
    if (s.endInferred && !t.endInferred && !t.allDay && t.start === s.start && t.end) {
      s.end = t.end;
      delete s.endInferred;
    }
    if (!s.recurrence && t.recurrence && t.start === s.start) s.recurrence = t.recurrence;
    if (t.sources) s.sources = { ...t.sources };
  }
  return [...structured, ...rest].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/**
 * findEvents(textOrLayout, { dialect, now, timeZone, defaultDuration (minutes, 60) })
 *   textOrLayout: a string, a Layout (extractLayout), or a Doc extracted with { layout: true }.
 */
export function findEvents(input, opts = {}) {
  const L = toLayout(input);
  const ents = findEntities(L, opts);
  const B = new Builder(L, ents, opts);
  let events = B.run();
  // a web page's schema.org events (JSON-LD, microdata) say exactly when and where; what the
  // text says about the same events is merged into them, other events in the text stay
  if (L.schema && L.schema.length) events = mergeStructured(events, structuredEvents(L.schema, opts, B.docZone));
  return withOverlays(L, events, opts);
}

function withOverlays(L, events, opts) {
  // The page comes first. A popup laid over it is read when the page itself has no event, or
  // when the page is a calendar (a month or week grid): a calendar's event popover says in
  // full what the grid's chip under it shortens, so the two are one event, the popover's.
  if (!L.overlays || !L.overlays.some((o) => o.atoms && o.atoms.length)) return events;
  const pageHad = events.length > 0;
  let added = false;
  for (const o of L.overlays) {
    if (!o.atoms || !o.atoms.length) continue;
    if (pageHad && !calendarGrid(L, o.page)) continue;
    const pg = L.pages.find((p) => p.page === o.page) || { page: o.page };
    const Lo = layoutFromPages([{ ...pg, source: 'ocr', atoms: o.atoms }], { kind: L.kind, title: L.title });
    for (const e of new Builder(Lo, findEntities(Lo, opts), opts).run()) {
      Object.assign(e, { overlay: true, sources: {} });
      const day = datePart(e.start);
      const i = events.findIndex((g) => !g.overlay && datePart(g.start) === day && (g.start === e.start || sameish(g.title, e.title) || (g.allDay && !e.allDay)));
      if (i >= 0) {
        const g = events[i];
        if (!e.location && g.location) e.location = g.location;
        if (e.endInferred && !g.endInferred && g.start === e.start && !g.allDay) {
          e.end = g.end;
          delete e.endInferred;
        }
        events.splice(i, 1);
      }
      events.push(e);
      added = true;
    }
  }
  return added ? events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)) : events;
}

// A calendar app's grid on a page: a row of weekday names and nothing else ('Sun Mon Tue ...',
// 'SUN 18 MON 19 ...'), or a month's day numbers in cells.
const WEEKDAY_WORD = /\b(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?\b\.?/gi;
function calendarGrid(L, page) {
  const lines = L.lines.filter((l) => l.page === page);
  const rows = new Map();
  for (const l of lines) {
    const k = l.row >= 0 ? l.row : `l${l.start}`;
    rows.set(k, (rows.get(k) || '') + ' ' + l.text);
  }
  let numbers = 0;
  // (a header whose day names were read as separate lines, side by side)
  const lone = lines.filter((l) => l.box && /^\s*(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?\.?\s*$/i.test(l.text));
  if (lone.some((a) => lone.filter((b) => Math.abs(b.box.y0 + b.box.y1 - a.box.y0 - a.box.y1) < Math.max(1, a.box.y1 - a.box.y0)).length >= 5)) return true;
  for (const t of rows.values()) {
    const days = t.match(WEEKDAY_WORD) || [];
    if (days.length >= 5 && !/\p{L}/u.test(t.replace(WEEKDAY_WORD, ''))) return true;
    for (const tok of t.trim().split(/\s+/)) if (/^(?:[1-9]|[12]\d|3[01])$/.test(tok)) numbers++;
  }
  return numbers >= 20;
}

class Builder {
  constructor(L, ents, opts) {
    this.L = L;
    this.text = L.text;
    this.opts = opts;
    this.defaultMin = opts.defaultDuration > 0 ? opts.defaultDuration : 60;
    this.ents = ents;
    this.used = new Set(); // entities consumed
    this.events = [];
    for (const e of ents) {
      e.line = e.line >= 0 ? e.line : this.lineAt(e.start);
      e.lastLine = this.lineAt(Math.max(e.start, e.end - 1));
      e.shape = shapeOf(e);
    }
    this.temporal = ents.filter((e) => TEMPORAL.has(e.type));
    this.markContext();
    this.docZone = this.findDocZone();
    this.subject = this.findSubject();
  }

  lineAt(off) {
    const lines = this.L.lines;
    let lo = 0;
    let hi = lines.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= off) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }

  line(i) {
    return this.L.lines[i];
  }

  // the text of a line's whole visual row
  rowText(i) {
    const l = this.line(i);
    if (!l || l.row < 0 || !this.L.rows[l.row]) return l ? l.text : '';
    return this.L.rows[l.row].lines.map((k) => this.line(k).text).join('\t');
  }

  // the entities overlapping [s, e), in their order. Through 256-character buckets: callers ask
  // about every line, and a chat export has tens of thousands of entities.
  entsIn(s, e, pred) {
    const B = 256;
    if (!this.entBuckets) {
      this.entBuckets = new Map();
      this.ents.forEach((x, i) => {
        for (let b = Math.floor(x.start / B), b1 = Math.floor(Math.max(x.start, x.end - 1) / B); b <= b1; b++) {
          if (!this.entBuckets.has(b)) this.entBuckets.set(b, []);
          this.entBuckets.get(b).push(i);
        }
      });
    }
    const b0 = Math.floor(s / B);
    const b1 = Math.floor(Math.max(s, e - 1) / B);
    if (b1 - b0 > this.entBuckets.size) return this.ents.filter((x) => x.start < e && x.end > s && (!pred || pred(x)));
    const idx = [];
    for (let b = b0; b <= b1; b++) {
      for (const i of this.entBuckets.get(b) || []) {
        const x = this.ents[i];
        // each entity once: in the first bucket it shares with the range
        if (x.start < e && x.end > s && Math.max(b0, Math.floor(x.start / B)) === b) idx.push(i);
      }
    }
    if (idx.length > 1) idx.sort((p, q) => p - q);
    const out = [];
    for (const i of idx) if (!pred || pred(this.ents[i])) out.push(this.ents[i]);
    return out;
  }

  // email headers, deadlines, chat timestamps, 'yesterday': context, not events
  markContext() {
    const T = this.text;
    const emailish = /^[ \t]*(?:from|to|subject|cc)[ \t]*:/im.test(T);
    // a move: 'move our 1:1 from Monday 10/19 to Tuesday 10/20', 'moved from Oct 24 to Oct 31':
    // only the new day is the event
    for (const e of this.temporal) {
      if (e.type !== 'daterange' && !(e.type === 'timerange' && e.days)) continue;
      const before = T.slice(Math.max(0, e.start - 80), e.start);
      if (!/\bfrom[ \t]*$/i.test(before) || !/\b(?:move|moving|moved|reschedul\w*|push(?:ing|ed)?|shift(?:ing|ed)?|bump(?:ing|ed)?|chang(?:e|ing|ed)|switch(?:ing|ed)?)\b[^.!?\n]*$/i.test(before)) continue;
      if (e.type === 'daterange') e.value = { start: e.value.end, end: e.value.end };
      else {
        e.value = { ...e.value, start: `${e.days.end}T${timePart(e.value.start)}`, end: e.value.end && hasT(e.value.end) ? `${e.days.end}T${timePart(e.value.end)}` : e.value.end };
        e.days = null;
      }
      e.moved = true;
    }
    // what is asked of a row, once per row (a long line holds thousands of entities)
    const rows = new Map();
    const rowOf = (i) => {
      let r = rows.get(i);
      if (!r) {
        const text = this.rowText(i);
        const flat = text.replace(/\t/g, ' ');
        rows.set(i, (r = { text, sender: SENDER_LINE.test(flat) && !NOUN_RE.test(flat.replace(/\b(?:today|yesterday)\b.*$/i, '')), end: text.trimEnd() }));
      }
      return r;
    };
    for (const e of this.temporal) {
      const l = this.line(e.line);
      if (!l) continue;
      const lineText = l.text;
      const before = T.slice(Math.max(l.start, e.start - 60), e.start);
      const row = rowOf(e.line);
      const rowText = row.text;
      // a message's own date: 'Sent: ...', a header row with the sender's address, '(1 day ago)'
      const headerRow = e.shape === 'moment' && /\b(?:19|20)\d{2}\b/.test(e.text) && (/\S+@\S+\.\w{2,}/.test(rowText) || /\(\s*\d+\s+(?:minutes?|hours?|days?|weeks?)\s+ago\s*\)/i.test(rowText));
      // a chat export's stamp on every message: '[10/16/26, 8:14:02 PM] Dana: ...',
      // '16/10/2026, 20:14 - Dana: ...'; a chat app's sender line: 'ana   Today at 6:05 PM'
      const stamp = CHAT_STAMP.exec(lineText);
      if (stamp && e.start >= l.start && e.end <= l.start + stamp[0].length) e.skip = 'timestamp';
      // (the name and the time may be read as two cells of a row: 'lee' | 'Today at 4:10 PM')
      else if (row.sender && (/^(?:today|yesterday)\b/i.test(e.text) || row.end.endsWith(e.text))) e.skip = 'timestamp';
      else if (HEADER_LINE.test(lineText) || headerRow || (emailish && /^[ \t]*(?:date)[ \t]*:/i.test(lineText) && /\b(?:19|20)\d{2}\b/.test(lineText) && e.shape === 'moment')) e.skip = 'header';
      // a memo's or letter's own date: 'To: All staff   From: Operations   Date: November 2'
      else if (/\bdate[ \t]*:[ \t]*$/i.test(before) && /\b(?:to|from|cc|re|subject|memo)[ \t]*:/i.test(rowText.replace(/\bdate[ \t]*:.*$/i, ''))) e.skip = 'header';
      // opening hours by weekday ('Open Mon-Thu 10-8', 'Hours: Mon-Fri 9am-5pm'), not events
      else if (/\b(?:open|opening\s+hours|hours(?:\s+of\s+operation)?)\b[ \t:]*$/i.test(before) && !/\boffice\s+hours[ \t:]*$/i.test(before) && /\b(?:mon|tue|wed|thu|fri|sat|sun)/i.test(e.text) && !/\d{1,2}[/.-]\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i.test(e.text)) e.skip = 'hours';
      // a calendar's day header or a day picker: 'Sun Mon Tue Wed Thu Fri Sat' and nothing else
      else if (e.type === 'weekday' && (() => {
        const [s0, e0] = l.row >= 0 && this.L.rows[l.row] ? [this.line(this.L.rows[l.row].lines[0]).start, this.line(this.L.rows[l.row].lines[this.L.rows[l.row].lines.length - 1]).end] : [l.start, l.end];
        const wds = this.entsIn(s0, e0, (x) => x.type === 'weekday' && TEMPORAL.has(x.type) && x.start >= s0 && x.end <= e0);
        let rest = T.slice(s0, e0);
        for (const x of wds) rest = rest.slice(0, x.start - s0) + ' '.repeat(x.end - x.start) + rest.slice(x.end - s0);
        return (wds.length >= 3 && !/[\p{L}\p{N}]/u.test(rest)) || this.dayHeaderLines().has(e.line);
      })()) e.skip = 'day-header';
      // how often something is sent, not an event's rule: 'Weekly reminder: 1 day before',
      // 'Daily digest', 'monthly newsletter'
      else if (e.type === 'recurrence' && /^\s*(?:reminders?|notifications?|alerts?|digests?|newsletters?|emails?|summary|summaries|reports?|updates?|backups?)\b/i.test(T.slice(e.end, e.end + 16))) e.skip = 'not-rule';
      // a day's name that the date after it says: 'All Saints' Sunday is November 1'
      else if (e.type === 'weekday' && this.entsIn(e.end, e.end + 120, (x) => TEMPORAL.has(x.type)).some((x) => x !== e && isDateShape(x.shape) && x.type !== 'weekday' && x.start > e.end && /^\s+(?:is|falls\s+on|will\s+be|this\s+year\s+is)\s+$/i.test(T.slice(e.end, x.start)))) e.skip = 'named-day';
      // a chat's day separator ('TODAY' alone on its line)
      else if (e.type === 'date' && e.relative && lineText.trim().length <= e.text.length + 1 && !/\t/.test(rowText)) e.skip = 'separator';
      // the day someone is back ('back in the office Monday the 9th'), not an event
      else if (e.shape === 'date' && /\b(?:back|returning|return)(?:\s+(?:in|to|at)\s+(?:the\s+)?(?:office|work|school|desk))?(?:\s+on)?[ \t]*$/i.test(before)) e.skip = 'return';
      else if (DEADLINE.test(before)) e.skip = 'deadline';
      else if (/\byesterday\b/i.test(e.text)) e.skip = 'past';
      else if (e.shape === 'moment' || e.shape === 'time') {
        // a message's timestamp: a time to the minute, alone on its line ('Today 9:41 AM')
        const v = typeof e.value === 'string' ? e.value : e.value.start;
        const mins = +(v.slice(-2));
        const alone = lineText.trim().length <= e.text.length + 12 && !/\t/.test(this.rowText(e.line));
        if (alone && mins % 5 !== 0) e.skip = 'timestamp';
        if (alone && /^(?:today|yesterday|now)\b/i.test(lineText.trim()) && /\d:\d\d/.test(e.text) && mins % 5 !== 0) e.skip = 'timestamp';
      }
    }
  }

  // A grid's day header read as separate lines (each 'SUN', 'MON', ... in its own column):
  // lines that are only a weekday name, three or more of them side by side.
  dayHeaderLines() {
    if (this._dayHeader) return this._dayHeader;
    const out = new Set();
    const lone = this.L.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.box && /^\s*(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?\.?\s*$/i.test(l.text));
    for (const a of lone) {
      const cy = (a.l.box.y0 + a.l.box.y1) / 2;
      const h = Math.max(1, a.l.box.y1 - a.l.box.y0);
      const side = lone.filter((b) => b.l.page === a.l.page && Math.abs((b.l.box.y0 + b.l.box.y1) / 2 - cy) < 0.5 * h);
      if (side.length >= 3) out.add(a.i);
    }
    this._dayHeader = out;
    return out;
  }

  findDocZone() {
    // 'All times are Eastern', 'Time zone: CET', '(times in ET)'
    for (const e of this.ents) {
      if (e.type !== 'timezone') continue;
      return { zone: e.value, span: [e.start, e.end] };
    }
    // one zone named by most timed entities
    const zones = new Map();
    for (const e of this.temporal) if (e.timeZone) zones.set(e.timeZone, (zones.get(e.timeZone) || 0) + 1);
    if (zones.size === 1) return { zone: [...zones.keys()][0], span: null, fromTimes: true };
    return null;
  }

  findSubject() {
    const m = /^[ \t]*(?:subject|re|title|event)[ \t]*:[ \t]*(\S[^\n]*)$/im.exec(this.text);
    if (!m) return null;
    const s = m.index + m[0].indexOf(m[1]);
    const t = cleanTitle(m[1]);
    return goodTitle(t) ? { text: t, span: [s, s + m[1].length] } : null;
  }

  run() {
    this.prepareRules();
    this.flightEvents();
    this.tableEvents();
    this.agendaEvents();
    this.formEvents();
    this.textEvents();
    this.orphanTimes();
    return this.finish();
  }

  // Recurrences take their bounds from the same line ('until Dec 10', 'starting Nov 2') or
  // from the document's term ('Classes run Sep 28 - Dec 4'); those dates are then context.
  prepareRules() {
    const rules = this.temporal.filter((e) => e.shape === 'rule' && !e.skip);
    if (!rules.length) return;
    const terms = this.temporal.filter((e) => e.shape === 'days' && !e.skip && !e.weekdays && this.line(e.line) && TERM_LINE.test(this.line(e.line).text) && !this.entsIn(this.line(e.line).start, this.line(e.line).end, (x) => x.shape === 'rule').length);
    for (const r of rules) {
      const v = r.value;
      let from = v.from;
      let until = v.until;
      const l = this.line(r.line);
      if (!l) continue;
      for (const d of this.entsIn(l.start, l.end, (x) => x.shape === 'date' && x !== r && !x.skip && !x.relative)) {
        const before = this.text.slice(Math.max(l.start, d.start - 18), d.start);
        if (!until && /\b(?:until|till|til|through|thru|to|ending|ends|last\s+(?:class|session|meeting))\s*(?:on)?\s*$/i.test(before)) {
          until = d.value;
          this.useAsContext(d);
        } else if (!from && /\b(?:starting|beginning|from|begins|starts|commencing|first\s+(?:class|session|meeting))\s*(?:on)?\s*$/i.test(before)) {
          from = d.value;
          this.useAsContext(d);
        }
      }
      // a date range on a line of its own just by the rule: 'Tuesdays 7-8:30 PM' / 'Oct 20 - Dec 8'
      const around = [];
      for (let i = Math.max(0, r.line - 3); i <= r.line + 3 && i < this.L.lines.length; i++) around.push(i);
      const near = this.temporalOnLines(around).filter((e) => e.shape === 'days' && !e.skip && !e.weekdays && !e.context && Math.abs(e.line - r.line) <= 3 && this.line(e.line) && this.lineWithoutTemporal(e.line).text.replace(/[^\p{L}]+/gu, ' ').trim().split(/\s+/).filter(Boolean).length <= 2);
      const pool = [...terms, ...near.filter((e) => !terms.includes(e))];
      if (!from && !until && !v.count && pool.length && (v.freq === 'WEEKLY' || v.freq === 'DAILY')) {
        const t = pool.sort((a, b) => Math.abs(a.line - r.line) - Math.abs(b.line - r.line))[0];
        from = t.value.start;
        until = t.value.end;
        this.useAsContext(t);
      }
      if (from !== v.from || until !== v.until) r.value = rebound(v, from, until);
    }
  }

  // the course a schedule belongs to: a line with a course code, or the document's first line
  courseName() {
    for (const l of this.L.lines.slice(0, 12)) {
      if (/\b[A-Z]{2,5}\s?\d{3,5}[A-Z]?\b/.test(l.text) && !this.entsIn(l.start, l.end, (x) => x.shape === 'rule' || x.shape === 'moment').length) {
        const t = tidy(l.text.replace(/\s*[—–-]?\s*\(?(?:(?:autumn|fall|spring|summer|winter)\s+(?:quarter|semester|term)?\s*\d{4}|(?:autumn|fall|spring|summer|winter)\s+(?:quarter|semester|term)|\d{4}(?:[–-]\d{2,4})?)\)?\s*$/i, ''));
        if (t) return { text: t, span: [l.start, l.end] };
      }
    }
    return null;
  }

  /* ---------- timing from entities ---------- */

  // anchor: a date-bearing entity; time/end: time-only entities to combine with it
  timing(anchor, time, end, extra = {}) {
    const zoneE = [time, anchor, end].find((x) => x && x.timeZone);
    const zone = zoneE ? zoneE.timeZone : this.docZone ? this.docZone.zone : this.opts.timeZone || null;
    const sources = {};
    const span = (x) => (x ? [x.start, x.end] : undefined);
    const out = { allDay: false, start: null, end: null, recurrence: null, timeZone: zone, sources, conf: 1, endInferred: false };
    // a weekday written with a date it does not fit ('Thursday, November 6, 2026' is a Friday)
    const odd = [anchor, time, end].find((x) => x && x.weekdayMismatch);
    if (odd) {
      const v = typeof odd.value === 'string' ? odd.value : odd.value && (odd.value.start || odd.value.end);
      out.weekdayMismatch = { written: odd.weekdayWritten || null, date: v ? datePart(v) : null, span: [odd.start, odd.end] };
    }
    const confOf = (x) => (x ? x.confidence : 1);
    out.conf = Math.min(confOf(anchor), confOf(time), confOf(end));
    if (zoneE && zoneE.timeZone) sources.timeZone = span(zoneE);
    else if (this.docZone && this.docZone.span) sources.timeZone = this.docZone.span;
    const s = anchor.shape;
    let date = null;
    let days = null;
    let rule = null;
    let t0 = null;
    let t1 = null;
    let openEnd = null;
    if (s === 'date') date = anchor.type === 'weekday' ? anchor.date : anchor.value;
    else if (s === 'days') days = anchor.value;
    else if (s === 'moment') {
      if (anchor.type === 'datetime') {
        date = datePart(anchor.value);
        t0 = timePart(anchor.value);
      } else {
        date = datePart(anchor.value.start);
        t0 = timePart(anchor.value.start);
        if (anchor.value.end) t1 = anchor.value.end;
        if (anchor.days) days = anchor.days;
        if (anchor.open) openEnd = anchor.open;
      }
    } else if (s === 'rule') {
      rule = anchor.value;
      date = rule.start;
      if (rule.time) {
        t0 = rule.time.start;
        if (rule.time.end) t1 = rule.time.end;
      }
    }
    sources.start = span(anchor);
    if (time && !t0) {
      const v = time.value;
      t0 = typeof v === 'string' ? v : v.start;
      if (typeof v !== 'string' && v.end) t1 = v.end;
      if (time.open) openEnd = time.open;
      sources.start = span(anchor);
      sources.time = span(time);
      if (typeof v !== 'string' && v.end) sources.end = span(time);
    }
    if (end) {
      const v = typeof end.value === 'string' ? end.value : end.value.start;
      if (hasT(v)) t1 = v;
      else if (/^\d{2}:\d{2}$/.test(v)) t1 = v;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !t0) days = { start: date || (days && days.start), end: v };
      sources.end = span(end);
    }
    if (t1 && !sources.end) sources.end = sources.time || sources.start;
    // days with hours: a daily event over the span ('Nov 6-8, 10am-6pm')
    if (days && t0) {
      const n = daysBetween(days.start, days.end) + 1;
      date = days.start;
      if (n > 1 && !rule) rule = { rrule: `FREQ=DAILY;COUNT=${n}`, daily: true };
      days = null;
    }
    if (!t0) {
      // all day
      out.allDay = true;
      if (days) {
        out.start = days.start;
        out.end = addDays(days.end, 1);
      } else {
        out.start = date;
        out.end = date ? addDays(date, 1) : null;
      }
      if (rule) out.recurrence = this.rruleFor(rule, true, zone);
      out.timeZone = null;
      if (out.start && extra.allDayOk === false) return null;
      return out.start ? out : null;
    }
    // a bare weekday ('Saturday' in a timetable) whose time has passed today: next week's
    if (!rule && (anchor.type === 'weekday' || anchor.weekday) && !days) {
      const now = this.nowParts();
      if (date === now.iso && t0 < now.time) date = addDays(date, 7);
    }
    out.start = `${date}T${t0}`;
    if (t1) {
      const endIso = hasT(t1) ? t1 : `${date}T${t1}`;
      out.end = endIso > out.start ? endIso : `${addDays(date, 1)}T${timePart(endIso)}`;
    } else {
      out.end = addMinutes(out.start, openEnd ? 180 : extra.until && extra.until > out.start ? minutesBetween(out.start, extra.until) : this.defaultMin);
      out.endInferred = true;
    }
    if (rule) out.recurrence = this.rruleFor(rule, false, zone);
    return out;
  }

  // RRULE with UNTIL in the form iCalendar wants for the event's DTSTART
  rruleFor(rule, allDay, zone) {
    let r = rule.rrule;
    const m = /UNTIL=(\d{8})(?![T\d])/.exec(r);
    if (m && !allDay) {
      const day = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
      let until;
      if (zone) until = isoToUtc(`${day}T23:59`, zone).replace(/[-:]/g, '').replace(/00Z$/, '59Z');
      else until = `${m[1]}T235959`;
      r = r.replace(m[0], `UNTIL=${until}`);
    }
    return r;
  }

  /* ---------- titles, places ---------- */

  // the biggest heading above a line on its page (or anywhere on the page)
  headingFor(lineIdx, { page = null, region = null } = {}) {
    const L = this.L;
    const at = this.line(lineIdx);
    const pg = page != null ? page : at ? at.page : 1;
    const cands = [];
    if (!this._headingLines) this._headingLines = L.lines.flatMap((l, i) => (l.heading ? [i] : []));
    for (const i of this._headingLines) {
      const l = L.lines[i];
      if (l.page !== pg || !l.heading) continue;
      const t = this.lineWithoutTemporal(i);
      if (!goodTitle(cleanTitle(t.text))) continue;
      if (labelKey(l.text)) continue;
      // (a line of a message read big, 'my place (1418 E 57th St)', is no heading)
      if ((/^[a-z]/.test(t.text.trim()) || /^(?:i|i'?ll|i'?m|i'?d|we|we'?ll|we'?re|you|you'?ll|let'?s|can|could|would|will|should|are|is|do|does|ok|okay|yes|no|sure|thanks)\b/i.test(t.text.trim())) && l.source === 'ocr') continue;
      const addr = this.entsIn(l.start, l.end, (x) => x.type === 'location' && x.address);
      if (addr.length && addr.reduce((n, x) => n + x.end - x.start, 0) >= 0.4 * l.text.length) continue;
      cands.push({ i, l, t });
    }
    if (!cands.length) return null;
    // on a screenshot, a heading on the line's own card or dialog
    if (at && at.panel != null && at.panel >= 0) {
      const mine = cands.filter((c) => c.l.panel === at.panel);
      if (mine.length) cands.splice(0, cands.length, ...mine);
    }
    // prefer the most prominent (lowest level, biggest size) above the line; join a title set
    // on two lines ('JAZZ' / 'IN THE PARK')
    cands.sort((a, b) => a.l.heading - b.l.heading || b.l.size - a.l.size || a.i - b.i);
    const best = cands.find((c) => !at || c.i <= lineIdx || c.l.heading === 1) || cands[0];
    let first = best.i;
    let last = best.i;
    const same = (k) => {
      const l = L.lines[k];
      return l && l.page === best.l.page && l.heading && l.size >= 0.6 * best.l.size && l.size <= 1.67 * best.l.size && !this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type)).length;
    };
    while (same(first - 1) && first - 1 >= 0 && best.l.box && L.lines[first - 1].box.y1 >= best.l.box.y0 - 1.6 * best.l.size) first--;
    while (same(last + 1) && L.lines[last + 1].box.y0 <= L.lines[last].box.y1 + 1.6 * best.l.size) last++;
    const parts = [];
    for (let k = first; k <= last; k++) parts.push(this.line(k).text);
    const text = cleanTitle(parts.join(' '));
    return { text, span: [this.line(first).start, this.line(last).end] };
  }

  // a line with its dates and times taken out (for titles)
  lineWithoutTemporal(i) {
    const l = this.line(i);
    let t = l.text;
    const ents = this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'timezone' || x.type === 'duration' || x.type === 'url' || x.type === 'phone' || x.type === 'email');
    for (const x of ents.sort((a, b) => b.start - a.start)) {
      const s = Math.max(0, x.start - l.start);
      const e = Math.min(t.length, x.end - l.start);
      t = t.slice(0, s) + ' '.repeat(e - s) + t.slice(e);
    }
    return { text: t, start: l.start };
  }

  // A title from the words beside the date: in its sentence ('Team lunch Friday at noon',
  // 'your check-up on Thu 05/11 with Dr Okafor'), else the sentence before or after it on the
  // same line ('Booking confirmed: Hamlet at The Old Vic. Thursday 5 November, 7.30pm.').
  titleNear(anchor) {
    const l = this.line(anchor.line);
    if (!l) return null;
    const T = this.text;
    const row = l.row >= 0 ? this.L.rows[l.row] : null;
    let rowStart = row ? this.line(row.lines[0]).start : l.start;
    let rowEnd = row ? this.line(row.lines[row.lines.length - 1]).end : l.end;
    // a sentence wrapped over lines (a chat bubble, a paragraph in a picture or PDF): the lines
    // around it that carry it on
    const positioned = this.L.pages.some((p) => p.unit !== 'char');
    const joins = (a, b) => {
      if (!a || !b || a.page !== b.page || a.region !== b.region || /[.!?:]["”’)]?\s*$/.test(a.text) || labelKey(b.text) || /^[ \t]*[A-Za-z][\w ]{0,20}:/.test(b.text)) return false;
      // (a header line, 'To: All staff  From: Operations  Date: ...', does not run on)
      if (/^[ \t]*(?:to|from|cc|date|subject|re|sent|memo)[ \t]*:/i.test(a.text)) return false;
      // (nor a sender's name over their message in a chat bubble: 'Lea' / 'We meet Wed...')
      if (/^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/.test(a.text.trim()) && /^[A-Z]/.test(b.text.trim())) return false;
      // (a list item starts afresh)
      if (/^\s*(?:[-•*·–—]|\d{1,2}[.)])\s/.test(b.text)) return false;
      if ((a.row >= 0 && this.L.rows[a.row].lines.length > 1) || (b.row >= 0 && this.L.rows[b.row].lines.length > 1)) return false;
      if (positioned) return b.box.y0 - a.box.y1 < 0.8 * Math.max(a.size, b.size) && Math.abs(a.size - b.size) < 0.25 * Math.max(a.size, b.size);
      return a.text.length >= 50 && !/\n[ \t]*\n/.test(this.text.slice(a.end, b.start));
    };
    if (!row || row.lines.length === 1) {
      for (let k = 0, i = anchor.line; k < 2 && joins(this.line(i - 1), this.line(i)); k++, i--) rowStart = this.line(i - 1).start;
      for (let k = 0, i = anchor.line; k < 2 && joins(this.line(i), this.line(i + 1)); k++, i++) rowEnd = this.line(i + 1).end;
    }
    const raw = T.slice(rowStart, rowEnd);
    const sents = splitSentences(raw).map((x) => ({ start: rowStart + x.start, end: rowStart + x.end }));
    if (!sents.length) sents.push({ start: rowStart, end: rowEnd });
    let k = sents.findIndex((x) => x.start <= anchor.start && anchor.start < x.end + 1);
    if (k < 0) k = 0;
    const own = sents[k];
    if (own.end < anchor.end) own.end = Math.min(rowEnd, anchor.end);
    const skipTypes = (x) => TEMPORAL.has(x.type) || x.type === 'timezone' || x.type === 'duration' || x.type === 'url' || x.type === 'phone' || x.type === 'email';
    const fromSentence = (sn, isOwn) => {
      const ents = this.entsIn(sn.start, sn.end, skipTypes).sort((a, b) => a.start - b.start);
      const first = isOwn ? anchor : ents[0];
      const preEnd = first ? Math.max(sn.start, Math.min(first.start, isOwn ? anchor.start : first.start)) : sn.end;
      // (other dates before the anchor in the same sentence are not title words; 'Daily' in
      // 'Daily standup' is)
      // (nor is a day's name the date says: 'All Saints' Sunday is November 1')
      const pre = blank(T.slice(sn.start, preEnd), ents.filter((x) => x.end <= preEnd && !(x.type === 'recurrence' && /^\w+$/.test(x.text)) && x.skip !== 'named-day'), sn.start);
      const pieces = pre.split('\t');
      const piece = pieces[pieces.length - 1];
      const base = preEnd - piece.length;
      let cand = cleanTitle(stripAt(piece));
      let span = [base, base + piece.length];
      // a short name that is no event word keeps its venue: 'NYE at The Promontory',
      // 'Friendsgiving at Sam's' (but 'Dinner at Luigi's' is a dinner; the place is the location)
      const venue = /^(.*?\S)\s+(?:at|@)\s+([A-Z][\p{L}\p{N}'’&.-]*(?:\s+[A-Z][\p{L}\p{N}'’&.-]*){0,3})[^\p{L}\p{N}]*$/u.exec(piece.trim());
      if (venue && goodTitle(cand) && cand.split(/\s+/).length <= 2 && !NOUN_RE.test(cand) && cleanTitle(venue[1]) === cand) {
        cand = `${cand} at ${venue[2]}`;
        // (the venue is still the event's place: the title's span stops before it)
        span = [base, base + piece.indexOf(venue[1]) + venue[1].length];
      }
      // what follows the date may finish the title: 'with Dr Okafor', 'for the Thanksgiving holiday'
      if (isOwn && goodTitle(cand)) {
        const lastEnd = Math.max(anchor.end, ...ents.filter((x) => x.start >= anchor.start && x.start - anchor.end < 4).map((x) => x.end));
        const after = T.slice(lastEnd, sn.end);
        const tail = /^\s*,?\s*((?:with\s+(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)?\s*[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,2})|(?:for\s+(?:the\s+|our\s+|a\s+)?[\w'’-]+(?:\s+[\w'’-]+){0,3}?))(?=\s*(?:[.!?,;]|$))/.exec(after);
        if (tail && !/\b(?:minutes?|hours?|early|more|info|details|tickets?)\b/i.test(tail[1]) && cand.split(/\s+/).length <= 6) {
          cand = `${cand} ${tail[1]}`;
          span = [span[0], lastEnd + tail[0].length];
        }
      }
      // a question about the plan ('are we still on for dinner', 'do you want to get lunch'):
      // its event word
      if (goodTitle(cand) && /^(?:are|r|is|do|did|can|could|should|shall|would|will|wanna|want\s+to)\s+(?:we|you|u|ya|y'?all|they|it|the|our)\b/i.test(cand)) {
        const np = nounPhrase(cand);
        if (np) return { text: np.text, span, weak: false };
      }
      if (goodTitle(cand) && cand.split(/\s+/).length > 6) {
        // a long lead-in ('Book club this month is at my place'): its event word if it has one
        const np = nounPhrase(cand);
        if (np && np.text.split(/\s+/).length <= 5) return { text: np.text, span, weak: false };
      }
      if (goodTitle(cand) && cand.split(/\s+/).length <= 9) return { text: capFirst(cand), span, weak: cand.split(/\s+/).length > 6 };
      // a chat line: its event word
      const np = nounPhrase(blank(T.slice(sn.start, sn.end), ents, sn.start));
      if (np) return { text: np.text, span: [sn.start + np.s, sn.start + np.e], weak: false };
      if (!isOwn) {
        const whole = cleanTitle(stripAt(blank(T.slice(sn.start, sn.end), ents, sn.start)));
        if (goodTitle(whole) && whole.split(/\s+/).length <= 7 && !ents.length) return { text: capFirst(whole), span: [sn.start, sn.end], weak: true };
        return null;
      }
      // the words after the dates
      const lastEnt = ents[ents.length - 1];
      const post = lastEnt ? T.slice(Math.min(sn.end, lastEnt.end), sn.end) : '';
      const c2 = cleanTitle(stripAt(post.split('\t')[0]));
      if (goodTitle(c2) && c2.split(/\s+/).length <= 9 && !/^(?:at|in|on|@)\b/i.test(tidy(post))) return { text: capFirst(c2), span: [lastEnt.end, lastEnt.end + post.length], weak: true };
      return null;
    };
    let t = fromSentence(own, true);
    if (!t) {
      // the sentence before ('Booking confirmed: Hamlet at The Old Vic.'), else after; not an
      // instruction ('Bring snacks!', 'Reply YES to confirm.')
      for (const j of [k - 1, k + 1]) {
        if (!sents[j]) continue;
        const o = fromSentence(sents[j], false);
        if (o && !/^(?:bring|please|reply|call|text|email|rsvp|register|see|let|come|join|don'?t|do|make|get|buy|book|arrive|remember|note|wear|park|use|visit|check|click|tap|follow|share|tell|ask|send|pay|order|sign|enter|go|we'?ll|we will|you'?ll|i'?ll|it'?s|thanks?|thank)\b/i.test(o.text)) {
          t = { ...o, weak: true };
          break;
        }
      }
    }
    return t;
  }

  // The biggest plain line on a one-event page (no date, place, link or label in it): a poster
  // whose huge date makes everything else look small.
  prominentLine(a) {
    const la = this.line(a.line);
    let best = null;
    for (let i = 0; i < this.L.lines.length; i++) {
      const l = this.L.lines[i];
      if (!la || l.page !== la.page || l.text.length > 70) continue;
      if (this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'location' || x.type === 'url' || x.type === 'phone' || x.type === 'email').length) continue;
      if (labelKey(l.text) || inlineLabel(l.text)) continue;
      const t = cleanTitle(l.text);
      if (!goodTitle(t) || t.split(/\s+/).length > 8 || /^[a-z]/.test(t) || /[.!?]$/.test(l.text.trim())) continue;
      const score = (l.size || 1) * (l.bold ? 1.1 : 1) - i * 0.01;
      if (!best || score > best.score) best = { score, text: t, span: [l.start, l.end] };
    }
    return best ? { text: best.text, span: best.span, weak: true } : null;
  }

  // A short title-like line just above the date (plain text has no font sizes): the ticket's
  // 'The Midnight Owls — Live' above 'Sat, Nov 7, 2026'.
  lineTitleAbove(anchor) {
    const la = this.line(anchor.line);
    for (let i = anchor.line - 1, n = 0; i >= 0 && n < 3; i--, n++) {
      const l = this.line(i);
      if (!l || l.page !== la.page) break;
      const t = cleanTitle(l.text);
      if (!goodTitle(t) || t.split(/\s+/).length > 9 || /[,:;]$/.test(l.text.trim()) || /[.!?]$/.test(l.text.trim()) && t.split(/\s+/).length > 4) continue;
      if (labelKey(l.text) || /^[ \t]*[A-Za-z][\w ]{0,20}:/.test(l.text)) continue;
      if (this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'location' || x.type === 'phone' || x.type === 'url' || x.type === 'email').length) continue;
      if (/^[a-z]/.test(t) || /\b(?:order|total|confirmation|qty|subtotal|receipt|invoice)\b/i.test(l.text)) continue;
      return { text: t, span: [l.start, l.end], weak: false };
    }
    return null;
  }

  // Places near an event: labelled values, addresses, street corners, rooms, the words after
  // 'at' / '@' / 'in' ('dinner at Luigi's on Clark St'), an online meeting ('on Zoom'), and a
  // place left at the end of a date line ('..., 16:00-19:00, main hall').
  placeNear(anchor, lines, avoid = null) {
    const out = [];
    const T = this.text;
    for (const i of lines) {
      const l = this.line(i);
      if (!l) continue;
      // (who a letter or message is to or from: 'To: All residents of 5455 S Everett Ave')
      if (/^[ \t]*(?:to|from|cc|bcc|attn|attention|sender|recipient)[ \t]*:/i.test(l.text)) continue;
      for (const e of this.entsIn(l.start, l.end, (x) => x.type === 'location')) {
        // (the page's main heading names the event, not its place: 'Book Club', 'Global Town Hall')
        if (l.heading === 1 && !e.labelled) continue;
        out.push({ text: e.value, span: [e.start, e.end], score: e.labelled ? 5 : e.address ? 3.5 : e.corner ? 3 : 2, line: i, e });
      }
      const re = /(?:^|[\s(,])(at|@|in|inside|outside|visit|visits|visiting|tour|touring)\s+/gi;
      let m;
      while ((m = re.exec(l.text))) {
        const w = m[1].toLowerCase();
        // ('visit the Field Museum', not 'visit us' or 'visit our website')
        if (/^(?:visit|tour)/.test(w) && !/^(?:the\s+)?[A-Z]/.test(l.text.slice(m.index + m[0].length))) continue;
        // where someone is, not where the event is: "I'm in Seattle that week"
        if (w === 'in' && /\b(?:i'?m|i\s+am|we'?re|we\s+are|i'?ll\s+be|we'?ll\s+be|i\s+will\s+be|we\s+will\s+be|i\s+was|we\s+were|based|live|living|lives|staying|stuck|currently)\s*$/i.test(l.text.slice(0, m.index + 1))) continue;
        const s0 = l.start + m.index + m[0].length;
        let p = this.placePhrase(s0, l.end);
        if (!p) continue;
        // 'at the ASA annual meeting in Denver': the meeting is the event, Denver the place
        const inner = /^(.*\b(?:meeting|conference|convention|summit|congress|symposium|festival|retreat|expo|tournament|championships?|workshop|wedding|reunion|game|match)s?)\s+in\s+([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2})$/.exec(p.text);
        if (inner && w !== 'in') {
          const off = p.text.lastIndexOf(inner[2]);
          p = { text: inner[2], span: [p.span[0] + off, p.span[0] + off + inner[2].length] };
        }
        const visit = /^(?:visit|visits|visiting|tour|touring)$/.test(w);
        // (what follows an event is elsewhere: '... in the sanctuary, followed by a reception in
        // Fellowship Hall')
        const after = /\bfollowed\s+by\b|\bafterwards?\b|\bthen\b/i.test(T.slice(Math.max(l.start, anchor.end), p.span[0])) && p.span[0] > anchor.end;
        out.push({ ...p, score: (w === 'in' ? 2.3 : visit ? 2.2 : 2.7) - (after ? 0.6 : 0), line: i, visit });
      }
      // a place on or to the thing, said in lower case: 'at 1:45 pm on the blacktop', 'bring
      // canned goods to the narthex'
      const onTo = /\b(?:on\s+the|(?:bring|drop(?:\s+off)?|deliver|leave|return|meet|report|head|come)\b[^.!?\n]{0,40}?\bto\s+the)\s+(?=[a-z])/g;
      while ((m = onTo.exec(l.text))) {
        const s0 = l.start + m.index + m[0].length;
        const p = this.placePhrase(s0, l.end);
        if (p && PLACE_NOUN.test(p.text) && p.text.split(/\s+/).length <= 3) out.push({ ...p, score: 2.2, line: i });
      }
      // a street with no number (UK): 'The Red Lion, High Street'
      if (!this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'location').length && /\b(?:Street|Road|Lane|Avenue|Square|Green|Row|Way|Close|Crescent|Terrace|Drive|Boulevard|Parade|Market\s+Place|High\s+St)\.?$/.test(tidy(l.text)) && !/\b(?:food|coat|toy|blood|book|charity|donation|clothing|fundraising|membership|recruitment|canned\s+goods?)\s+drive$/i.test(tidy(l.text)) && placeLike(l.text) && !l.heading) {
        out.push({ text: tidy(l.text), span: [l.start, l.end], score: 2.6, line: i });
      }
      const on = /\b(?:on|via|over|using|join\s+(?:us\s+)?on)\s+(Zoom|Microsoft Teams|Teams|Google Meet|Meet|Skype|Discord|Webex|WebEx|FaceTime|Slack|Twitch|YouTube Live|YouTube)\b/g;
      while ((m = on.exec(l.text))) {
        const s = l.start + m.index + m[0].indexOf(m[1]);
        out.push({ text: m[1] === 'Teams' ? 'Microsoft Teams' : m[1], span: [s, s + m[1].length], score: 2.4, line: i });
      }
      // '..., 16:00-19:00, main hall.'
      const temps = this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'timezone');
      if (temps.length) {
        const last = Math.max(...temps.map((x) => x.end));
        const tail = /^\s*[,;|·•–—-]\s*([^,.;!?\t]{2,48}?)\s*[.!]?\s*$/.exec(T.slice(last, l.end));
        if (tail && (placeLike(tail[1]) || /^(?:the\s+)?same\s+(?:room|place|location|venue|spot|address)$/i.test(tidy(tail[1])))) {
          const s = last + tail[0].indexOf(tail[1]);
          out.push({ text: tidy(tail[1]), span: [s, s + tail[1].length], score: 2.5, line: i });
        }
      }
    }
    // never the title itself ('Hyde Park Book Fair'), never a date
    // (a place visited may be named in the title too: 'Year 5 will be visiting the Natural History Museum')
    return out.filter((p) => !avoid || p.visit || !(p.span[0] >= avoid[0] && p.span[1] <= avoid[1]));
  }

  // The place named from offset s on: up to the end of its clause.
  placePhrase(s, lineEnd) {
    const T = this.text;
    let e = lineEnd;
    const raw = T.slice(s, lineEnd);
    const stop = /[!?;:\t]|\.(?=\s+[A-Z]|\s*$)|\s[-–—|·•]\s|,\s+(?=[a-z])(?!(?:[a-z]+\s)?(?:room|hall|floor|field|suite)\b)|\s(?=(?:is|are|was|were|from|to|until|till|for|with|by|when|where|which|who|that|starting|beginning|between|this|next|tomorrow|tonight|today|every|each|so|but|then|if|please|and\s+(?:then|we|i|you|bring|it))\b)|\son\s(?=[a-z])/;
    const m = stop.exec(raw);
    if (m) e = s + m.index;
    const inside = this.entsIn(s, e, (x) => TEMPORAL.has(x.type) || x.type === 'timezone' || x.type === 'phone' || x.type === 'url' || x.type === 'email' || x.type === 'duration');
    if (inside.length) e = Math.min(e, ...inside.map((x) => x.start));
    let t = T.slice(s, e);
    const lead = /^\s*(?:the\s+)?/i.exec(t)[0];
    // (an emoji or a symbol after the name is no part of it: 'The Hideout 🦃')
    t = t.slice(lead.length).replace(/[\s,.;:]+$/, '').replace(/(?:\s+[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+)+$/u, '').replace(/\s+(?:on|at|the|and|of|&|in)$/i, '');
    if (!t || t.length > 70 || t.split(/\s+/).length > 9) return null;
    if (!/\p{L}/u.test(t) || /^\d+$/.test(t)) return null;
    if (/^(?:same|time|night|noon|midnight|home|work|least|most|all|first|last|end|beginning|start|latest|earliest|least|advance|person|total|full|stock|town|time\s+for|my|your|our|his|her|their|a|an|it|this|that|least|once)\b/i.test(t)) return null;
    if (/^[a-z]/.test(t) && !PLACE_NOUN.test(t)) return null;
    return { text: t, span: [s + lead.length, s + lead.length + t.length] };
  }

  /* ---------- 1. tables ---------- */

  tableEvents() {
    const L = this.L;
    const docClass = this.classTime();
    L.tables.forEach((T) => {
      const hasHeader = !!T.header;
      const data = T.rows.slice(hasHeader ? 1 : 0);
      if (!data.length || T.form) return;
      if (this.cardColumns(T)) return;
      // a table of labels and their values ('Departure | 9:15 AM', 'Return | 2:30 PM'): a form
      const labelled = T.rows.filter((r) => {
        const c0 = r.cells.find((c) => c.col === 0);
        return c0 && labelKey(c0.text) && !this.entsIn(c0.start, c0.end, (x) => TEMPORAL.has(x.type)).length;
      }).length;
      if (Math.max(0, ...T.rows.map((r) => r.cells.length)) <= 2 && labelled >= Math.max(2, 0.75 * T.rows.length)) return;
      const ncol = Math.max(T.columns.length, ...T.rows.map((r) => Math.max(0, ...r.cells.map((c) => c.col + 1))));
      const roles = new Array(ncol).fill(null);
      if (T.header) T.header.forEach((h, c) => (roles[c] = headerRole(h)));
      const count = (pred) => {
        const n = new Array(ncol).fill(0);
        for (const r of data) for (const c of r.cells) if (this.entsIn(c.start, c.end, pred).length) n[c.col]++;
        return n;
      };
      const dateN = count((x) => isDateShape(x.shape));
      let weekdayRows = 0;
      for (const r of data) if (r.cells.some((c) => this.entsIn(c.start, c.end, (x) => x.type === 'weekday' || !!x.weekday).length)) weekdayRows++;
      // columns whose cells are only dates and times are not titles
      const temporalOnly = new Array(ncol).fill(0);
      for (const r of data) {
        for (const c of r.cells) {
          let rest = this.text.slice(c.start, c.end);
          for (const x of this.entsIn(c.start, c.end, (y) => TEMPORAL.has(y.type) || y.type === 'timezone')) {
            const s = Math.max(0, x.start - c.start);
            const e = Math.min(rest.length, x.end - c.start);
            rest = rest.slice(0, s) + ' '.repeat(Math.max(0, e - s)) + rest.slice(e);
          }
          if (!/\p{L}{3}/u.test(rest)) temporalOnly[c.col]++;
        }
      }
      const timeN = count((x) => x.shape === 'time' || (x.shape === 'moment' && x.type !== 'datetime'));
      let dateCol = roles.indexOf('date');
      if (dateCol < 0 || dateN[dateCol] < 0.4 * data.length) {
        const best = dateN.indexOf(Math.max(...dateN));
        dateCol = dateN[best] >= Math.max(1, 0.5 * data.length) ? best : -1;
      }
      let timeCol = roles.indexOf('time');
      if (timeCol < 0) {
        let best = -1;
        for (let c = 0; c < ncol; c++) if (c !== dateCol && (best < 0 || timeN[c] > timeN[best])) best = c;
        timeCol = best >= 0 && timeN[best] >= Math.max(1, 0.4 * data.length) ? best : -1;
      }
      // an agenda table under a date heading: times, no dates
      let ctxDate = null;
      if (dateCol < 0) {
        if (timeCol < 0) return;
        ctxDate = this.dateAbove(T.rows[0].lines[0]);
        if (!ctxDate) return;
      }
      // the room column: by its header, else by its cells ('Grand Ballroom', 'Room A', 'Terrace')
      let whereCol = roles.indexOf('where');
      if (whereCol < 0) {
        for (let c = ncol - 1; c >= 0; c--) {
          if (c === dateCol || c === timeCol || roles[c]) continue;
          const texts = data.map((r) => (r.cells.find((x) => x.col === c) || {}).text || '').filter(Boolean);
          if (texts.length >= Math.max(2, 0.6 * data.length) && texts.filter((t) => ROOMISH.test(tidy(t)) || /^(?:terrace|atrium|lobby|foyer|patio|rooftop|lawn|courtyard|main\s+stage|online|zoom)$/i.test(tidy(t))).length >= 0.6 * texts.length) {
            whereCol = c;
            break;
          }
        }
      }
      if (whereCol >= 0) roles[whereCol] = 'where';
      let titleCol = roles.indexOf('title');
      if (titleCol < 0) {
        let bestLen = -1;
        for (let c = 0; c < ncol; c++) {
          if (c === dateCol || c === timeCol || temporalOnly[c] >= 0.5 * data.length || (roles[c] && roles[c] !== 'title' && roles[c] !== 'notes')) continue;
          const texts = data.map((r) => (r.cells.find((x) => x.col === c) || {}).text || '').filter((t) => /\p{L}{2}/u.test(t));
          const avg = texts.reduce((s, t) => s + Math.min(t.length, 60), 0) / Math.max(1, data.length);
          const score = texts.length >= 0.5 * data.length ? avg + (roles[c] === 'notes' ? -20 : 0) : -1;
          if (score > bestLen) {
            bestLen = score;
            titleCol = c;
          }
        }
      }
      const hostCol = roles.indexOf('host');
      const tableHead = this.headingAbove(T.rows[0].lines[0]);
      const rows = data;
      const made = [];
      const ends = [];
      rows.forEach((r, ri) => {
        const cell = (c) => r.cells.find((x) => x.col === c);
        const dc = dateCol >= 0 ? cell(dateCol) : null;
        let anchor = dc ? this.entsIn(dc.start, dc.end, (x) => isDateShape(x.shape) && !x.skip)[0] : null;
        const tc = timeCol >= 0 ? cell(timeCol) : null;
        let time = tc ? this.entsIn(tc.start, tc.end, (x) => x.shape === 'time')[0] : null;
        if (anchor && anchor.shape === 'moment' && time) time = null;
        if (!anchor && ctxDate) anchor = ctxDate;
        if (!anchor) return;
        const tcell = titleCol >= 0 ? cell(titleCol) : null;
        let title = tcell ? cleanTitle(tcell.text) : '';
        let titleSpan = tcell ? [tcell.start, tcell.end] : null;
        if (!goodTitle(title)) {
          // another text cell, else what the table is about
          const other = r.cells.find((x) => x.col !== dateCol && x.col !== timeCol && x.col !== whereCol && goodTitle(cleanTitle(x.text)) && !this.entsIn(x.start, x.end, (y) => TEMPORAL.has(y.type)).length);
          if (other) {
            title = cleanTitle(other.text);
            titleSpan = [other.start, other.end];
          } else if (tableHead) {
            title = tableHead.text;
            titleSpan = tableHead.span;
          }
        } else if (tableHead && roles[titleCol] !== 'title' && title.split(/\s+/).length <= 3 && !/\d/.test(title) && (ROLE_HEAD.test(T.header ? T.header[titleCol] || '' : '') || ROSTER_HEAD.test(tableHead.text))) {
          // a role or a task under the table's heading: 'Fall Food Drive: Greeter'
          title = `${tableHead.text.replace(/\s*[—–-]\s*(?:volunteer\s+)?(?:shifts?|schedule|sign-?ups?|roster|rota)\s*$/i, '')}: ${title}`;
        }
        if (!title) return;
        // a team's fixtures: 'vs Hawks' / '@ Comets' under 'U10 Lions – Fall schedule'
        if (tableHead && /^(?:vs\.?|v\.?|versus|@|at)\s+\S/i.test(title)) {
          const team = tidy(tableHead.text.replace(/\s*[—–:|-]\s*(?:(?:fall|spring|summer|winter|autumn|home|away|\d{4}(?:[-–/]\d{2,4})?)\s+)*(?:schedule|fixtures|matches|games|calendar|season|results)\b.*$/i, '').replace(/\s+(?:(?:fall|spring|summer|winter|autumn|\d{4})\s+)?(?:schedule|fixtures)$/i, ''));
          if (team && team.split(/\s+/).length <= 5 && !new RegExp(`^${team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(title)) title = `${team} ${title}`;
        }
        let loc = whereCol >= 0 && cell(whereCol) ? { text: tidy(cell(whereCol).text), span: [cell(whereCol).start, cell(whereCol).end] } : null;
        const noClass = NO_CLASS.test(title);
        // a schedule's own meeting time and room ('Lectures TTh 2:00-3:20 PM, Room 204')
        let extraTime = null;
        if (!time && anchor.shape === 'date' && docClass && !noClass) {
          const wd = DAY_CODES[weekdayOf(...anchor.value.split('-').map(Number))];
          if (!docClass.byDay || docClass.byDay.includes(wd)) {
            extraTime = docClass;
            if (!loc && docClass.location) loc = docClass.location;
          }
        }
        let tm;
        if (extraTime) {
          tm = this.timing(anchor, null, null);
          if (tm) {
            const d = tm.start;
            tm.allDay = false;
            tm.start = `${d}T${extraTime.time.start}`;
            tm.end = extraTime.time.end ? `${d}T${extraTime.time.end}` : addMinutes(tm.start, this.defaultMin);
            tm.endInferred = !extraTime.time.end;
            tm.timeZone = extraTime.zone || (this.docZone ? this.docZone.zone : this.opts.timeZone || null);
            tm.sources.time = extraTime.span;
            tm.sources.end = extraTime.span;
            this.used.add(extraTime.entity);
          }
        } else tm = this.timing(anchor, time, null);
        if (!tm) return;
        // '2:30 PM  Adjourn': the session before ends here
        if (END_MARK.test(tidy(titleText0(title))) && !tm.allDay) {
          ends.push(tm.start);
          for (const li of r.lines) this.usedLines.add(li);
          if (time) this.use(time);
          return;
        }
        // a timetable by weekday ('Monday | 9:30-10:20 | MATH 15300'): every week
        const rowWd = anchor.type === 'weekday' ? anchor.value : anchor.weekday;
        if (rowWd && !tm.recurrence && weekdayRows >= 2) {
          tm.recurrence = `FREQ=WEEKLY;BYDAY=${rowWd}`;
          tm.sources.recurrence = [anchor.start, anchor.end];
        }
        const desc = [];
        if (hostCol >= 0 && cell(hostCol)) desc.push(tidy(cell(hostCol).text));
        for (const c of r.cells) {
          if ([dateCol, timeCol, titleCol, whereCol, hostCol].includes(c.col)) continue;
          const t = tidy(c.text);
          if (!t) continue;
          const head = T.header && T.header[c.col] ? T.header[c.col] + ': ' : '';
          desc.push(head + t);
        }
        made.push(this.add({ ...tm, title, titleSpan, location: loc, description: desc.join('\n'), how: 'table', conf: Math.min(tm.conf, 0.95), lines: r.lines }));
        this.use(anchor);
        if (time) this.use(time);
        for (const li of r.lines) this.usedLines.add(li);
      });
      // a session with only a start time ends when the next one on that day begins
      for (let k = 0; k < made.length; k++) {
        const e = made[k];
        if (!e.endInferred || e.allDay) continue;
        const next = [...(made[k + 1] && !made[k + 1].allDay ? [made[k + 1].start] : []), ...ends].filter((t) => datePart(t) === datePart(e.start) && t > e.start).sort()[0];
        if (next && minutesBetween(e.start, next) <= 240) e.end = next;
      }
    });
  }

  // a document-level class time: a recurrence with a time and no table of its own
  classTime() {
    for (const e of this.temporal) {
      if (e.type !== 'recurrence' || !e.value.time || e.skip) continue;
      const l = this.line(e.line);
      if (!l || l.table) continue;
      const loc = this.placeNear(e, [e.line]).sort((a, b) => b.score - a.score)[0];
      return { time: e.value.time, byDay: e.value.byDay, zone: e.timeZone || null, span: [e.start, e.end], location: loc ? { text: loc.text, span: loc.span } : null, entity: e };
    }
    // one time said for all of them: 'Each lecture starts at 5:30 PM.', 'Time: 2:00-3:20 PM'
    // (each row tested once: a long line holds thousands of times)
    const said = new Map();
    for (const e of this.temporal) {
      if (e.shape !== 'time' || e.skip) continue;
      const l = this.line(e.line);
      if (!l || l.table) continue;
      if (!said.has(e.line)) said.set(e.line, /\b(?:each|every|all|lectures?|sessions?|meetings?|classes|class|seminars?|talks?|times?)\b/i.test(this.rowText(e.line)));
      if (!said.get(e.line)) continue;
      const v = e.value;
      return { time: typeof v === 'string' ? { start: v, end: null } : { start: v.start, end: v.end }, byDay: null, zone: e.timeZone || null, span: [e.start, e.end], location: null, entity: e };
    }
    return null;
  }

  // the nearest date heading above a line (for agendas and agenda tables)
  dateAbove(lineIdx, maxBack = 60) {
    const at = this.line(lineIdx);
    for (let i = lineIdx - 1; i >= 0 && i >= lineIdx - maxBack; i--) {
      const l = this.line(i);
      if (!l) break;
      if (at && l.page !== at.page && i < lineIdx - 25) break;
      const ds = this.entsIn(l.start, l.end, (x) => (x.shape === 'date' || x.shape === 'days' || (x.shape === 'moment' && x.type === 'datetime')) && x.skip !== 'header');
      if (!ds.length) continue;
      const d = ds[0];
      // the line is mostly that date, or a heading / 'Day 1' line
      const rest = this.lineWithoutTemporal(i).text.replace(/\b(?:day\s*\d+|session|schedule|agenda|program(?:me)?|part\s*\d+)\b/gi, '').replace(/[^\p{L}]+/gu, ' ').trim();
      if (l.heading || rest.split(/\s+/).filter(Boolean).length <= 6 || /\bday\s*\d+\b/i.test(l.text)) {
        if (d.shape === 'days') return { ...d, shape: 'date', type: 'date', value: d.value.start, start: d.start, end: d.end, confidence: d.confidence };
        if (d.shape === 'moment') return { ...d, shape: 'date', type: 'date', value: datePart(d.value) };
        return d;
      }
    }
    // a single date in the whole document
    const all = this.temporal.filter((x) => (x.shape === 'date' || x.shape === 'days') && !x.skip);
    if (all.length === 1) return all[0].shape === 'days' ? { ...all[0], shape: 'date', type: 'date', value: all[0].value.start } : all[0];
    return null;
  }

  // A row of tabs over the event's block with one tab selected (a bar under it): the selected
  // tab names what the block shows ('BAHRAIN GP | SINGAPORE GP | UNITED STATES GP' over 'Race
  // details'), with the short heading over the tabs before it ('Formula 1').
  tabTitle(lineIdx) {
    const L = this.L;
    const la = this.line(lineIdx);
    if (!la || !la.box || !L.lines.some((l) => l.underline)) return null;
    // (over the block: overlapping it across, not far above; a card may change colour there)
    const over = (l, ref) => l.box && l.box.x0 < ref.x1 && l.box.x1 > ref.x0;
    const quiet = (l) => !this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type)).length && !labelKey(l.text) && !inlineLabel(l.text);
    let best = null;
    // A tab strip is one row across the page even when the reading order cut it into two
    // regions (a flexbox strip spread wider than the details under it): a row's lines plus
    // the lines level with them in other regions (pageRows' `across`).
    const seen = new Set();
    const strips = [];
    for (const r0 of L.rows) {
      if (r0.page !== la.page) continue;
      const ids = new Set(r0.lines);
      for (const i of r0.lines) for (const j of L.lines[i].across || []) if (L.lines[j].page === la.page && L.lines[j].box) ids.add(j);
      const lines = [...ids].filter((i) => L.lines[i].box).sort((i, j) => L.lines[i].box.x0 - L.lines[j].box.x0);
      const key = lines.join(',');
      if (!lines.length || seen.has(key)) continue;
      seen.add(key);
      const bs = lines.map((i) => L.lines[i].box);
      strips.push({ page: r0.page, lines, box: { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) } });
    }
    for (const r of strips) {
      if (r.page !== la.page || r.lines.length < 3 || !r.box || r.box.y1 > la.box.y0 || la.box.y0 - r.box.y1 > 10 * la.size) continue;
      const ls = r.lines.map((i) => L.lines[i]);
      if (!r.lines.some((i) => over(L.lines[i], la.box)) || !ls.every((l) => quiet(l) && l.text.length <= 32 && l.text.split(/\s+/).length <= 4)) continue;
      const sizes = ls.map((l) => l.size);
      if (Math.max(...sizes) > 1.35 * Math.min(...sizes)) continue;
      const on = ls.filter((l) => l.underline);
      if (on.length !== 1) continue;
      if (!best || r.box.y1 > best.row.box.y1) best = { row: r, tab: on[0] };
    }
    if (!best) return null;
    const tab = best.tab;
    let text = /[a-z]/.test(tab.text) ? tab.text : tab.text.replace(/\b([A-Z])([A-Z]{3,})\b/g, (m, a, b) => a + b.toLowerCase());
    let span = [tab.start, tab.end];
    // the heading just over the tabs
    const top = best.row.box.y0;
    let head = null;
    for (const l of L.lines) {
      if (l.page !== la.page || !over(l, best.row.box) || l.box.y1 > top || top - l.box.y1 > 6 * tab.size || !quiet(l)) continue;
      if (l.text.split(/\s+/).length > 4 || !goodTitle(cleanTitle(l.text))) continue;
      if (!head || l.box.y1 > head.box.y1) head = l;
    }
    if (head && !text.toLowerCase().includes(head.text.toLowerCase())) {
      text = `${cleanTitle(head.text)} ${text}`;
      span = [Math.min(head.start, tab.start), Math.max(head.end, tab.end)];
    }
    return { text: cleanTitle(text), span };
  }

  headingAbove(lineIdx) {
    for (let i = lineIdx - 1; i >= 0 && i >= lineIdx - 12; i--) {
      const l = this.line(i);
      if (!l) break;
      if (l.heading || (i === lineIdx - 1 && l.text.length < 80)) {
        const t = cleanTitle(this.lineWithoutTemporal(i).text);
        if (goodTitle(t) && !labelKey(l.text)) return { text: t, span: [l.start, l.end] };
      }
    }
    return null;
  }

  /* ---------- 2. agendas ---------- */

  agendaEvents() {
    const L = this.L;
    const led = [];
    for (let i = 0; i < L.lines.length; i++) {
      if (this.usedLines.has(i)) continue;
      const l = L.lines[i];
      const e = this.entsIn(l.start, l.end, (x) => (x.shape === 'time' || (x.type === 'timerange' && !hasT(x.value.start))) && !x.skip)[0];
      if (!e || e.start - l.start > 3) continue;
      // the session's name: the rest of the line, or the next piece of its row
      let rest = this.text.slice(e.end, l.end);
      let restStart = e.end;
      const row = l.row >= 0 ? L.rows[l.row] : null;
      const tail = row ? row.lines.filter((k) => k !== i && this.line(k).box.x0 > l.box.x0) : [];
      if (!/\p{L}{2}/u.test(rest) && tail.length) {
        rest = tail.map((k) => this.line(k).text).join('\t');
        restStart = this.line(tail[0]).start;
      }
      if (!/\p{L}{2}/u.test(rest)) continue;
      led.push({ i, e, rest, restStart, tail });
    }
    // runs of session lines (other lines between them: speakers, rooms, abstracts)
    const blocks = [];
    let cur = [];
    for (const x of led) {
      const prev = cur[cur.length - 1];
      if (prev && (x.i - prev.i > 6 || this.line(x.i).page !== this.line(prev.i).page && x.i - prev.i > 2)) {
        blocks.push(cur);
        cur = [];
      }
      cur.push(x);
    }
    if (cur.length) blocks.push(cur);
    for (const b of blocks) {
      if (b.length < 2) continue;
      const items = b.map((x) => ({ ...x, date: this.dateAbove(x.i) }));
      if (!items.some((x) => x.date)) continue;
      items.forEach((x, k) => {
        if (!x.date) return;
        const next = items[k + 1];
        const nextLine = next ? next.i : Math.min(L.lines.length, x.i + 4);
        // lines under the session until the next one
        const under = [];
        for (let j = x.i + 1; j < nextLine; j++) if (!this.usedLines.has(j) && !led.some((y) => y.i === j)) under.push(j);
        // stop at a new date heading
        const cutAt = under.findIndex((j) => this.entsIn(this.line(j).start, this.line(j).end, (y) => y.shape === 'date' || y.shape === 'days').length);
        if (cutAt >= 0) under.splice(cutAt);
        // the name and the room: 'Opening Keynote | Main Hall', 'Track A: Streaming (Room 101)', a room column
        let parts = x.rest.split(/\t|\s+[|•·]\s+|\s+[–—]\s+(?=[A-Z0-9])/);
        let titleText = parts[0];
        let loc = null;
        const restS = x.restStart;
        if (parts.length > 1) {
          const lastPart = tidy(parts[parts.length - 1]);
          if (ROOMISH.test(lastPart) || this.entsIn(restS + x.rest.lastIndexOf(parts[parts.length - 1]), restS + x.rest.length, (y) => y.type === 'location').length || x.tail.length > 1) {
            const off = restS + x.rest.lastIndexOf(parts[parts.length - 1]);
            loc = { text: lastPart, span: [off, off + parts[parts.length - 1].length] };
            parts = parts.slice(0, -1);
          }
          titleText = parts.join(' – ');
        }
        const paren = /\s*\((?:in\s+)?((?:room|rm\.?|hall|stage|ballroom|track|studio|lab|suite)[^()]{0,30})\)\s*$/i.exec(titleText);
        if (!loc && paren) {
          const off = restS + x.rest.indexOf(paren[1]);
          loc = { text: paren[1].trim(), span: [off, off + paren[1].length] };
          titleText = titleText.slice(0, paren.index);
        }
        const descLines = [];
        for (const j of under) {
          const t = tidy(this.line(j).text);
          if (!loc && ROOMISH.test(t) && t.length <= 40) {
            loc = { text: t, span: [this.line(j).start, this.line(j).end] };
            continue;
          }
          descLines.push(this.rowText(j).replace(/\t/g, ' '));
        }
        const title = cleanTitle(titleText);
        if (!goodTitle(title)) return;
        let until = null;
        if (next && next.date && next.date.value === x.date.value) {
          const nv = next.e.value;
          until = `${x.date.value}T${typeof nv === 'string' ? nv : nv.start}`;
        }
        const tm = this.timing(x.date, x.e, null, { until });
        if (!tm) return;
        if (tm.endInferred && until && until > tm.start && minutesBetween(tm.start, until) <= 240) {
          tm.end = until;
          tm.endInferred = true;
        }
        this.add({ ...tm, title, titleSpan: [restS, restS + titleText.length], location: loc, description: descLines.join('\n'), how: 'agenda', conf: Math.min(tm.conf, 0.9), lines: [x.i, ...under] });
        this.use(x.e);
        this.useAsContext(x.date);
        this.usedLines.add(x.i);
        for (const j of under) this.usedLines.add(j);
      });
    }
  }

  /* ---------- 3. labelled forms ---------- */

  formEvents() {
    const pairs = this.L.pairs.filter((p) => !this.usedLines.has(p.line));
    const forms = [];
    let cur = null;
    for (const p of pairs) {
      const startNew = !cur || p.page !== cur.page || (cur.keys.has(p.key) && ['date', 'when', 'title'].includes(p.key)) || p.line - cur.lastLine > 14;
      if (startNew) {
        cur = { page: p.page, keys: new Set(), pairs: [], lastLine: p.line, firstLine: p.line };
        forms.push(cur);
      }
      cur.keys.add(p.key);
      cur.pairs.push(p);
      cur.lastLine = Math.max(cur.lastLine, ...p.valueLines);
    }
    for (const f of forms) {
      const get = (k) => f.pairs.filter((p) => p.key === k);
      const ents = (ps, pred) => ps.flatMap((p) => this.entsIn(p.valueSpan[0], p.valueSpan[1], (x) => !this.used.has(x) && (!pred || pred(x))));
      const datePairs = [...get('date'), ...get('when')];
      const timePairs = [...get('time'), ...get('when')];
      let anchor = ents(datePairs, (x) => isDateShape(x.shape) && !x.skip)[0] || null;
      // 'DOORS 7:00 PM' / 'SHOW 8:00 PM': the show is the event
      const early = (p) => /^(?:doors(?:\s+open)?|gates|arrival|arrive\s+by|check-?in|registration)$/i.test(p.label);
      const tps = timePairs.slice().sort((a, b) => early(a) - early(b));
      let time = ents(tps, (x) => x.shape === 'time' && !x.skip)[0] || null;
      if (!anchor && time) {
        // 'Time: Saturday Oct 24, 7pm' or a date elsewhere in the form
        anchor = ents(f.pairs, (x) => isDateShape(x.shape) && !x.skip)[0] || null;
      }
      let dateAbove = false;
      if (!anchor && time) {
        // the date in the sentence just over the form ('... will visit the Field Museum on
        // Friday, November 13.' / Departure | 9:15 AM / Return | 2:30 PM)
        if (f.pairs.length >= 2) anchor = this.temporal.find((x) => isDateShape(x.shape) && x.shape !== 'rule' && !x.skip && !this.used.has(x) && x.line < f.firstLine && x.line >= f.firstLine - 3) || null;
        dateAbove = !!anchor;
      }
      if (!anchor) {
        const t2 = ents(timePairs, (x) => x.shape === 'moment' && !x.skip)[0];
        if (t2) anchor = t2;
      }
      if (!anchor) continue;
      if (anchor.shape === 'moment' || anchor.shape === 'rule') time = anchor.shape === 'rule' && !anchor.value.time ? time : null;
      const endE = ents(get('end'), (x) => (x.shape === 'time' || x.shape === 'moment' || x.shape === 'date') && !x.skip)[0] || null;
      const tm = this.timing(anchor, time, endE);
      if (!tm) continue;
      // title: a label, the heading above the form, the subject, the page's heading
      let title = null;
      const tp = get('title')[0];
      const head = this.headingFor(f.firstLine);
      // a flyer's 'WHAT' says what there is ('Homemade pies'); its big heading names the event
      const weakLabel = tp && /^what$/i.test(tp.label) && head && this.line(this.lineAt(head.span[0])).heading <= 2;
      if (tp && !weakLabel && goodTitle(cleanTitle(tp.value))) title = { text: cleanTitle(tp.value.replace(/\n/g, ' ')), span: tp.valueSpan };
      // the page's big heading, else the line above the form, else an email's subject
      const bigHead = head && this.line(this.lineAt(head.span[0])) && this.line(this.lineAt(head.span[0])).heading <= 2 ? head : null;
      if (!title) title = this.tabTitle(f.firstLine) || bigHead || this.headingAbove(f.firstLine) || this.subject || head;
      // an appointment card: 'Provider: Dr. Elena Vasquez, MD'
      const hp = get('host')[0];
      if ((!title || !goodTitle(title.text)) && hp && /\b(?:appointment|appt|visit|consult(?:ation)?|check-?up|exam)\b/i.test(this.text)) {
        const who = tidy(hp.value.split('\n')[0].replace(/,?\s*(?:MD|M\.D\.|DO|DDS|DMD|NP|PA-C|RN|PhD|OD)\.?$/i, ''));
        if (who) title = { text: `Appointment with ${who}`, span: hp.valueSpan };
      }
      if (!title) title = this.titleNear(anchor);
      if (!title || !goodTitle(title.text)) title = { text: this.L.title && goodTitle(this.L.title) ? this.L.title : 'Event', span: null };
      const wp = get('where');
      let loc = null;
      if (wp.length) {
        const vs = wp.map((p) => p.value.split('\n').map(tidy).filter(Boolean).join(', '));
        loc = { text: vs.join(', '), span: [wp[0].valueSpan[0], wp[wp.length - 1].valueSpan[1]] };
      }
      if (!loc && dateAbove) {
        // the place in the date's sentence ('will visit the Field Museum on Friday')
        const ps = this.placeNear(anchor, [anchor.line], title.span).sort((x, y) => y.score - x.score);
        if (ps[0]) loc = { text: ps[0].text, span: ps[0].span };
      }
      // an appointment's confirmation under the practice's letterhead ('Lakeview Animal
      // Hospital' / '3201 N Broadway, Chicago, IL 60657 · (773) 555-0123'): the practice
      if (!loc && /\b(?:appointment|appt|visit|reservation|booking)\b/i.test(this.text)) loc = this.letterhead(f.page, f.firstLine);
      const up = get('url')[0];
      let url = up ? this.entsIn(up.valueSpan[0], up.valueSpan[1], (x) => x.type === 'url')[0] : null;
      const desc = [...get('description'), ...get('host')].map((p) => `${p.label}: ${p.value.replace(/\n/g, ' ')}`);
      const lines = [...f.pairs.flatMap((p) => [p.line, ...p.valueLines]), ...(dateAbove ? [anchor.line] : [])];
      this.add({ ...tm, title: title.text, titleSpan: title.span, location: loc, url: url ? { text: url.value, span: [url.start, url.end] } : null, description: desc.join('\n'), how: 'form', conf: Math.min(tm.conf, 0.95), lines });
      this.use(anchor);
      if (time) this.use(time);
      if (endE) this.use(endE);
      for (const li of lines) this.usedLines.add(li);
    }
  }

  /* ---------- 4. free text ---------- */

  textEvents() {
    const usable = (e) => isDateShape(e.shape) && (e.shape !== 'rule' || usableRule(e.value));
    const anchors = this.temporal.filter((e) => usable(e) && !this.used.has(e) && !e.context && !e.skip);
    const secondary = this.temporal.filter((e) => usable(e) && !this.used.has(e) && e.skip === 'deadline');
    const list = anchors.length || this.events.length ? anchors : secondary;
    for (const a of list) {
      if (this.used.has(a)) continue;
      const time = a.shape === 'date' || a.shape === 'days' || (a.shape === 'rule' && !a.value.time) ? this.timeFor(a) : null;
      const tm = this.timing(a, time, null);
      if (!tm) continue;
      let lines = this.blockLines(a);
      const single = this.anchorsOnPage(a) <= 1;
      // 'Coaches leave at 8.45am and will return by 3.30pm': the end
      if (tm.endInferred && !tm.allDay && !tm.recurrence) {
        const ls = lines.map((i) => this.line(i)).filter(Boolean);
        const pool = ls.length ? this.entsIn(Math.min(...ls.map((l) => l.start)), Math.max(...ls.map((l) => l.end)) + 1, (x) => TEMPORAL.has(x.type)) : [];
        const back = pool.find((x) => x.shape === 'time' && x !== time && !this.used.has(x) && !x.skip && lines.includes(x.line) && /\b(?:return(?:s|ing)?|back|home|pick[- ]?up|collection|finish(?:es|ing)?|ends?|ending|wraps?\s+up|dismissal|over)\s+(?:(?:by|at|around|about|approx\.?|approximately|no\s+later\s+than)\s+)?$/i.test(this.text.slice(Math.max(0, x.start - 30), x.start)));
        const v = back ? (typeof back.value === 'string' ? back.value : back.value.start) : null;
        if (v && `${datePart(tm.start)}T${v}` > tm.start) {
          tm.end = `${datePart(tm.start)}T${v}`;
          tm.endInferred = false;
          tm.sources.end = [back.start, back.end];
          this.use(back);
        }
      }
      let title = this.titleNear(a);
      const head = this.headingFor(a.line);
      // 'Free webinar · Thursday 12 November': a kind of event, not its name; the heading names it
      if (title && !title.weak && head && typeOnly(title.text) && !sameish(head.text, title.text)) title = { ...title, weak: true };
      // one of several items, each under its own heading ('Welcome drinks' / 'Friday, June 4 · 7-10 PM')
      if (!single && (!title || title.weak)) {
        const item = this.itemHeading(a);
        if (item) {
          title = item;
          // and its place is in that item, not the one before
          const from = this.lineAt(item.span[0]);
          let to = a.line + 1;
          while (to < this.L.lines.length && !this.line(to).heading) to++;
          lines = lines.filter((i) => i >= from && i < to);
        }
      }
      // an event card: a small date line over the big title ('SAT, NOV 21 · 2:00 PM' /
      // 'Holiday Craft Fair'), when the page's heading is elsewhere (a banner, another column)
      if (single && (!title || title.weak)) {
        const under = this.titleBelow(a);
        const la0 = this.line(a.line);
        const headLine = head ? this.line(this.lineAt(head.span[0])) : null;
        if (under && (!head || (headLine && la0 && headLine.region !== la0.region))) title = under;
      }
      const above = single && (!title || title.weak) ? this.lineTitleAbove(a) : null;
      if ((!title || title.weak) && head && (single || !title)) title = head;
      if ((!title || title.weak) && above) title = above;
      if ((!title || title.weak) && this.subject && (single || !title)) title = this.subject;
      if (!title && head) title = head;
      // a visit's provider: 'Elena Ruiz, MD' / 'Dermatology'
      if ((!title || title.weak) && single) {
        const pv = this.providerTitle(lines);
        if (pv) title = pv;
      }
      // a group chat's name in the top bar ('Book Club 📚') when the message names nothing
      if (single && (!title || title.weak || (title.text.split(/\s+/).length <= 2 && !NOUN_RE.test(title.text)))) {
        const top = this.topBarTitle(a);
        if (top && (!title || !top.span || !title.span || top.span[0] !== title.span[0])) title = top;
      }
      if (!title && single) title = this.prominentLine(a);
      // a day number (or an icon read as one) in front of a title on a calendar's grid: '8 Book club'
      if (title && /^\d{1,2}\s+[A-Z]/.test(title.text) && this.line(a.line) && calendarGrid(this.L, this.line(a.line).page)) title = { ...title, text: title.text.replace(/^\d{1,2}\s+/, '') };
      if (!title) {
        const t = this.L.title && goodTitle(cleanTitle(this.L.title)) ? cleanTitle(this.L.title) : null;
        title = { text: t || 'Event', span: null };
      }
      // 'Next meeting: Wednesday, November 11' in the minutes of the Hyde Park Neighbors
      // an invitation to a wedding: the couple, wherever their names sit ('Maya Chen' / '&' /
      // 'Daniel Brooks' in a script font over 'the celebration of their marriage')
      if (single && !/\b(?:wedding|ceremony|reception|marriage|brunch|dinner|drinks|party|rehearsal|shower)\b/i.test(title.text)) {
        const cp = this.couple();
        const inNames = (t) => cp && words(t).every((w) => words(`${cp.a} ${cp.b}`).includes(w));
        if (cp && (title.weak || inNames(title.text) || title.text === 'Event')) title = { text: `Wedding of ${cp.a} and ${cp.b}`, span: cp.span, weak: false };
      }
      // a visit with a provider who called or wrote: 'this is Karen from Dr. Lee's office ...
      // your cleaning' -> 'Cleaning at Dr. Lee's office'
      if (SERVICE.test(title.text) && !/\b(?:with|at)\b/i.test(title.text)) {
        const pv = this.providerOffice();
        if (pv) title = { ...title, text: `${title.text} at ${pv}` };
      }
      // a body that holds its meeting: 'The Board of Directors of the Midway Housing Cooperative
      // will hold its regular meeting on ...' -> 'Midway Housing Cooperative board meeting'
      {
        const om = this.orgMeeting(a);
        // (in place of a bare 'Meeting', or of the body's name taken from the same sentence)
        const fromSentence = om && words(title.text).every((w) => words(this.text.slice(this.line(a.line).start, a.start)).includes(w));
        if (om && (typeOnly(title.text) || fromSentence || /^(?:notice\s+of\s+(?:the\s+)?)?(?:(?:regular|annual|special|monthly|quarterly|general)\s+)?(?:meeting|session)$/i.test(title.text))) title = om;
      }
      const nm = /^next\s+(meeting|session|gathering|class|practice|rehearsal|meetup|service)$/i.exec(title.text);
      if (nm && head && !new RegExp(`\\b${nm[1]}`, 'i').test(head.text)) title = { text: `${head.text} ${nm[1].toLowerCase()}`, span: head.span };
      // a message signed by one person: 'quick call ... - Dev', '1:1 ... Priya'
      if (this.L.kind === 'text' && (typeOnly(title.text) || /^(?:1:1|one-on-one|1-on-1)$/i.test(title.text)) && !/\bwith\b/i.test(title.text)) {
        const who = this.signer();
        if (who) title = { ...title, text: `${title.text} with ${who.text}` };
      }
      // a course page's section heading right over the times ('Office hours' / 'Tuesdays 2-4 PM')
      const up = this.line(a.line - 1);
      const la1 = this.line(a.line);
      if (up && la1 && up.page === la1.page && up.region === la1.region && SESSION_WORD.test(tidy(up.text)) && !SESSION_WORD.test(title.text)) title = { text: capFirst(tidy(up.text)), span: [up.start, up.end] };
      // 'Lectures' / 'Discussion' of a course: say which course
      if (SESSION_WORD.test(title.text)) {
        const c = this.courseName();
        if (c && !sameish(c.text, title.text)) title = { text: `${c.text} — ${title.text}`, span: title.span };
      }
      // (a name that only looks like a place, 'Book Club', counts only near the date)
      const places = this.placeNear(a, lines, title.span ? narrow(this.text, title.span, title.text) : null)
        .filter((p) => p.score > 2 || (p.line >= a.line - 1 && p.line <= a.line + 3))
        .sort((x, y) => y.score - x.score || Math.abs(x.line - a.line) - Math.abs(y.line - a.line));
      let loc = places[0] ? { text: places[0].text, span: places[0].span } : null;
      // 'same room': where the event before was
      if (loc && /^(?:the\s+)?same\s+(?:room|place|location|venue|spot|address)$/i.test(loc.text)) {
        const prev = this.events.filter((e) => e.location).pop();
        loc = prev ? { text: prev.location, span: loc.span } : null;
      }
      // a venue line followed by its address: 'Thalia Hall' / '1807 S Allport St, Chicago'
      if (loc && places[0].e && places[0].e.address) {
        // or before it on its line: 'Hyde Park Public Library, 5020 S Cornell Ave'
        const pl = this.line(places[0].line);
        // (or starting the sentence: '... Dec 21. Hyde Park YMCA, 1400 E 53rd St'; or after 'at':
        // '9:00 AM – 12:00 PM at the Greater Chicago Food Depository, 4100 W Ann Lurie Pl')
        const lead = pl ? this.text.slice(pl.start, loc.span[0]) : '';
        const pre = pl ? /^\s*([A-Z][\w'’&.\- ]{2,50}?),\s*$/.exec(lead) || /(?<!\b[A-Za-z]|\b(?:Dr|Mr|Mrs|Ms|St|Prof|Mt|Ft|No|vs))[.!?]\s+([A-Z][\w'’&\- ]{2,50}?),\s*$/.exec(lead) || /\b(?:at|@|in)\s+(?:the\s+)?([A-Z][\w'’&.-]*(?:\s+(?:[A-Z][\w'’&.-]*|of|and|&)){0,6}),\s*$/.exec(lead) : null;
        const preAt = pre ? pl.start + pre.index + pre[0].lastIndexOf(pre[1]) : 0;
        const v = pre && placeLike(pre[1]) ? { text: tidy(pre[1]), span: [preAt, pl.start + pre.index + pre[0].length] } : this.venueAbove(places[0].line, lines);
        if (v) loc = { text: `${v.text}, ${loc.text}`, span: [v.span[0], loc.span[1]] };
      }
      // a listing's place on the line under its date ('Tue, Nov 3 · 7:00 PM' / '57th Street Books')
      // (the next row down in the same region, not a piece beside the date on its own row)
      const la = this.line(a.line);
      let ni = a.line + 1;
      while (this.line(ni) && this.line(ni).row === la.row) ni++;
      // (past the title when the title sits under the date)
      if (title.span && this.line(ni) && this.line(ni).start >= title.span[0] && this.line(ni).end <= title.span[1]) ni++;
      if (this.line(ni) && this.line(ni).region !== la.region) ni = -1;
      // (a place under the item's own date beats an 'at ...' in a heading over all the items)
      const fromHeading = places[0] && places[0].line < a.line && this.line(places[0].line) && this.line(places[0].line).heading && !single;
      if (ni > 0 && (!loc || (places[0] && (places[0].score < 2.5 || fromHeading || (!single && places[0].line > ni)) && places[0].line !== ni))) {
        const n = this.line(ni);
        // (in plain text, not across a blank line: the next paragraph, a signature)
        const sig = this.L.kind === 'text' && n && /\n[ \t]*\n/.test(this.text.slice(la.end, n.start));
        if (n && !sig && n.page === la.page && !this.dateOnLine(ni) && placeLike(n.text) && !(title.span && n.start >= title.span[0] && n.end <= title.span[1]) && !this.entsIn(n.start, n.end, (x) => TEMPORAL.has(x.type) || x.type === 'url' || x.type === 'phone').length && n.heading !== 1) {
          const next2 = this.line(ni + 1);
          // (without a remark after it: 'Kersten roof deck (weather permitting)')
          let text = tidy(n.text.replace(/\s*\((?:weather|rain|if|subject|enter|use|tbc|tbd|tentative|space|limited|free)\b[^)]*\)\s*$/i, ''));
          let end = n.end;
          // and its address on the line after that
          const addr = next2 ? this.entsIn(next2.start, next2.end, (x) => x.type === 'location' && x.address) : [];
          if (next2 && next2.region === la.region && addr.length && addr.reduce((n, x) => n + x.end - x.start, 0) >= 0.6 * tidy(next2.text).length && !this.dateOnLine(ni + 1)) {
            text += ', ' + tidy(next2.text);
            end = next2.end;
          }
          loc = { text, span: [n.start, end] };
        }
      }
      if (!loc) {
        const v = lines.map((i) => this.line(i)).find((l) => l && ROOMISH.test(tidy(l.text)) && l.text.length <= 60 && l.heading !== 1 && !(title.span && l.start >= title.span[0] - 1 && l.end <= title.span[1] + 1) && !this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type)).length);
        if (v) loc = { text: tidy(v.text), span: [v.start, v.end] };
      }
      // the rest of the place's line: 'Victoria Park' + ', London E9', 'Room 140' + ', Gordon Center'
      if (loc && loc.span) {
        const l = this.line(this.lineAt(loc.span[0]));
        // (to the end of the sentence: '1400 E 53rd St' + ', studio B' of '..., studio B. Bring a mat.')
        let rest = l ? this.text.slice(loc.span[1], l.end) : '';
        const stop = /[.!?](?=\s+\S)/.exec(rest);
        if (stop && !/\b(?:St|Ave|Rd|Dr|Blvd|Ln|Ct|Pl|Mt|Ft|No|Rm|Ste|Fl)$/.test(rest.slice(0, stop.index))) rest = rest.slice(0, stop.index);
        const restEnd = loc.span[1] + rest.length;
        const piece = tidy(rest.replace(/^\s*[,·•-]\s*/, ''));
        if (/^\s*[,·•-]\s*\S/.test(rest) && (placeLike(piece) || (ROOMISH.test(piece) && piece.length <= 24)) && !this.entsIn(loc.span[1], restEnd, (x) => TEMPORAL.has(x.type) || x.type === 'url' || x.type === 'phone').length) {
          loc = { text: `${loc.text}, ${piece}`, span: [loc.span[0], restEnd] };
        }
      }
      // an appointment that a practice sends a reminder of, naming no other place: the practice
      // ('Cherry Tree Surgery: Your appointment is on 04/11/2026 at 10:20 with Dr Okafor')
      if (!loc && /\b(?:appointment|appt|check-?up|cleaning|exam|consultation|visit|follow-?up|vaccinations?|haircut|physical)\b/i.test(title.text)) {
        const pv = this.providerOffice();
        // (a name for the premises, 'Cherry Tree Surgery', 'Lakeview Clinic'; not a business
        // name, 'Bright Smile Dental', nor 'Dr. Lee's office')
        if (pv && !/^(?:Dr\.?|Doctor)\s/.test(pv) && /\b(?:surgery|clinic|hospital|centre|center|pharmacy)$/i.test(pv) && !title.text.includes(pv)) loc = { text: pv, span: null };
      }
      title = this.withVenue(title, loc, lines);
      const urlE = lines.flatMap((i) => this.entsIn(this.line(i).start, this.line(i).end, (x) => x.type === 'url'))[0];
      const desc = this.describe(a, lines, title, loc);
      this.add({ ...tm, title: title.text, titleSpan: title.span, location: loc, url: urlE ? { text: urlE.value, span: [urlE.start, urlE.end] } : null, description: desc, how: 'text', conf: Math.min(tm.conf, title.weak ? 0.7 : 0.9), lines, anchorLine: a.line });
      this.use(a);
      if (time) this.use(time);
    }
  }

  // A screenshot's top bar naming a group or a thread with an event word ('Book Club',
  // 'Soccer practice parents'): the title of what its messages plan.
  topBarTitle(a) {
    const la = this.line(a.line);
    const pg = la && this.L.pages.find((p) => p.page === la.page);
    if (!pg || !pg.height || pg.unit === 'char') return null;
    for (const l of this.L.lines) {
      if (l.page !== la.page || !l.box || l.box.y1 > 0.15 * pg.height) continue;
      if (this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type)).length) continue;
      const t = cleanTitle(l.text.replace(/[^\p{L}\p{N}\s'’&:-]+/gu, ' '));
      if (goodTitle(t) && t.split(/\s+/).length <= 5 && NOUN_RE.test(t)) return { text: t, span: [l.start, l.end], weak: false };
    }
    return null;
  }

  // The line right under a date line, in bigger type: an event card's title.
  titleBelow(a) {
    const la = this.line(a.line);
    if (!la || !la.box || !la.size) return null;
    let i = a.line + 1;
    while (this.line(i) && this.line(i).row === la.row && la.row >= 0) i++;
    const l = this.line(i);
    if (!l || !l.box || l.page !== la.page || l.region !== la.region || l.size < 1.25 * la.size || l.box.y0 - la.box.y1 > 2 * l.size) return null;
    if (this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'url' || x.type === 'phone' || x.type === 'email' || (x.type === 'location' && x.address)).length) return null;
    const t = cleanTitle(l.text);
    if (!goodTitle(t) || t.split(/\s+/).length > 8 || labelKey(l.text) || inlineLabel(l.text)) return null;
    return { text: t, span: [l.start, l.end], weak: false };
  }

  // 'Appointment with Dr. Elena Ruiz' from a visit's provider line ('Elena Ruiz, MD' or
  // 'Dr. Elena Ruiz'), with the specialty on the line under it ('Dermatology').
  providerTitle(lines) {
    if (!/\b(?:appointment|appt|visit|check-?up|consult(?:ation)?|exam|follow-?up|clinic|patient)\b/i.test(this.text)) return null;
    for (const i of lines) {
      const l = this.line(i);
      if (!l) continue;
      const t = tidy(l.text);
      const m = /^(?:(Dr\.?)\s+)?([A-Z][a-z'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z'’-]+){0,2})(?:,?\s+(MD|M\.D\.|DO|D\.O\.|DDS|DMD|OD|DPM|NP|PA-C|PA|PhD|PsyD|LCSW|DC|RN|APRN|CNM))?$/.exec(t);
      if (!m || (!m[1] && !m[3]) || (m[1] && !/\s/.test(m[2]) && !m[3] && t.length < 6)) continue;
      const doctor = !!m[1] || /^(?:MD|M\.D\.|DO|D\.O\.|DDS|DMD|OD|DPM)$/.test(m[3] || '');
      const who = `${doctor ? 'Dr. ' : ''}${m[2]}`;
      const next = this.line(i + 1);
      const spec = next && /^(?:[A-Z][a-z]+(?:ology|iatrics|opedics|ics|istry|ery|ine|care|therapy)|Primary Care|Family Medicine|Internal Medicine|Physical Therapy|Urgent Care|Women's Health)$/.test(tidy(next.text)) ? tidy(next.text) : null;
      return { text: spec ? `${spec} appointment with ${who}` : `Appointment with ${who}`, span: [l.start, spec ? next.end : l.end], weak: false };
    }
    return null;
  }

  // A page's letterhead: a name over an address in its first lines, above the line `before`.
  letterhead(page, before) {
    const first = this.L.lines.findIndex((l) => l.page === page);
    if (first < 0) return null;
    for (let i = first; i < Math.min(before, first + 4); i++) {
      const l = this.line(i);
      const ad = this.entsIn(l.start, l.end, (x) => x.type === 'location' && x.address)[0];
      if (!ad) continue;
      const prev = i > first ? this.line(i - 1) : null;
      const name = prev && placeLike(prev.text) && !this.entsIn(prev.start, prev.end, (x) => x.type !== 'location').length ? tidy(prev.text) : null;
      return { text: name ? `${name}, ${ad.value}` : ad.value, span: [name ? prev.start : ad.start, ad.end] };
    }
    return null;
  }

  // Event cards side by side (a listings page): each column one event, its date on the first
  // row, its name under it, then its place ('SAT, OCT 24 · 11:00 AM' / 'Pumpkin Patch Fun Run' /
  // 'Montrose Harbor · Chicago' | 'THU, NOV 5 · 6:30 PM' / ...).
  cardColumns(T) {
    if (T.header || T.rows.length < 2) return false;
    const first = T.rows[0].cells;
    if (first.length < 2) return false;
    const anchors = first.map((c) => this.entsIn(c.start, c.end, (x) => isDateShape(x.shape) && !this.used.has(x) && !x.skip)[0]);
    if (anchors.some((x) => !x)) return false;
    // (every first-row cell is a date and nothing else)
    if (first.some((c, k) => /\p{L}{3}/u.test(this.text.slice(c.start, anchors[k].start) + this.text.slice(anchors[k].end, c.end)))) return false;
    const cellAt = (r, col) => (T.rows[r] ? T.rows[r].cells.find((c) => c.col === col) : null);
    const made = [];
    for (let k = 0; k < first.length; k++) {
      const col = first[k].col;
      const a = anchors[k];
      const time = a.shape === 'date' ? this.entsIn(first[k].start, first[k].end, (x) => x.shape === 'time' && !this.used.has(x))[0] || null : null;
      const tm = this.timing(a, time, null);
      const tc = cellAt(1, col);
      const title = tc ? cleanTitle(this.text.slice(tc.start, tc.end)) : '';
      if (!tm || !goodTitle(title) || this.entsIn(tc.start, tc.end, (x) => TEMPORAL.has(x.type)).length) return made.length > 0;
      const pc = cellAt(2, col);
      let loc = null;
      if (pc && !this.entsIn(pc.start, pc.end, (x) => TEMPORAL.has(x.type) || x.type === 'url' || x.type === 'phone').length && !/[$€£¥]\s*\d|\bfree\b/i.test(this.text.slice(pc.start, pc.end))) {
        const p = tidy(this.text.slice(pc.start, pc.end).replace(/\s+[-–·•|]\s+/g, ', '));
        if (placeLike(p)) loc = { text: p, span: [pc.start, pc.end] };
      }
      const lines = [0, 1, 2].map((r) => cellAt(r, col)).filter(Boolean).map((c) => this.lineAt(c.start));
      made.push(this.add({ ...tm, title, titleSpan: [tc.start, tc.end], location: loc, description: '', how: 'table', conf: Math.min(tm.conf, 0.9), lines }));
      this.use(a);
      if (time) this.use(time);
    }
    for (const r of T.rows) for (const li of r.lines) this.usedLines.add(li);
    return true;
  }

  // A video call's service named in the text: 'Join on Google Meet', 'same Zoom link', 'Teams
  // meeting', or only its link (zoom.us, meet.google.com, teams.microsoft.com).
  onlinePlace() {
    const T = this.text;
    const NAMES = String.raw`Zoom|Google\s+Meet|Microsoft\s+Teams|Teams|Webex|WebEx|Skype|FaceTime|Jitsi`;
    const m = new RegExp(String.raw`\b(?:on|via|over|using|join(?:\s+us)?(?:\s+on)?)\s+(${NAMES})\b|\b(${NAMES})\s+(?:link|call|meeting|room|invite|details)\b`).exec(T);
    if (m) {
      const name = (m[1] || m[2]).replace(/\s+/g, ' ');
      const s = m.index + m[0].indexOf(m[1] || m[2]);
      return { text: name === 'Teams' ? 'Microsoft Teams' : name === 'WebEx' ? 'Webex' : name, span: [s, s + (m[1] || m[2]).length] };
    }
    const SITES = [[/\bzoom\.us\//i, 'Zoom'], [/\bmeet\.google\.com\//i, 'Google Meet'], [/\bteams\.(?:microsoft|live)\.com\//i, 'Microsoft Teams'], [/\bwebex\.com\//i, 'Webex']];
    for (const e of this.ents) {
      if (e.type !== 'url') continue;
      const site = SITES.find(([re]) => re.test(e.value || e.text));
      if (site) return { text: site[1], span: [e.start, e.end] };
    }
    return null;
  }

  // The organization that holds a meeting, from the sentence of its date: '(The Board of
  // Directors of) the Midway Housing Cooperative will hold its regular meeting on ...'
  orgMeeting(a) {
    const l = this.line(a.line);
    if (!l) return null;
    const before = this.text.slice(l.start, a.start);
    const m = /(?:^|[.!?]\s+)(?:[Tt]he\s+)?(?:((?:[Bb]oard|BOARD)(?:\s+of\s+(?:[Dd]irectors|[Tt]rustees|[Ee]ducation|[Gg]overnors))?|(?:[Ee]xecutive\s+)?[Cc]ommittee|[Cc]ouncil|[Cc]ommission|[Tt]rustees|[Mm]embers(?:hip)?)\s+of\s+(?:the\s+)?)?((?:[A-Z][\w&'’.-]*\s+){0,5}[A-Z][\w&'’.-]*)\s+(?:will|shall|is\s+going\s+to)\s+(?:hold|have|host|convene)\s+(?:its|their|a|an|the)\s+(?:(regular|annual|special|monthly|quarterly|general|semi-annual|public)\s+)?(meeting|session|assembly|hearing)\b[^.!?]*$/.exec(before);
    if (!m || /^(?:We|I|You|They|He|She|It|Our|This|That)$/.test(m[2])) return null;
    const body = m[1] ? (/^board/i.test(m[1]) ? 'board' : m[1].toLowerCase().replace(/\s+of\s+.*$/, '')) : null;
    const adj = m[3] && !/^regular$/i.test(m[3]) ? m[3].toLowerCase() : null;
    const text = [m[2], body, adj, m[4].toLowerCase()].filter(Boolean).join(' ');
    const at = l.start + m.index + m[0].indexOf(m[2]);
    return { text, span: [at, at + m[2].length], weak: false };
  }

  // A bare event word takes the name of the venue it is at, as people type it: 'Dinner' at
  // 'Kasama' -> 'Dinner at Kasama'; 'Your shift ... at the Greater Chicago Food Depository';
  // 'Thanksgiving is at Aunt Rita's ... dinner at 4' -> 'Dinner at Aunt Rita's'. Not a room
  // ('Lunch' in the 'Atrium'), an address or 'my place'.
  withVenue(title, loc, lines) {
    const t = title && title.text;
    if (!t || t.split(/\s+/).length > 1 || !NOUN_RE.test(t) || /\b(?:at|with|in|on|for|of|@)\b/i.test(t)) return title;
    let v = null;
    if (loc && loc.text) {
      const first = loc.text.split(',')[0].trim();
      const m = /^(?:the\s+)?[A-Z][\p{L}\p{N}'’&.-]*(?:\s+(?:[A-Z][\p{L}\p{N}'’&.-]*|of|the|and|&)){0,5}/u.exec(first);
      if (m && !/^\d/.test(first) && !VENUE_NOT.test(m[0]) && !placeIsAddress(first)) v = m[0].replace(/\s+(?:of|the|and|&)$/i, '');
    }
    if (!v) {
      // a home, named on a line of the message: 'at Aunt Rita's', 'at Sam’s'
      for (const i of lines) {
        const l = this.line(i);
        const m = l && /\bat\s+((?:[A-Z][\p{L}'’-]*\s+){0,2}[A-Z][\p{L}-]*['’]s)(?![\p{L}])/u.exec(l.text);
        if (m) {
          v = m[1];
          break;
        }
      }
    }
    if (!v || v.split(/\s+/).length > 6 || words(t).some((w) => words(v).includes(w))) return title;
    return { ...title, text: `${t} at ${v}` };
  }

  // The couple an invitation is for: 'A & B' on one line, or 'A' / '&' / 'B' on three, in a
  // document about a wedding.
  couple() {
    if (this._couple !== undefined) return this._couple;
    this._couple = null;
    if (!/\b(?:marriage|wedding|married|marry|nuptials|celebration\s+of\s+(?:their\s+)?(?:love|union))\b/i.test(this.text)) return null;
    const NAME = /^[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3}$/u;
    const NOT = /\b(?:ceremony|reception|dinner|dancing|drinks|cocktails|brunch|lunch|party|music|food|games|friends|famil(?:y|ies)|guests|hotel|travel|registry|rsvp|details|schedule|parking|accommodations?|photos?|gifts?|faq|story|home|events?|wedding|celebration)\b/i;
    const ok = (s) => NAME.test(s) && !NOT.test(s);
    const lines = this.L.lines;
    for (let i = 0; i < lines.length; i++) {
      const t = tidy(lines[i].text);
      const m = /^(.+?)\s+(?:&|and|\+)\s+(.+?)(?:\s+(?:are|will\s+be|request|invite|joyfully|together|would\s+love|cordially)\b.*)?$/.exec(t);
      if (m && ok(m[1]) && ok(m[2])) return (this._couple = { a: m[1], b: m[2], span: [lines[i].start, lines[i].end] });
      const a = lines[i - 1];
      const b = lines[i + 1];
      if (/^(?:&|and|\+)$/i.test(t) && a && b && a.page === lines[i].page && b.page === lines[i].page && ok(tidy(a.text)) && ok(tidy(b.text))) return (this._couple = { a: tidy(a.text), b: tidy(b.text), span: [a.start, b.end] });
    }
    return null;
  }

  // A practice named as the sender of a reminder or a call: "this is Karen from Dr. Lee's
  // office", 'Bright Smile Dental: ...', '... calling from Hyde Park Eye Care'.
  providerOffice() {
    if (this._office !== undefined) return this._office;
    const T = this.text;
    // (the kind of practice in either case: 'Eye Care', 'eye care')
    const ci = (s) => s.replace(/\\.|[a-z]/g, (c) => (c.length > 1 ? c : `[${c.toUpperCase()}${c}]`));
    const KIND = `(?:${ci(String.raw`dental(?:\s+(?:care|group|studio|office|associates))?|dentistry|orthodontics|clinic|medical(?:\s+(?:center|group|clinic))?|health(?:\s+center)?|pediatrics|optometry|eye\s+care|vision(?:\s+center)?|salon|spa|barbers?(?:hop)?|animal\s+hospital|vet(?:erinary)?(?:\s+(?:clinic|hospital))?|physical\s+therapy|chiropractic|dermatology|family\s+medicine|urgent\s+care|surgery|medical\s+practice|dental\s+practice|health\s+centre|medical\s+centre|opticians?|pharmacy`)})`;
    const office = new RegExp(String.raw`\b(?:from|at|with)\s+((?:Dr\.?|Doctor)\s+[A-Z][\p{L}'’-]+(?:['’]s)\s+(?:office|clinic|practice|surgery)|(?:[A-Z][\p{L}'’&-]*\s+){1,3}${KIND})(?![\p{L}])`, 'u');
    let m = office.exec(T);
    // the sender of a text: 'Bright Smile Dental: Reminder ...'
    if (!m) m = new RegExp(String.raw`^\s*((?:[A-Z][\p{L}'’&-]*\s+){1,3}${KIND})\s*:`, 'u').exec(T);
    this._office = m ? m[1].replace(/\s+/g, ' ').trim() : null;
    return this._office;
  }

  // Who signed a message: its last line is a name alone ('Priya', '- Maya') or ends in one
  // ('... that week. - Dev').
  signer() {
    if (this._signer !== undefined) return this._signer;
    const T = this.text.replace(/\s+$/, '');
    const last = T.slice(T.lastIndexOf('\n') + 1);
    const CLOSE = /^(?:thanks|thank|best|cheers|regards|sincerely|love|xo|ok|okay|yes|no|sure|great)$/i;
    let m = /^\s*[-–—~]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*$/.exec(last);
    if (!m || T.lastIndexOf('\n') < 0) m = /\s[-–—~]\s*([A-Z][a-z]+)\s*$/.exec(last);
    const name = m && !CLOSE.test(m[1]) ? m[1] : null;
    const at = name ? T.lastIndexOf(name) : -1;
    this._signer = name ? { text: name, span: [at, at + name.length] } : null;
    // or one message under its sender's name and time, as a chat app shows it ('Maya Lin  3:42 PM')
    const head = !name && /^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)[ \t]+(?:(?:today|yesterday)(?:[ \t]+at)?[ \t]+)?\d{1,2}:\d{2}[ \t]*(?:[AaPp]\.?[Mm]\.?)?[ \t]*\n(?![^\n]*\n[ \t]*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[ \t]+\d{1,2}:\d{2})/i.exec(this.text);
    if (head && !CLOSE.test(head[1])) {
      const s = this.text.indexOf(head[1]);
      this._signer = { text: head[1], span: [s, s + head[1].length] };
    }
    return this._signer;
  }

  // The heading right over a dated item, when it heads only that item (not a section of several).
  itemHeading(a) {
    const la = this.line(a.line);
    const dated = (l) => this.entsIn(l.start, l.end, (x) => isDateShape(x.shape) && !x.skip && !x.context).length > 0;
    for (let i = a.line - 1, n = 0; i >= 0 && n < 3; i--, n++) {
      const l = this.line(i);
      if (!l || l.page !== la.page || dated(l)) return null;
      if (!l.heading) continue;
      const t = cleanTitle(this.lineWithoutTemporal(i).text);
      if (!goodTitle(t) || labelKey(l.text)) return null;
      // the dated lines it heads, up to the next heading
      let items = 0;
      for (let j = i + 1; j < this.L.lines.length; j++) {
        const m = this.line(j);
        if (m.page !== la.page || m.heading) break;
        if (dated(m)) items++;
      }
      return items === 1 ? { text: t, span: [l.start, l.end], weak: false } : null;
    }
    return null;
  }

  // (counted once per page, again after a date becomes context: asked for every anchor)
  anchorsOnPage(a) {
    const pg = this.line(a.line) ? this.line(a.line).page : 1;
    if (!this._anchorCount) {
      this._anchorCount = new Map();
      for (const e of this.temporal) {
        if (!isDateShape(e.shape) || e.skip || e.context || !this.line(e.line)) continue;
        const p = this.line(e.line).page;
        this._anchorCount.set(p, (this._anchorCount.get(p) || 0) + 1);
      }
    }
    return this._anchorCount.get(pg) || 0;
  }

  // a time-only entity for a date: same row, same sentence, nearby lines in the same region,
  // or the one time on the page when the page has one date (a flyer)
  timeFor(a) {
    const t = this.pickTime(a);
    if (!t) return null;
    // 'Doors 7:00 PM | Show 8:00 PM': the show is the event
    if (timeRole(this.text, t) === 'early') {
      const l = this.line(t.line);
      const main = this.entsIn(l.start, l.end, (x) => x !== t && x.shape === 'time' && !this.used.has(x) && !x.skip && timeRole(this.text, x) === 'main')[0];
      if (main) return main;
      // 'Arrive by 8:40 AM' / 'Appointment time: 9:00 AM' on the next lines
      const near = this.temporal.find((x) => x !== t && x.shape === 'time' && !this.used.has(x) && !x.skip && Math.abs(x.line - t.line) <= 3 && this.line(x.line) && this.line(x.line).page === l.page && timeRole(this.text, x) === 'main');
      if (near) return near;
    }
    return t;
  }

  // the temporal entities whose line is one of lines (indices), in their order
  temporalOnLines(lines, pred) {
    const out = new Set();
    for (const i of lines) {
      const l = this.line(i);
      if (l) for (const x of this.entsIn(l.start, l.end + 1, (y) => y.line === i && TEMPORAL.has(y.type) && (!pred || pred(y)))) out.add(x);
    }
    const order = this.temporalIndex || (this.temporalIndex = new Map(this.temporal.map((x, k) => [x, k])));
    return [...out].sort((x, y) => order.get(x) - order.get(y));
  }

  pickTime(a) {
    const isFree = (e) => e.shape === 'time' && !this.used.has(e) && !e.skip;
    // a date span takes daily hours given apart: 'Aug 14-16 ... Gates 11am-10pm daily.'
    if (a.shape === 'days') {
      const daily = this.temporal.find((e) => e.shape === 'rule' && !this.used.has(e) && !e.skip && e.value.freq === 'DAILY' && e.value.time && !e.value.from && !e.value.until && Math.abs(e.line - a.line) <= 3);
      if (daily) {
        this.use(daily);
        return { type: 'timerange', shape: 'time', value: { start: daily.value.time.start, end: daily.value.time.end }, start: daily.start, end: daily.end, confidence: daily.confidence, line: daily.line, timeZone: daily.timeZone };
      }
    }
    // (only the lines near the anchor are searched first: this runs for every date)
    const la = this.line(a.line);
    const row = la && la.row >= 0 ? this.L.rows[la.row] : null;
    const sameRow = row ? this.temporalOnLines(row.lines, isFree) : [];
    if (sameRow.length) return sameRow.sort((x, y) => Math.abs(x.start - a.end) - Math.abs(y.start - a.end))[0];
    const around = [];
    for (let i = Math.max(0, a.line - 3); i <= a.line + 3 && i < this.L.lines.length; i++) around.push(i);
    const near = (a.line >= 0 ? this.temporalOnLines(around, isFree) : []).filter((e) => {
      const l = this.line(e.line);
      return l && la && l.page === la.page && (l.region === la.region || this.L.kind === 'text') && Math.abs(e.line - a.line) <= 3;
    });
    // a time after the date first, and never one that sits beside another date
    const ok = near.filter((e) => !this.dateOnLine(e.line, a));
    if (ok.length) return ok.sort((x, y) => (x.line < a.line) - (y.line < a.line) || Math.abs(x.line - a.line) - Math.abs(y.line - a.line))[0];
    if (this.anchorsOnPage(a) === 1) {
      const pg = la ? la.page : 1;
      const onPage = this.temporal.filter(isFree).filter((e) => this.line(e.line) && this.line(e.line).page === pg);
      if (onPage.length) return onPage.sort((x, y) => Math.abs(x.line - a.line) - Math.abs(y.line - a.line))[0];
    }
    return null;
  }

  dateOnLine(i, except) {
    const l = this.line(i);
    return !!l && this.entsIn(l.start, l.end, (x) => x !== except && isDateShape(x.shape) && !x.skip).length > 0;
  }

  // the lines an anchor's event can draw on: its paragraph in its region
  blockLines(a) {
    const L = this.L;
    const la = this.line(a.line);
    if (!la) return [];
    const out = [a.line];
    const ok = (l) => l && l.page === la.page && (l.region === la.region || L.kind === 'text' || L.kind === 'markdown' || L.kind === 'html' || L.kind === 'docx');
    const single = this.anchorsOnPage(a) <= 1;
    const reach = single ? 40 : 3;
    for (let i = a.line - 1; i >= 0 && a.line - i <= reach; i--) {
      const l = L.lines[i];
      if (l.page !== la.page) break;
      if (!single && (!ok(l) || this.dateOnLine(i) || /\n[ \t]*\n/.test(this.text.slice(l.end, L.lines[i + 1].start)))) break;
      out.unshift(i);
    }
    for (let i = a.line + 1; i < L.lines.length && i - a.line <= reach; i++) {
      const l = L.lines[i];
      if (l.page !== la.page) break;
      if (!single && (!ok(l) || this.dateOnLine(i) || /\n\s*\n/.test(this.text.slice(L.lines[i - 1].end, l.start)))) break;
      out.push(i);
    }
    return out;
  }

  venueAbove(lineIdx, lines) {
    const l = this.line(lineIdx - 1);
    if (!l || !lines.includes(lineIdx - 1)) return null;
    const t = tidy(l.text);
    if (t.length > 50 || !/^[A-Z0-9]/.test(t) || this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type) || x.type === 'url' || x.type === 'phone').length) return null;
    if (l.heading === 1) return null;
    if (/[.!?]$/.test(t) || t.split(/\s+/).length > 6) return null;
    // (not a chat line: 'Jo: yes!! what time')
    if (/[:!?]/.test(t) || !placeLike(t)) return null;
    return { text: t, span: [l.start, l.end] };
  }

  // A flight: 'Depart 6:05 AM  Chicago, IL (ORD)' / 'Arrive 9:20 AM  Boston, MA (BOS)' under
  // its date. It starts at the departure in the departure's zone and ends at the arrival,
  // which is written in the arrival's zone ('9:20 AM' in Boston is 8:20 in Chicago).
  flightEvents() {
    const train = /\b(?:train|amtrak|rail(?:way)?|eticket|e-ticket|bus|coach|ferry|megabus|greyhound)\b/i.test(this.text);
    if (!/\b(?:flight|boarding|itinerary|airlines?|terminal|gate)\b/i.test(this.text) && !train) return;
    const L = this.L;
    const DEP = /^[ \t]*(?:depart(?:s|ure|ing)?|leaves?|takes?\s+off)\b[ \t:]*/i;
    const ARR = /^[ \t]*(?:arrive(?:s|al)?|arriving|lands?)\b[ \t:]*/i;
    const rowSpan = (i) => {
      const l = this.line(i);
      const r = l.row >= 0 ? L.rows[l.row] : null;
      return r ? [this.line(r.lines[0]).start, this.line(r.lines[r.lines.length - 1]).end] : [l.start, l.end];
    };
    const leg = (i, re) => {
      // (the row, or the line alone when the row starts with something else: 'Boarding 5:35 PM' /
      // 'Departs 6:05 PM' side by side)
      const l = this.line(i);
      let [s, e] = rowSpan(i);
      if (!re.test(this.text.slice(s, e))) {
        if (!re.test(l.text)) return null;
        [s, e] = [l.start, l.end];
      }
      const t = this.entsIn(s, e, (x) => x.shape === 'time' && !this.used.has(x) && !x.skip)[0];
      if (!t) return null;
      const place = tidy(this.text.slice(t.end, e).replace(/\t/g, ' '));
      return { t, place, line: i, span: [s, e] };
    };
    const tv = (x) => (typeof x.t.value === 'string' ? x.t.value : x.t.value.start);
    for (let i = 0; i < L.lines.length; i++) {
      if (this.usedLines.has(i)) continue;
      const dep = leg(i, DEP);
      if (!dep) continue;
      let arr = null;
      for (let j = i + 1; j < L.lines.length && j <= i + 4 && !arr; j++) arr = leg(j, ARR);
      const date = this.dateAbove(i, 8);
      if (!date) continue;
      const day = date.shape === 'days' ? date.value.start : typeof date.value === 'string' ? datePart(date.value) : null;
      if (!day) continue;
      if (!arr) {
        // a boarding pass: its departure, from one airport code to the other ('ORD' / 'Chicago',
        // 'SFO' / 'San Francisco'); the boarding time is when to be at the gate
        const codes = L.lines.map((l, k) => ({ l, k })).filter(({ l }) => /^\s*[A-Z]{3}\s*$/.test(l.text) && !/^(?:THE|AND|FOR|PDT|PST|EDT|EST|CDT|CST|MDT|MST|UTC|GMT)$/.test(l.text.trim()));
        const flight = /\bflight[ \t]*(?:no\.?|number|#)?[ \t:]*([A-Z]{2}|[A-Z]\d|\d[A-Z])[ \t]?(\d{1,4})\b/i.exec(this.text);
        if (!flight || codes.length < 2) continue;
        const cityAfter = (k) => {
          const n = this.line(k + 1);
          return n && /^[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){0,3}$/.test(n.text.trim()) ? n.text.trim() : null;
        };
        const from = codes[0];
        const to = codes[1];
        const fromCity = cityAfter(from.k);
        const toCity = cityAfter(to.k) || to.l.text.trim();
        const z0 = zoneOfPlace(fromCity || '') || (this.docZone && this.docZone.zone) || this.opts.timeZone || null;
        const start = `${day}T${tv(dep)}`;
        const where = fromCity ? `${fromCity} (${from.l.text.trim()})` : from.l.text.trim();
        this.add({ allDay: false, start, end: addMinutes(start, this.defaultMin), endInferred: true, timeZone: z0, recurrence: null, sources: { start: [date.start, date.end], time: [dep.t.start, dep.t.end] }, title: `Flight ${flight[1].toUpperCase()} ${flight[2]} to ${toCity}`, titleSpan: null, location: { text: where, span: [from.l.start, from.l.end] }, description: '', how: 'flight', conf: 0.8, lines: [dep.line] });
        this.use(dep.t);
        this.useAsContext(date);
        this.usedLines.add(dep.line);
        for (const x of this.temporal) if (x.shape === 'time' && !this.used.has(x) && /\bboard(?:ing|s)?\b[ \t:]*$/i.test(this.text.slice(Math.max(0, x.start - 16), x.start))) this.useAsContext(x);
        continue;
      }
      const z0 = zoneOfPlace(dep.place) || (this.docZone && this.docZone.zone) || this.opts.timeZone || null;
      const z1 = zoneOfPlace(arr.place) || z0;
      const [y, m, d] = day.split('-').map(Number);
      const [h0, mi0] = tv(dep).split(':').map(Number);
      const [h1, mi1] = tv(arr).split(':').map(Number);
      const t0 = localToUtc(y, m, d, h0, mi0, z0 || 'UTC');
      let t1 = localToUtc(y, m, d, h1, mi1, z1 || 'UTC');
      while (t1 <= t0) t1 += 86400000; // lands the next day
      const w = utcToLocal(t1, z0 || 'UTC');
      const pad = (n) => String(n).padStart(2, '0');
      const end = `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
      const code = /\bflight[ \t]*(?:no\.?|number|#)?[ \t:]*([A-Z]{2}|[A-Z]\d|\d[A-Z])[ \t]?(\d{1,4})\b/i.exec(this.text);
      const city = tidy(arr.place.split(/[,(]/)[0]);
      // a train or a bus by its line ('Train 351 Wolverine', 'Bus 1042'), when there is no flight
      const run = !code && train ? /^[ \t]*((?:Train|Bus|Coach|Ferry)[ \t]+(?:No\.?|#)?[ \t]*\d{1,5}(?:[ \t]+[A-Z][\w'’-]*){0,3})[ \t]*$/im.exec(this.text) : null;
      const title = run ? `${tidy(run[1])}${city ? ` to ${city}` : ''}` : `Flight${code ? ` ${code[1].toUpperCase()} ${code[2]}` : ''}${city ? ` to ${city}` : ''}`;
      this.add({ allDay: false, start: `${day}T${tv(dep)}`, end, timeZone: z0, recurrence: null, sources: { start: [date.start, date.end], time: [dep.t.start, dep.t.end], end: [arr.t.start, arr.t.end] }, title, titleSpan: null, location: dep.place ? { text: dep.place, span: [dep.t.end, dep.span[1]] } : null, description: arr.place ? `Arrives ${tv(arr)} ${arr.place}` : '', how: 'flight', conf: 0.85, lines: [dep.line, arr.line] });
      this.use(dep.t);
      this.use(arr.t);
      this.useAsContext(date);
      this.usedLines.add(dep.line);
      this.usedLines.add(arr.line);
    }
  }

  // Where a whole programme happens, for its sessions that say nothing of their own: 'All
  // matches at Soldier Field', or a place line under the title ('Gleacher Center, 450 N
  // Cityfront Plaza Dr' / 'Friday, December 4, 2026 · Indiana Dunes State Park Pavilion').
  docVenue(page) {
    this.venues = this.venues || new Map();
    if (this.venues.has(page)) return this.venues.get(page);
    let best = null;
    const L = this.L;
    const ALL = /^\s*(?:all|every)\s+(?:of\s+(?:the|our)\s+)?(?:[\w-]+\s+){0,2}?(?:sessions?|events?|matches|games|classes|lectures|talks|meetings|rehearsals|workshops|races|shows|performances|screenings|services|practices|activities|panels|exams)\s+(?:are\s+|will\s+be\s+|take\s+place\s+|happen\s+|meet\s+)?(?:held\s+)?(?:at|in)\s+/i;
    for (let i = 0; i < L.lines.length && !best; i++) {
      const l = L.lines[i];
      if (l.page !== page) continue;
      const m = ALL.exec(l.text);
      if (!m) continue;
      const p = this.placePhrase(l.start + m[0].length, l.end);
      if (p) best = { text: p.text, span: p.span };
    }
    // a place line near the top (after the title, before the programme)
    const first = L.lines.findIndex((l) => l.page === page);
    for (let i = first; i >= 0 && i < first + 6 && i < L.lines.length && !best; i++) {
      const l = L.lines[i];
      if (l.page !== page || l.heading === 1 || l.table || labelKey(l.text) || inlineLabel(l.text)) continue;
      const blanked = this.lineWithoutTemporal(i).text;
      if (blanked === l.text && this.entsIn(l.start, l.end, (x) => TEMPORAL.has(x.type)).length) continue;
      let off = 0;
      for (const piece of blanked.split(/\s+[·•|]\s+|\t/)) {
        const at = blanked.indexOf(piece, off);
        off = at + piece.length;
        const t = tidy(piece);
        if (!t || t.length < 4) continue;
        const s0 = l.start + at;
        const loc = this.entsIn(s0, s0 + piece.length, (x) => x.type === 'location');
        const words = t.replace(/[,()]/g, ' ').split(/\s+/).filter(Boolean);
        const titled = words.length <= 9 && words.every((w) => /^(?:[A-Z0-9][\w'’&.-]*|of|the|and|&|de|la|at|on)$/.test(w)) && /^[A-Z0-9]/.test(t);
        const covered = loc.reduce((n, x) => n + (x.end - x.start), 0) >= 0.6 * t.length;
        if ((titled && placeLike(t)) || covered) {
          best = { text: t, span: [s0, s0 + piece.length] };
          break;
        }
      }
    }
    this.venues.set(page, best);
    return best;
  }

  describe(a, lines, title, loc) {
    const out = [];
    for (const i of lines) {
      const l = this.line(i);
      const t = tidy(this.rowText(i).replace(/\t/g, ' '));
      if (!t) continue;
      if (title.span && l.start >= title.span[0] && l.end <= title.span[1]) continue;
      if (loc && loc.span && l.start >= loc.span[0] - 1 && l.end <= loc.span[1] + 1) continue;
      out.push(t);
    }
    const s = out.join('\n');
    return s.length > 600 ? s.slice(0, 597) + '...' : s;
  }

  // times with no date anywhere: the next time that clock time comes round. Only in a message
  // ('meet at 7pm?', a chat screenshot): a page, a PDF or a Word file with a time and no date
  // has no event today ('the store opens its doors at 5:30 pm'). The show, not the doors; and
  // not when the time's line has a date that did not parse ('Party Nov 31 at 7pm').
  orphanTimes() {
    if (this.events.length) return;
    if (!/^(?:text|image)$/.test(this.L.kind || 'text')) return;
    const free = this.temporal.filter((e) => e.shape === 'time' && !this.used.has(e) && !e.skip);
    if (!free.length) return;
    const e = free.find((x) => timeRole(this.text, x) === 'main') || free.find((x) => timeRole(this.text, x) !== 'early') || free[0];
    const ln = this.line(e.line);
    if (ln) {
      let rest = this.text.slice(ln.start, ln.end);
      for (const x of this.entsIn(ln.start, ln.end, (y) => y.type !== 'time' && y.type !== 'timerange')) {
        const a = Math.max(0, x.start - ln.start);
        const b = Math.min(rest.length, x.end - ln.start);
        if (b > a) rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
      }
      if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/i.test(rest)) return;
    }
    const now = this.nowParts();
    const v = typeof e.value === 'string' ? e.value : e.value.start;
    const date = v > now.time ? now.iso : addDays(now.iso, 1);
    const fake = { type: 'date', shape: 'date', value: date, start: e.start, end: e.end, confidence: 0.4, line: e.line };
    const tm = this.timing(fake, e, null);
    if (!tm) return;
    tm.sources.start = [e.start, e.end];
    const title = this.titleNear(e) || this.subject || this.headingFor(e.line) || { text: 'Event', span: null };
    const lines = this.blockLines(e);
    const places = this.placeNear(e, lines).sort((x, y) => y.score - x.score);
    this.add({ ...tm, title: title.text, titleSpan: title.span, location: places[0] ? { text: places[0].text, span: places[0].span } : null, description: '', how: 'time', conf: 0.4, lines });
    this.use(e);
  }

  nowParts() {
    if (this._now) return this._now;
    const ctx = { timeZone: this.opts.timeZone };
    const ms = this.opts.now instanceof Date ? this.opts.now.getTime() : this.opts.now ? Date.parse(this.opts.now) : Date.now();
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = {};
    for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
    this._now = { iso: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    return this._now;
  }

  /* ---------- bookkeeping ---------- */

  get usedLines() {
    if (!this._usedLines) this._usedLines = new Set();
    return this._usedLines;
  }

  use(e) {
    if (e) this.used.add(e);
  }

  useAsContext(e) {
    if (!e) return;
    this.used.add(e);
    e.context = true;
    this._anchorCount = null;
  }

  add(ev) {
    const e = {
      title: ev.title,
      start: ev.start,
      end: ev.end,
      allDay: !!ev.allDay,
      timeZone: ev.allDay ? null : ev.timeZone || null,
      // (a place not yet known is no place: 'room TBA', 'Location TBD')
      location: ev.location && !/^(?:(?:room|rm\.?|location|venue|place|hall|building|address|where)\s*:?\s*)?(?:TBA|TBD|TBC|to\s+be\s+(?:announced|determined|confirmed))\.?$/i.test(tidy(ev.location.text)) ? ev.location.text : null,
      recurrence: ev.recurrence || null,
      description: ev.description || '',
      url: ev.url ? ev.url.text : null,
      confidence: Math.round(Math.max(0.05, Math.min(1, ev.conf)) * 100) / 100,
      sources: { ...ev.sources },
    };
    if (ev.endInferred) e.endInferred = true;
    if (ev.weekdayMismatch) {
      const w = ev.weekdayMismatch;
      const said = w.written ? WEEKDAY_NAMES[DAY_CODES.indexOf(w.written)] : 'another day';
      const real = w.date ? WEEKDAY_NAMES[weekdayOf(...w.date.split('-').map(Number))] : null;
      e.warnings = [{ type: 'weekday-mismatch', text: `The text says ${said}, but ${w.date} is a ${real}.`, span: w.span }];
    }
    if (ev.titleSpan) e.sources.title = narrow(this.text, ev.titleSpan, e.title);
    if (ev.location && ev.location.span) e.sources.location = ev.location.span;
    if (ev.url && ev.url.span) e.sources.url = ev.url.span;
    if (ev.recurrence && e.sources.start) e.sources.recurrence = e.sources.start;
    for (const k of Object.keys(e.sources)) if (!e.sources[k]) delete e.sources[k];
    Object.defineProperty(e, '_how', { value: ev.how, enumerable: false });
    Object.defineProperty(e, '_lines', { value: ev.lines || [], enumerable: false });
    this.events.push(e);
    return e;
  }

  finish() {
    // a team's schedule: 'vs Iowa' / 'at Purdue' rows under 'Northwestern Football' are
    // 'Northwestern vs Iowa' (at home: 'Home games at Ryan Field') and 'Northwestern at Purdue'
    const headLine = this.L.lines.find((l) => l.heading) || this.L.lines[0];
    const headText = headLine ? tidy(headLine.text) : '';
    // (the rows' titles may carry the heading: 'Lakeside Volleyball vs Riverside')
    const GAME = new RegExp(`^(?:${headText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:—–-]?\\s*)?(vs\\.?|v\\.?|versus|at|@)\\s+(\\S.*)$`, 'i');
    const games = this.events.filter((e) => (e._how === 'table' || e._how === 'agenda') && GAME.test(e.title));
    if (games.length >= 2 && headText) {
      const team = headLine ? tidy(headLine.text.replace(/\s+(?:(?:men|women|boys|girls)['’]?s\s+)?(?:football|basketball|soccer|baseball|softball|hockey|ice\s+hockey|volleyball|lacrosse|rugby|cricket|tennis|water\s+polo|athletics|varsity|jv|schedule|fixtures|season|\d{4}(?:[-–]\d{2,4})?)\b.*$/i, '')) : '';
      const homeAt = /\b(?:[Hh]ome|HOME)\s+(?:[Gg]ames?|GAMES?|[Mm]atches|MATCHES|[Ff]ixtures)\s+(?:are\s+)?(?:at|@|played\s+at)\s+(?:the\s+)?([A-Z][\w'’.&-]*(?:\s+[A-Z][\w'’.&-]*){0,4})/.exec(this.text);
      if (team && team.split(/\s+/).length <= 4 && !/\b(?:vs|at)\b/i.test(team)) {
        for (const e of games) {
          const m = GAME.exec(e.title);
          const away = /^(?:at|@)$/i.test(m[1]);
          const opp = m[2].replace(/^\p{Ll}/u, (c) => c.toUpperCase());
          e.title = `${team} ${away ? 'at' : 'vs'} ${opp}`;
          // (the team's heading is not where a game is)
          if (e.location && sameish(e.location, headText)) e.location = null;
          if (away && !e.location) e.location = opp;
          else if (!away && !e.location && homeAt) e.location = homeAt[1];
          Object.defineProperty(e, '_game', { value: true, enumerable: false });
        }
      }
    }
    // sessions of a programme that name no place: the programme's
    for (const e of this.events) {
      if (e._game || e.location || e.allDay || (e._how !== 'table' && e._how !== 'agenda')) continue;
      const li = e._lines && e._lines.length ? e._lines[0] : -1;
      const v = li >= 0 && this.line(li) ? this.docVenue(this.line(li).page) : null;
      if (v) {
        e.location = v.text;
        if (v.span) e.sources.location = v.span;
      }
    }
    // the same event read twice (a subject line and the body, a heading and a form): keep one
    const out = [];
    for (const e of this.events) {
      // (two sessions at the same time in different rooms are two events)
      // (an email's subject and its body about one slot, 'Interview: Product Designer' and 'Your
      // interview ... from 2:00 to 2:45 PM': the same kind of event, the same start and end)
      const sameKind = (o) => o._how === 'text' && e._how === 'text' && !o.allDay && !e.allDay && !o.endInferred && !e.endInferred && o.end === e.end && nounOf(o.title) && nounOf(o.title) === nounOf(e.title);
      const dup = out.find((o) => o.start === e.start && (o.end === e.end || o.allDay === e.allDay || o.endInferred || e.endInferred) && (sameish(o.title, e.title) || overlapLines(o, e) || o.title === 'Event' || e.title === 'Event' || ((!o.location || !e.location || sameish(o.location, e.location)) && (o._how !== e._how || sameKind(o)))));
      if (dup) {
        for (const k of ['location', 'url', 'recurrence']) if (!dup[k] && e[k]) dup[k] = e[k];
        if (dup.endInferred && !e.endInferred && e.end) {
          dup.end = e.end;
          delete dup.endInferred;
        }
        if (!dup.description && e.description) dup.description = e.description;
        continue;
      }
      // an all-day event on a day a timed event of the same text already covers
      if (e.allDay && out.some((o) => !o.allDay && datePart(o.start) === e.start && (sameish(o.title, e.title) || overlapLines(o, e)))) continue;
      const i = out.findIndex((o) => o.allDay && !e.allDay && o.start === datePart(e.start) && (sameish(o.title, e.title) || overlapLines(o, e)));
      if (i >= 0) out.splice(i, 1);
      out.push(e);
    }
    // A day named on its own under the page's title ('June 5, 2027 · Chicago' on a wedding site)
    // when the page has timed events that day: the page's date, not another event. And a day
    // already gone in a document about days to come (a letter's date, the minuted meeting).
    const today = this.nowParts().iso;
    const ahead = out.some((e) => datePart(e.start) >= today);
    const own = (e) => {
      const t = e.sources.title;
      const s = e.sources.start;
      if (!t || !s) return false;
      const li = this.lineAt(s[0]);
      const l = this.line(li);
      return !!l && t[0] >= l.start && t[1] <= l.end;
    };
    const keep = out.filter((e) => {
      if (!e.allDay || e.recurrence) return true;
      const oneDay = e.end === addDays(e.start, 1);
      if (oneDay && !own(e) && out.some((o) => !o.allDay && datePart(o.start) === e.start)) return false;
      if (ahead && e.end <= today) return false;
      return true;
    });
    // a message about one meeting that says where to join it, anywhere in it ('Join on Google
    // Meet: https://...', 'same Zoom link', a zoom.us link): that is its place
    const timed = keep.filter((e) => !e.allDay);
    if (timed.length === 1 && !timed[0].location) {
      const on = this.onlinePlace();
      if (on) {
        timed[0].location = on.text;
        timed[0].sources.location = on.span;
      }
    }
    return keep.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
}

// 'Doors 7pm' is when people arrive; 'Show 8pm' when the event starts.
// A title that only says what kind of event it is ('Free webinar', 'Online workshop').
const TYPE_MOD = /^(?:free|online|live|virtual|public|open|weekly|monthly|annual|yearly|upcoming|next|special|new|regular|interactive|in-person|hybrid|short|quick|community|evening|morning|afternoon|lunchtime|informational|info|our|this|the|a|an|your)$/i;
function typeOnly(t) {
  const ws = String(t || '').toLowerCase().replace(/[^\p{L}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!ws.length || ws.length > 3) return false;
  const rest = ws.filter((w) => !TYPE_MOD.test(w));
  if (rest.length !== 1) return false;
  const m = NOUN_RE.exec(rest[0]);
  return !!m && m[0].length === rest[0].length;
}

// a row's own words, without a roster heading put in front ('Fall Food Drive: Greeter')
const titleText0 = (t) => String(t || '').replace(/^.*:\s+/, '');

function timeRole(text, t) {
  const b = text.slice(Math.max(0, t.start - 24), t.start);
  if (/\b(?:doors?|gates?|arrive|arrival|check-?in|registration|warm-?ups?|pre-?show|reception|seating|be\s+there)\b(?:\s+(?:by|at|time))?[^\d\n]{0,6}$/i.test(b)) return 'early';
  if (/\b(?:show|showtime|starts?|start|begins?|performance|display|fireworks|kick-?off|kickoff|concert|curtain|music|game|match|main\s+event|program(?:me)?|screening|film|ceremony|service|appointment|appt|visit|procedure|exam|interview|lesson|session|tee)\b(?:\s+time)?[^\d\n]{0,6}$/i.test(b)) return 'main';
  return null;
}

// recurrence values with new bounds: { ...value, from, until, start, rrule }
function rebound(v, from, until) {
  const rule = { freq: v.freq, interval: v.interval || 1 };
  if (v.byDay && v.byDay.length) {
    const pos = /^(-?\d+)/.exec(v.byDay[0]);
    if (pos) rule.setPos = +pos[1];
    rule.byDay = v.byDay.map((d) => DAY_CODES.indexOf(d.slice(-2)));
  }
  if (v.byMonthDay) rule.byMonthDay = v.byMonthDay;
  const start = firstOccurrence(rule, from || v.start);
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (v.byDay && v.byDay.length) parts.push(`BYDAY=${v.byDay.join(',')}`);
  if (v.byMonthDay) parts.push(`BYMONTHDAY=${v.byMonthDay}`);
  if (v.count) parts.push(`COUNT=${v.count}`);
  else if (until) parts.push(`UNTIL=${until.replace(/-/g, '')}`);
  return { ...v, from: from || null, until: until || null, start, rrule: parts.join(';') };
}

const usableRule = (v) => !!(v.time || (v.byDay && v.byDay.length) || v.from || v.until || v.byMonthDay || v.count);
const SESSION_WORD = /^(?:lectures?|discussions?|labs?|lab\s+sections?|sections?|seminars?|tutorials?|recitations?|class(?:es)?|office\s+hours|quiz\s+sections?|studio|workshops?|practicals?|problem\s+sessions?|review\s+sessions?|tutorial\s+sections?)$/i;
const TERM_LINE = /\b(?:classes|class|lectures?|course|quarter|semester|term|session|sessions|runs?|dates?|season|program(?:me)?|series|meets?|meeting)\b/i;

// a room or a part of a building, not a venue to name an event after ('Lunch' in the 'Atrium')
const VENUE_NOT = /^(?:the\s+)?(?:(?:main|front|back|upper|lower|north|south|east|west|small|large|big|new|old)\s+)?(?:room|rm\.?|hall|stage|ballroom|atrium|auditorium|lobby|terrace|suite|studio|lab|gym|theater|theatre|salon|lounge|pavilion|track|floor|level|gate|court|field|library|cafeteria|kitchen|courtyard|lawn|patio|rooftop|roof|basement|garage|backyard|office|conference|classroom|chapel|sanctuary|narthex|fellowship|community|online|zoom|google|teams|microsoft|webex|tba|tbd|home|here|there|room\s+\w+)\b/i;
const placeIsAddress = (s) => /^\s*\d/.test(s) || /\b\d{1,5}\s+[NSEW]?\.?\s*[A-Z]/.test(s);
const SERVICE = /^(?:(?:dental\s+|teeth\s+)?cleaning|check-?up|appointment|appt|exam|eye\s+exam|haircut|consultation|consult|follow-?up|physical|adjustment|fitting|vaccination|filling|x-?rays?|visit)$/i;
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
const inlineLabel = (s) => /^[ \t]*[A-Za-z][\w ]{0,20}:/.test(s);

function overlapLines(a, b) {
  const s = new Set(a._lines);
  return b._lines.some((x) => s.has(x));
}

// the event word of a title ('interview' of 'Interview: Product Designer'), singular
function nounOf(t) {
  const m = NOUN_RE.exec(String(t || ''));
  return m ? m[1].toLowerCase() : null;
}

function sameish(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = n(a);
  const y = n(b);
  return x === y || (x && y && (x.includes(y) || y.includes(x)));
}

function stripAt(s) {
  // 'Dinner at Luigi's' -> 'Dinner', 'Volunteer day at the food pantry' -> 'Volunteer day';
  // the place is found separately
  const t = String(s).replace(/\s+(?:at|@)\s+[A-Z][\s\S]*$/, '');
  const m = /\s+(?:at|@)\s+(?:the\s+)?([^,.;:!?]+?)\s*[,.;:!?]?\s*$/.exec(t);
  return m && placeLike(m[1]) ? t.slice(0, m.index) : t;
}

// the span of the title's own words inside a wider span
function narrow(text, span, title) {
  const raw = text.slice(span[0], span[1]).toLowerCase();
  const t = String(title || '').toLowerCase();
  let i = raw.indexOf(t);
  if (i >= 0) return [span[0] + i, span[0] + i + t.length];
  const first = t.split(/\s+/)[0];
  i = first ? raw.indexOf(first) : -1;
  return i >= 0 ? [span[0] + i, span[1]] : span;
}

function blank(piece, ents, base) {
  let t = piece;
  for (const x of ents) {
    const s = Math.max(0, x.start - base);
    const e = Math.min(t.length, x.end - base);
    if (e > s) t = t.slice(0, s) + ' '.repeat(e - s) + t.slice(e);
  }
  return t;
}

const HEADER_ROLES = {
  date: /^(?:date|dates|day|days|when|class date|session date|week of)$/i,
  time: /^(?:time|times|hours?|start|start time|slot|time slot|begins)$/i,
  title: /^(?:topic|topics|session|sessions|event|events|title|subject|activity|activities|lecture|lectures|class|description|what|program|programme|agenda|item|talk|talks|presentation|game|match|opponent|course|module|unit|theme|exam|assessment)$/i,
  where: /^(?:room|rooms|location|locations|venue|where|place|stage|hall|building)$/i,
  host: /^(?:speaker|speakers|instructor|presenter|presenters|host|who|lead|leader|teacher|facilitator|moderator)$/i,
  notes: /^(?:reading|readings|assignment|assignments|due|homework|notes|deliverables?|prep|preparation|materials|hw|reading\s*\/\s*assignment)$/i,
  week: /^(?:week|wk|#|no\.?|session\s*#)$/i,
};
function headerRole(h) {
  const t = String(h || '').replace(/[:：]$/, '').trim();
  for (const [k, re] of Object.entries(HEADER_ROLES)) if (re.test(t)) return k;
  return null;
}

export { cleanTitle };
