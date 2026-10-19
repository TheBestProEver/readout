// toICS(events, { now, prodId, name, method }) -> an iCalendar (RFC 5545) file as a string.
//
// Each event is a VEVENT with UID (stable: the same event gives the same UID, so importing a
// snap twice updates rather than duplicates), DTSTAMP, DTSTART/DTEND (dates for all-day
// events; TZID for named zones, with a VTIMEZONE built from the platform's own zone data;
// UTC for UTC and fixed offsets; floating otherwise), RRULE, SUMMARY, LOCATION, DESCRIPTION
// and URL. Text is escaped, lines end in CRLF and are folded at 75 octets.

import { parseIso, pad, isoDate } from './civil.js';
import { isoToUtc, offsetAt, utcToLocal, shortName, isFixedZone, localToUtc } from './tz.js';

const DAY = 86400000;
const enc = new TextEncoder();

export function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Lines longer than 75 octets go on as continuation lines starting with a space; a UTF-8
// character is never split.
export function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // the leading space counts
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const compact = (iso) => {
  const p = parseIso(iso);
  return p.time ? `${pad(p.y, 4)}${pad(p.m)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}` : `${pad(p.y, 4)}${pad(p.m)}${pad(p.d)}`;
};
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function fnv(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function uidOf(e) {
  const key = [e.title, e.start, e.end, e.location || '', e.recurrence || ''].join('|');
  return `${fnv(key, 2166136261)}${fnv(key, 0x9747b28c)}@readkit`;
}

const offStr = (min) => {
  const s = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${s}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
};

// Offset changes of a zone between two instants, found day by day and then to the minute.
function transitions(tz, from, to) {
  const out = [];
  let prev = offsetAt(tz, from);
  for (let t = from + DAY; t <= to; t += DAY) {
    const o = offsetAt(tz, t);
    if (o === prev) continue;
    let lo = t - DAY;
    let hi = t;
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
      if (mid <= lo) break;
      if (offsetAt(tz, mid) === prev) lo = mid;
      else hi = mid;
    }
    out.push({ at: hi, from: prev, to: o });
    prev = o;
  }
  return { first: offsetAt(tz, from), list: out };
}

// A VTIMEZONE for an IANA zone covering the given years.
export function vtimezone(tz, y0, y1) {
  const from = Date.UTC(y0, 0, 1);
  const to = Date.UTC(y1 + 1, 0, 1);
  const { first, list } = transitions(tz, from, to);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (!list.length) {
    lines.push('BEGIN:STANDARD', `DTSTART:${y0}0101T000000`, `TZOFFSETFROM:${offStr(first)}`, `TZOFFSETTO:${offStr(first)}`);
    const n = shortName(tz, from);
    if (n) lines.push(`TZNAME:${n}`);
    lines.push('END:STANDARD');
  } else {
    // the offset in force before the first change, then each change
    const minOff = Math.min(first, ...list.map((x) => x.to));
    for (const x of list) {
      const local = x.at + x.from * 60000;
      const kind = x.to > minOff ? 'DAYLIGHT' : 'STANDARD';
      lines.push(`BEGIN:${kind}`, `DTSTART:${utcStamp(local).replace('Z', '')}`, `TZOFFSETFROM:${offStr(x.from)}`, `TZOFFSETTO:${offStr(x.to)}`);
      const n = shortName(tz, x.at + 60000);
      if (n) lines.push(`TZNAME:${n}`);
      lines.push(`END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

function yearsOf(e) {
  const y = +String(e.start).slice(0, 4);
  let last = +String(e.end || e.start).slice(0, 4);
  if (e.recurrence) {
    const u = /UNTIL=(\d{4})/.exec(e.recurrence);
    last = u ? Math.max(last, +u[1]) : last + 3;
  }
  return [y, last];
}

/**
 * toICS(events, { now, prodId, name, method }) -> string
 *   now: DTSTAMP (default: the clock); name: X-WR-CALNAME
 */
export function toICS(events, opts = {}) {
  const list = Array.isArray(events) ? events : [events];
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : opts.now ? Date.parse(opts.now) : Date.now();
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${opts.prodId || '-//readkit//CalSnap//EN'}`, 'CALSCALE:GREGORIAN', `METHOD:${opts.method || 'PUBLISH'}`];
  if (opts.name) out.push(`X-WR-CALNAME:${escapeText(opts.name)}`);
  // one VTIMEZONE per named zone, spanning every year its events reach
  const zones = new Map();
  for (const e of list) {
    if (!e || e.allDay || !e.timeZone || isFixedZone(e.timeZone)) continue;
    const [a, b] = yearsOf(e);
    const z = zones.get(e.timeZone);
    zones.set(e.timeZone, z ? [Math.min(z[0], a), Math.max(z[1], b)] : [a, b]);
  }
  for (const [tz, [a, b]] of zones) out.push(...vtimezone(tz, a - 1, b + 1));
  for (const e of list) {
    if (!e || !e.start) continue;
    out.push('BEGIN:VEVENT');
    out.push(`UID:${e.uid || uidOf(e)}`);
    out.push(`DTSTAMP:${utcStamp(nowMs)}`);
    const when = (prop, iso) => {
      if (!iso) return;
      if (e.allDay || iso.length <= 10) return out.push(`${prop};VALUE=DATE:${compact(iso.slice(0, 10))}`);
      const tz = e.timeZone;
      if (!tz) return out.push(`${prop}:${compact(iso)}`);
      if (isFixedZone(tz)) return out.push(`${prop}:${compact(isoToUtc(iso, tz).replace('Z', ''))}Z`);
      out.push(`${prop};TZID=${tz}:${compact(iso)}`);
    };
    when('DTSTART', e.start);
    if (e.end) when('DTEND', e.end);
    if (e.recurrence) out.push(`RRULE:${String(e.recurrence).replace(/^RRULE:/i, '')}`);
    out.push(`SUMMARY:${escapeText(e.title || 'Event')}`);
    if (e.location) out.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) out.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) out.push(`URL:${String(e.url).replace(/[\r\n]+/g, '')}`);
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

export { utcToLocal, localToUtc, isoDate };
