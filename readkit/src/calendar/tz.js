// Time zones: names people write ('ET', 'BST', 'UTC+1', 'London time') to IANA zones, and
// wall-clock <-> UTC conversion through Intl (no zone data of our own). Fixed offsets use
// ECMA-402 offset zones ('+05:30'); UTC is 'UTC'.

import { pad, isoDate, isoTime, weekdayOf } from './civil.js';

// Abbreviations. The US ones name the zone, not the season: '3pm EST' in July is meant as
// New York time, which is what people mean (and what calendars do).
export const ABBREVIATIONS = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York', EASTERN: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago', CENTRAL: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver', MOUNTAIN: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PACIFIC: 'America/Los_Angeles',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage', AKT: 'America/Anchorage', ALASKA: 'America/Anchorage',
  HST: 'Pacific/Honolulu', HAST: 'Pacific/Honolulu', HT: 'Pacific/Honolulu', HAWAII: 'Pacific/Honolulu',
  AST: 'America/Halifax', ADT: 'America/Halifax', ATLANTIC: 'America/Halifax', NST: 'America/St_Johns', NDT: 'America/St_Johns',
  GMT: 'UTC', UTC: 'UTC', Z: 'UTC', UT: 'UTC', ZULU: 'UTC',
  BST: 'Europe/London', UK: 'Europe/London', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon', IST_IE: 'Europe/Dublin',
  CET: 'Europe/Paris', CEST: 'Europe/Paris', MEZ: 'Europe/Berlin', MESZ: 'Europe/Berlin', EET: 'Europe/Athens', EEST: 'Europe/Athens',
  MSK: 'Europe/Moscow', IST: 'Asia/Kolkata', PKT: 'Asia/Karachi', SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong',
  JST: 'Asia/Tokyo', KST: 'Asia/Seoul', CST_CN: 'Asia/Shanghai', AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide', AWST: 'Australia/Perth', NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
  SAST: 'Africa/Johannesburg', WAT: 'Africa/Lagos', EAT: 'Africa/Nairobi', GST: 'Asia/Dubai', ICT: 'Asia/Bangkok',
  BRT: 'America/Sao_Paulo', ART: 'America/Argentina/Buenos_Aires',
};

// '<place> time': 'London time', 'New York time', 'UK time'.
export const PLACES = {
  london: 'Europe/London', uk: 'Europe/London', british: 'Europe/London', england: 'Europe/London', edinburgh: 'Europe/London', manchester: 'Europe/London',
  dublin: 'Europe/Dublin', irish: 'Europe/Dublin', paris: 'Europe/Paris', berlin: 'Europe/Berlin', madrid: 'Europe/Madrid', rome: 'Europe/Rome',
  amsterdam: 'Europe/Amsterdam', brussels: 'Europe/Brussels', zurich: 'Europe/Zurich', stockholm: 'Europe/Stockholm', lisbon: 'Europe/Lisbon',
  athens: 'Europe/Athens', moscow: 'Europe/Moscow', 'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York',
  washington: 'America/New_York', dc: 'America/New_York', toronto: 'America/Toronto', chicago: 'America/Chicago', texas: 'America/Chicago',
  houston: 'America/Chicago', dallas: 'America/Chicago', denver: 'America/Denver', phoenix: 'America/Phoenix', arizona: 'America/Phoenix',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles', seattle: 'America/Los_Angeles',
  vancouver: 'America/Vancouver', california: 'America/Los_Angeles', hawaii: 'Pacific/Honolulu', alaska: 'America/Anchorage', 'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo', india: 'Asia/Kolkata', delhi: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', dubai: 'Asia/Dubai',
  singapore: 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', china: 'Asia/Shanghai', tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo', seoul: 'Asia/Seoul', korea: 'Asia/Seoul', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane',
  perth: 'Australia/Perth', auckland: 'Pacific/Auckland', 'new zealand': 'Pacific/Auckland', johannesburg: 'Africa/Johannesburg', lagos: 'Africa/Lagos',
  nairobi: 'Africa/Nairobi', cairo: 'Africa/Cairo', eastern: 'America/New_York', central: 'America/Chicago', mountain: 'America/Denver', pacific: 'America/Los_Angeles',
  greenwich: 'UTC', universal: 'UTC',
};

