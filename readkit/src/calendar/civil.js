// Calendar arithmetic on plain dates and wall-clock times, with no time zone involved:
// '2026-10-21', '2026-10-21T19:00'. Months are 1-12, weekdays 0 (Sunday) to 6. Pure.

export const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86400000;

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function daysIn(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function validDate(y, m, d) {
  return Number.isInteger(y) && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

export const isoDate = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export const isoTime = (h, mi) => `${pad(h)}:${pad(mi)}`;

// 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM[:SS]' -> { y, m, d, h, mi, s, time: boolean }
export function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0, time: !!m[4] };
}

export const dayNumber = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);

export function fromDayNumber(n) {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

export function addDays(iso, n) {
  const p = parseIso(iso);
  const t = fromDayNumber(dayNumber(p.y, p.m, p.d) + n);
  const date = isoDate(t.y, t.m, t.d);
  return p.time ? `${date}T${isoTime(p.h, p.mi)}` : date;
}

// Wall-clock minutes added to 'YYYY-MM-DDTHH:MM' (no zone: a 60-minute event is 60 minutes on the clock).
export function addMinutes(iso, minutes) {
  const p = parseIso(iso);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) + minutes * 60000);
  return `${isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())}T${isoTime(t.getUTCHours(), t.getUTCMinutes())}`;
}

// Minutes from a to b (both 'YYYY-MM-DDTHH:MM' or dates), on the wall clock.
export function minutesBetween(a, b) {
  const p = parseIso(a);
  const q = parseIso(b);
  return Math.round((Date.UTC(q.y, q.m - 1, q.d, q.h, q.mi) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi)) / 60000);
}

export const daysBetween = (a, b) => {
  const p = parseIso(a);
  const q = parseIso(b);
  return dayNumber(q.y, q.m, q.d) - dayNumber(p.y, p.m, p.d);
};

// The first date on or after `from` (ISO date) that falls on weekday `wd`.
export function nextWeekday(from, wd, strictlyAfter = false) {
  const p = parseIso(from);
  let n = dayNumber(p.y, p.m, p.d);
  if (strictlyAfter) n++;
  const cur = new Date(n * DAY_MS).getUTCDay();
  n += (wd - cur + 7) % 7;
  const t = fromDayNumber(n);
  return isoDate(t.y, t.m, t.d);
}

// The n-th (1..5, or -1 for the last) weekday `wd` of a month, or null.
export function nthWeekdayOfMonth(y, m, wd, n) {
  if (n > 0) {
    const first = weekdayOf(y, m, 1);
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= daysIn(y, m) ? isoDate(y, m, d) : null;
  }
  const last = daysIn(y, m);
  const lw = weekdayOf(y, m, last);
  return isoDate(y, m, last - ((lw - wd + 7) % 7));
}

export const datePart = (iso) => String(iso).slice(0, 10);
export const timePart = (iso) => (String(iso).length > 10 ? String(iso).slice(11, 16) : null);
export const compareIso = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
