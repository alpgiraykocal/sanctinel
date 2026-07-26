'use strict';

/*
 * Snapshot analytics: aggregate composition of the loaded lists plus the most
 * recently designated parties.
 *
 * Everything here is derived from the SAME immutable snapshot the screening
 * endpoint uses, so a statistic and a search result can never disagree. The
 * result is memoized per snapshot object (a refresh swaps the object and
 * invalidates it) — a full pass over ~38k entities is ~100ms and must not run
 * on every request.
 *
 * Dates: each authority publishes its listing date in its own format — OFAC/EU/
 * UN/BIS in ISO, UK OFSI in DD/MM/YYYY. They are normalized to ISO here so the
 * timeline and the "recent" ranking are comparable across authorities. The date
 * is the AUTHORITY'S designation/publication date, not when we ingested it.
 */

const { canonicalCountry, parseCountries } = require('./countries');

const RECENT_LIMIT = 150;        // most recent designations across all lists
const RECENT_PER_AUTHORITY = 40; // …plus this many per authority, so the
                                 // authority filter is never empty for a list
                                 // that has not published in the global window
const TOP_N = 15;           // rows per "top" breakdown
const TIMELINE_YEARS = 16;
const TIMELINE_MONTHS = 24;

const DAY = 86400000;

// Accepts "YYYY-MM-DD" / ISO timestamps and "D/M/YYYY" (UK OFSI). Returns
// "YYYY-MM-DD", or '' when the value is missing or not a date we can trust.
function normalizeDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // day/month/year
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return '';
}

function bump(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topList(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit == null ? Infinity : limit)
    .map(([name, count]) => ({ name, count }));
}

// Nationality/citizenship where the authority states it, else the address
// country. Counted once per entity so a party with five addresses in the same
// country does not outweigh five separate parties. Labels are normalized across
// authorities (see lib/countries) — otherwise Russia lands in four rows.
function countriesOf(e) {
  const out = new Set();
  for (const a of e.attributes || []) {
    if (a.label === 'Nationality' || a.label === 'Citizenship') {
      for (const c of parseCountries(a.value)) out.add(c);
    }
  }
  if (!out.size) {
    for (const ad of e.addresses || []) {
      const c = canonicalCountry(ad.country);
      if (c) out.add(c);
    }
  }
  return out;
}

const OWNERSHIP_RE = /own|control|subsid|parent|beneficial/i;