// Where a place is, for itineraries: an airport code ('(BOS)'), a US state or Canadian province
// after a city ('Boston, MA'), or a city named above. Multi-zone states take their main zone.
const AIRPORTS = {
  ATL: 'America/New_York', BOS: 'America/New_York', BWI: 'America/New_York', CLT: 'America/New_York', DCA: 'America/New_York', DTW: 'America/Detroit',
  EWR: 'America/New_York', FLL: 'America/New_York', IAD: 'America/New_York', JFK: 'America/New_York', LGA: 'America/New_York', MCO: 'America/New_York',
  MIA: 'America/New_York', PHL: 'America/New_York', PIT: 'America/New_York', RDU: 'America/New_York', TPA: 'America/New_York', YYZ: 'America/Toronto', YUL: 'America/Toronto',
  ORD: 'America/Chicago', MDW: 'America/Chicago', DFW: 'America/Chicago', DAL: 'America/Chicago', IAH: 'America/Chicago', HOU: 'America/Chicago', MSP: 'America/Chicago',
  STL: 'America/Chicago', MSY: 'America/Chicago', AUS: 'America/Chicago', MKE: 'America/Chicago', MCI: 'America/Chicago', BNA: 'America/Chicago',
  DEN: 'America/Denver', SLC: 'America/Denver', PHX: 'America/Phoenix', LAS: 'America/Los_Angeles', LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles',
  SJC: 'America/Los_Angeles', OAK: 'America/Los_Angeles', SAN: 'America/Los_Angeles', SEA: 'America/Los_Angeles', PDX: 'America/Los_Angeles', YVR: 'America/Vancouver',
  ANC: 'America/Anchorage', HNL: 'Pacific/Honolulu', MEX: 'America/Mexico_City', CUN: 'America/Cancun', LHR: 'Europe/London', LGW: 'Europe/London', DUB: 'Europe/Dublin',
  CDG: 'Europe/Paris', AMS: 'Europe/Amsterdam', FRA: 'Europe/Berlin', MUC: 'Europe/Berlin', MAD: 'Europe/Madrid', BCN: 'Europe/Madrid', FCO: 'Europe/Rome',
  ZRH: 'Europe/Zurich', IST: 'Europe/Istanbul', DXB: 'Asia/Dubai', DEL: 'Asia/Kolkata', BOM: 'Asia/Kolkata', BLR: 'Asia/Kolkata', SIN: 'Asia/Singapore',
  HKG: 'Asia/Hong_Kong', NRT: 'Asia/Tokyo', HND: 'Asia/Tokyo', ICN: 'Asia/Seoul', PEK: 'Asia/Shanghai', PVG: 'Asia/Shanghai', SYD: 'Australia/Sydney', MEL: 'Australia/Melbourne',
};
const REGIONS = {
  CT: 'America/New_York', DC: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', IN: 'America/Indiana/Indianapolis',
  KY: 'America/New_York', MA: 'America/New_York', MD: 'America/New_York', ME: 'America/New_York', MI: 'America/Detroit', NC: 'America/New_York', NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VA: 'America/New_York',
  VT: 'America/New_York', WV: 'America/New_York', AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago', IL: 'America/Chicago', KS: 'America/Chicago',
  LA: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago', ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago', AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise',
  MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver', CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  WA: 'America/Los_Angeles', AK: 'America/Anchorage', HI: 'Pacific/Honolulu', ON: 'America/Toronto', QC: 'America/Toronto', BC: 'America/Vancouver', AB: 'America/Edmonton',
};
export function zoneOfPlace(s) {
  const t = String(s || '');
  const code = /\(([A-Z]{3})\)|\b([A-Z]{3})\b(?=\s*$)/.exec(t);
  if (code && AIRPORTS[code[1] || code[2]]) return AIRPORTS[code[1] || code[2]];
  const st = /,\s*([A-Z]{2})\b/.exec(t);
  if (st && REGIONS[st[1]]) return REGIONS[st[1]];
  const low = t.toLowerCase();
  for (const [name, tz] of Object.entries(PLACES)) if (name.length > 3 && !/^(?:eastern|central|mountain|pacific|universal|greenwich)$/.test(name) && new RegExp(`\\b${name}\\b`).test(low)) return tz;
  return null;
}

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

export function isZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    formatter(tz);
    return true;
  } catch (e) {
    return false;
  }
}

// '+01:00' style for a fixed offset in minutes.
export function offsetZone(minutes) {
  if (!minutes) return 'UTC';
  const s = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const isFixedZone = (tz) => tz === 'UTC' || /^[+-]\d{2}:\d{2}$/.test(tz || '') || /^Etc\//.test(tz || '');

// Wall-clock parts of a UTC instant in a zone.
export function utcToLocal(ms, tz) {
  if (!tz || tz === 'UTC') {
    const t = new Date(ms);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
  }
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute, s: +parts.second };
}

// Minutes east of UTC in a zone at a UTC instant.
export function offsetAt(tz, ms) {
  if (!tz || tz === 'UTC') return 0;
  const l = utcToLocal(ms, tz);
  const asUtc = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// A wall-clock time in a zone -> UTC ms. In a spring-forward gap the clock time is moved
// on by the gap; in a fall-back overlap the first (daylight) reading wins.
export function localToUtc(y, m, d, h = 0, mi = 0, tz = 'UTC') {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  if (!tz || tz === 'UTC') return guess;
  let off = offsetAt(tz, guess);
  let t = guess - off * 60000;
  const off2 = offsetAt(tz, t);
  if (off2 !== off) {
    t = guess - off2 * 60000;
    if (offsetAt(tz, t) !== off2) t = guess - Math.max(off, off2) * 60000;
  }
  // overlap: prefer the earlier instant
  const earlier = t - 3600000;
  const e = utcToLocal(earlier, tz);
  if (e.y === y && e.m === m && e.d === d && e.h === h && e.mi === mi) t = earlier;
  return t;
}

// 'YYYY-MM-DDTHH:MM' in tz -> 'YYYY-MM-DDTHH:MM:SSZ' (UTC)
export function isoToUtc(iso, tz) {
  const p = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!p) return null;
  const ms = localToUtc(+p[1], +p[2], +p[3], p[4] ? +p[4] : 0, p[5] ? +p[5] : 0, tz);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Today's date and time where the user is: { y, m, d, h, mi, wd, iso }
export function nowIn(now, tz) {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : now ? Date.parse(now) : Date.now();
  const l = utcToLocal(ms, tz || 'UTC');
  return { ...l, wd: weekdayOf(l.y, l.m, l.d), iso: isoDate(l.y, l.m, l.d), time: isoTime(l.h, l.mi), ms };
}

export function defaultZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (e) {
    return null;
  }
}

// A zone's short name at an instant: 'EDT', 'BST', 'GMT+5:30'.
export function shortName(tz, ms) {
  if (!tz || tz === 'UTC') return 'UTC';
  for (const locale of ['en-US', 'en-GB']) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms));
      const n = parts.find((p) => p.type === 'timeZoneName');
      if (n && !/^GMT[+-]/.test(n.value)) return n.value;
      if (n && locale === 'en-GB') return n.value;
    } catch (e) {
      return '';
    }
  }
  return '';
}
