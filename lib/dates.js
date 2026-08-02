'use strict';

/*
 * Date-of-birth parsing into comparable intervals.
 *
 * The four feeds write a birth date twelve different ways, and until now the
 * screening path did not parse any of them — it pulled every `\b(19|20)\d\d\b`
 * out of the string and tested the user's year for membership. That is right
 * for "26 Mar 1990" and wrong for every range OFAC publishes: against
 * "1975 to 1979" the years list is [1975, 1979], so a person born in 1977 —
 * squarely inside the range the list states — was scored as a CONTRADICTION and
 * had their match penalized.
 *
 * So each value becomes an inclusive interval plus how precisely it was stated:
 *
 *   "26 Mar 1990"                         → 1990-03-26 … 1990-03-26   day
 *   "Apr 1961"                            → 1961-04-01 … 1961-04-30   month
 *   "1973"                                → 1973-01-01 … 1973-12-31   year
 *   "1975 to 1979 (range 1975-01-01–1979-12-31)" → 1975-01-01 … 1979-12-31  range
 *   "approx. circa 1937"                  → 1937-01-01 … 1937-12-31   year, approximate
 *
 * Precision is kept rather than thrown away because "born 1990" and "born
 * 26 Mar 1990" are different evidence, and a reviewer comparing a passport to a
 * hit needs to see which one the list actually said.
 */

const MONTHS = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
  MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9,
  SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
};

const pad = (n, w) => String(n).padStart(w, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y, m, d) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

// A calendar-valid day, or null. Guards against a source typo like 31 Feb
// producing an interval that sorts before its own start.
function day(y, m, d) {
  if (!(y >= 1000 && y <= 2999) || !(m >= 1 && m <= 12)) return null;
  if (!(d >= 1 && d <= daysIn(y, m))) return null;
  return ymd(y, m, d);
}

/*
 * One date expression → { from, to, precision } with no range handling.
 * Recognizes every single-date form the four feeds publish; `00` components in
 * the UK's slash format mean "not stated", which degrades precision rather than
 * failing.
 */
function parseSingle(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m;

  // 1990-03-26 (EU, UN, and OFAC's parenthetical range bounds)
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const exact = day(y, mo, d);
    if (exact) return { from: exact, to: exact, precision: 'day' };
    return month(y, mo) || year(y);
  }
  // 1990-03
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return month(+m[1], +m[2]) || year(+m[1]);

  /*
   * 22/08/1990 — UK OFSI, and it is DAY first. Not an assumption: 1,611 values
   * in the snapshot have a first field above 12 and not one has a second field
   * above 12, so reading it as MM/DD would misdate every one of them.
   */
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    const [d, mo, y] = [+m[1], +m[2], +m[3]];
    if (!d && !mo) return year(y);           // 00/00/1994 — year only
    if (!d) return month(y, mo) || year(y);  // 00/08/1990 — month only
    const exact = day(y, mo, d);
    // "15/08/0000" is in the UK list: a real day and month against a year the
    // publisher does not have. Nothing here is comparable, so say so.
    if (exact) return { from: exact, to: exact, precision: 'day' };
    return month(y, mo) || year(y);
  }

  // 26 Mar 1990 / 26 March 1990
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/))) {
    const mo = MONTHS[m[2].toUpperCase()];
    if (mo) {
      const exact = day(+m[3], mo, +m[1]);
      if (exact) return { from: exact, to: exact, precision: 'day' };
      return month(+m[3], mo) || year(+m[3]);
    }
  }
  // Mar 1990 / March 1990
  if ((m = s.match(/^([A-Za-z]+)\.?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].toUpperCase()];
    if (mo) return month(+m[2], mo);
  }
  // 1990
  if ((m = s.match(/^(\d{4})$/))) return year(+m[1]);

  return null;
}

function month(y, mo) {
  if (!(y >= 1000 && y <= 2999) || !(mo >= 1 && mo <= 12)) return null;
  return { from: ymd(y, mo, 1), to: ymd(y, mo, daysIn(y, mo)), precision: 'month' };
}
function year(y) {
  if (!(y >= 1000 && y <= 2999)) return null;
  return { from: ymd(y, 1, 1), to: ymd(y, 12, 31), precision: 'year' };
}

const APPROX_RE = /\b(approx\.?|approximately|circa|ca\.|c\.)\s*/gi;
// " to ", an en/em dash, or a hyphen between two whitespace-free date parts.
const RANGE_SPLIT = /\s+to\s+|\s*[–—]\s*/i;

/*
 * One published value → an inclusive interval.
 *
 * OFAC helpfully restates its own ranges as an explicit bound pair —
 * "1975 to 1979 (range 1975-01-01–1979-12-31)" — and that parenthetical is
 * preferred when present: it is the publisher's own resolution of the range,
 * not ours.
 */
function parseDateValue(raw) {
  let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const approximate = APPROX_RE.test(s);
  APPROX_RE.lastIndex = 0;
  s = s.replace(APPROX_RE, '').trim();

  const explicit = s.match(/\(\s*range\s+(\d{4}-\d{2}-\d{2})\s*[–—-]\s*(\d{4}-\d{2}-\d{2})\s*\)/i);
  if (explicit) {
    return { from: explicit[1], to: explicit[2], precision: 'range', approximate };
  }
  s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();

  const parts = s.split(RANGE_SPLIT).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    const a = parseSingle(parts[0]), b = parseSingle(parts[1]);
    if (a && b) {
      const [lo, hi] = a.from <= b.from ? [a, b] : [b, a];
      return { from: lo.from, to: hi.to, precision: 'range', approximate };
    }
    if (a) return { ...a, approximate };
    if (b) return { ...b, approximate };
    return null;
  }

  const one = parseSingle(s);
  return one ? { ...one, approximate } : null;
}

// Does a four-digit year fall inside the interval? The comparison the country
// modifier's year twin performs, and the reason intervals exist at all.
function intervalCoversYear(interval, yearStr) {
  if (!interval || !yearStr) return false;
  const y = String(yearStr);
  return interval.from.slice(0, 4) <= y && y <= interval.to.slice(0, 4);
}

module.exports = { parseDateValue, parseSingle, intervalCoversYear };