function compute(snapshot) {
  const entities = snapshot.entities || [];
  const now = Date.now();

  const byAuthority = new Map(), byList = new Map(), byType = new Map();
  const byMeasure = new Map(), byProgram = new Map(), byCountry = new Map();
  const byYear = new Map(), byMonth = new Map();
  // Per-authority timeline of the trailing months, for the stacked view.
  const monthByAuthority = new Map();

  let dated = 0, withAliases = 0, withIdentifiers = 0, withRelationships = 0;
  let relationshipEdges = 0, ownershipEdges = 0;
  let added30 = 0, added90 = 0, added365 = 0;
  let newest = '', oldest = '';

  const recent = [];

  for (const e of entities) {
    const authority = e.authority || 'OFAC';
    bump(byAuthority, authority);
    bump(byList, e.list);
    bump(byType, e.type || 'Unknown');
    for (const m of e.sanctionsTypes && e.sanctionsTypes.length ? e.sanctionsTypes : (e.sanctionsType ? [e.sanctionsType] : [])) bump(byMeasure, m);
    for (const p of e.programs || []) bump(byProgram, p);
    for (const c of countriesOf(e)) bump(byCountry, c);

    if ((e.names || []).length > 1) withAliases++;
    if ((e.identifiers || []).length || (e.idDocuments || []).length) withIdentifiers++;
    const rels = e.relationships || [];
    if (rels.length) withRelationships++;
    relationshipEdges += rels.length;
    for (const r of rels) if (OWNERSHIP_RE.test(r.type || '')) ownershipEdges++;

    const date = normalizeDate(e.datePublished);
    if (!date) continue;
    dated++;
    if (!newest || date > newest) newest = date;
    if (!oldest || date < oldest) oldest = date;

    bump(byYear, date.slice(0, 4));
    const month = date.slice(0, 7);
    bump(byMonth, month);
    if (!monthByAuthority.has(authority)) monthByAuthority.set(authority, new Map());
    bump(monthByAuthority.get(authority), month);

    const age = now - Date.parse(date + 'T00:00:00Z');
    if (age >= 0) {
      if (age <= 30 * DAY) added30++;
      if (age <= 90 * DAY) added90++;
      if (age <= 365 * DAY) added365++;
    }

    recent.push({
      id: e.id, name: e.name, authority, list: e.list, type: e.type || 'Unknown',
      title: e.title || '', programs: (e.programs || []).slice(0, 6),
      measures: e.sanctionsTypes || (e.sanctionsType ? [e.sanctionsType] : []),
      date,
      aliases: Math.max(0, (e.names || []).length - 1),
      country: [...countriesOf(e)][0] || '',
    });
  }

  recent.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));

  // Global head + each authority's own head. OFAC publishes far more often than
  // the others, so a purely global window would leave the EU/UN/UK/BIS filters
  // showing nothing.
  const picked = new Set(recent.slice(0, RECENT_LIMIT).map((r) => r.id));
  const perAuthority = new Map();
  for (const r of recent) {
    const n = perAuthority.get(r.authority) || 0;
    if (n >= RECENT_PER_AUTHORITY) continue;
    perAuthority.set(r.authority, n + 1);
    picked.add(r.id);
  }
  const recentOut = recent.filter((r) => picked.has(r.id));

  // Trailing window ending at the newest designation in the snapshot, so a list
  // that has not published for a few days does not render as a gap at the edge.
  const endMonth = newest ? newest.slice(0, 7) : new Date(now).toISOString().slice(0, 7);
  const months = [];
  let [ey, em] = endMonth.split('-').map(Number);
  for (let i = 0; i < TIMELINE_MONTHS; i++) {
    const key = `${ey}-${String(em).padStart(2, '0')}`;
    months.unshift(key);
    if (--em === 0) { em = 12; ey--; }
  }
  const authorities = topList(byAuthority, null).map((a) => a.name);

  const endYear = Number(endMonth.slice(0, 4));
  const years = [];
  for (let y = endYear - TIMELINE_YEARS + 1; y <= endYear; y++) years.push(String(y));

  return {
    generatedAt: new Date().toISOString(),
    snapshot: {
      source: snapshot.source, isLive: !!snapshot.isLive,
      publicationId: snapshot.publicationId, publishedDate: snapshot.publishedDate || '',
      retrievedAt: snapshot.retrievedAt,
    },
    totals: {
      entities: entities.length,
      authorities: byAuthority.size,
      lists: byList.size,
      programs: byProgram.size,
      countries: byCountry.size,
      dated,
      undated: entities.length - dated,
      withAliases, withIdentifiers, withRelationships,
      relationshipEdges, ownershipEdges,
      added30, added90, added365,
      newest, oldest,
    },
    byAuthority: topList(byAuthority, null),
    byList: topList(byList, TOP_N),
    byType: topList(byType, null),
    byMeasure: topList(byMeasure, TOP_N),
    byProgram: topList(byProgram, TOP_N),
    byCountry: topList(byCountry, TOP_N),
    timeline: {
      years: years.map((y) => ({ label: y, count: byYear.get(y) || 0 })),
      months: months.map((mk) => ({
        label: mk,
        count: byMonth.get(mk) || 0,
        byAuthority: Object.fromEntries(authorities.map((a) => [a, (monthByAuthority.get(a) || new Map()).get(mk) || 0])),
      })),
      authorities,
    },
    recent: recentOut,
  };
}

let cachedFor = null, cached = null;
function snapshotStats(snapshot) {
  if (cachedFor !== snapshot) {
    const t = Date.now();
    cached = compute(snapshot);
    cachedFor = snapshot;
    console.log(`Stats computed: ${snapshot.count} entities in ${Date.now() - t}ms`);
  }
  return cached;
}

module.exports = { snapshotStats, normalizeDate, RECENT_LIMIT, RECENT_PER_AUTHORITY };
