'use strict';

/*
 * Ingestion for the OFAC Sanctions List Service (SLS).
 *
 * The SLS API has NO name-search endpoint. To screen a name you pull the full
 * list and match locally. This module downloads the classic OFAC flat files,
 * parses them into a COMPLETE structured record (names+alias types, addresses,
 * and every extractable identifier: DOB, POB, nationality, citizenship, gender,
 * passport, national/tax/registration IDs, IMO, MMSI, call sign, vessel + aircraft
 * data, digital-currency addresses, email, phone, website), and holds the result
 * as an IMMUTABLE snapshot pinned to a publication id.
 *
 * Poison-pill guard: refuse to promote a snapshot with too few entities; a
 * silently truncated parse (clean run, zero hits) is the worst screening failure.
 */

const fs = require('fs');
const path = require('path');
const { fetchText, fetchJson } = require('./fetch');
const { parseEntitiesXml } = require('./advanced');
const { tokens: nameTokens, setCorpus, searchableNames } = require('./matcher');
const { identifierKind } = require('./vocab');
const { countryCodes } = require('./countries');

const BASE = 'https://sanctionslistservice.ofac.treas.gov';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'snapshot.json');
// Gzipped snapshot committed to the repo (built daily by a GitHub Action) so a
// fresh deploy boots straight into live data with no runtime OFAC fetch.
const CACHE_GZ_PATH = path.join(CACHE_DIR, 'snapshot.json.gz');
/*
 * The committed snapshot: one newline-delimited JSON file per authority, one
 * party per line, sorted by id, plus meta.json.
 *
 * It used to be committed as one gzipped blob, and git cannot delta-compress
 * gzip output — a one-line change rewrites the whole stream — so every nightly
 * build added another ~5.3MB to the repository's history forever (twelve days
 * measured 64MB packed). As sorted lines, git stores a day's changes as a small
 * delta: the same twelve days pack to 5.9MB, the first full copy included. And
 * the data commit's diff now shows which parties changed, line by line.
 *
 * cache/snapshot.json.gz is still written by the build, but published as a
 * release asset rather than committed, for anything that wants one download.
 */
const SNAPSHOT_DIR = path.join(CACHE_DIR, 'snapshot');
const MIN_ENTITIES = 100;

const FILES = {
  sdn: { prim: 'SDN.CSV', alt: 'ALT.CSV', add: 'ADD.CSV' },
  cons: { prim: 'CONS_PRIM.CSV', alt: 'CONS_ALT.CSV', add: 'CONS_ADD.CSV' },
};

/*
 * All OFAC traffic goes through lib/fetch, which follows redirects and retries
 * transient failures. Both matter here and neither used to happen: the flat
 * files answer 302, so the fallback path this module is supposed to fall back
 * TO could never complete a single download, and a one-off 403 on the scheduled
 * build killed the whole day's snapshot.
 */
function httpGet(p, { json = false, timeout = 60000 } = {}) {
  const url = p.startsWith('http') ? p : BASE + p;
  return json ? fetchJson(url, { timeout }) : fetchText(url, { timeout });
}

const { parseCsv } = require('./csv');

const clean = (v) => { if (v == null) return ''; const t = v.trim(); return t === '-0-' ? '' : t; };

/*
 * Parse the free-text OFAC remarks blob into structured attributes + identifiers.
 * OFAC concatenates identifier segments separated by ';'. We recognize the common
 * labels and route the remainder to "Other".
 */
function parseRemarks(remarks) {
  const attributes = [];
  const identifiers = [];
  if (!remarks) return { attributes, identifiers };

  const push = (group, label, value) => value && attributes.push({ group, label, value });
  const pushId = (type, value) => value && identifiers.push({ type, value });

  for (let seg of remarks.split(';')) {
    seg = seg.trim();
    if (!seg) continue;
    let m;

    if ((m = seg.match(/^(?:alt\.?\s*)?DOB\s+(.+)/i))) { push('Identity', 'Date of Birth', m[1]); }
    else if ((m = seg.match(/^POB\s+(.+)/i))) { push('Identity', 'Place of Birth', m[1]); }
    else if ((m = seg.match(/^nationality\s+(.+)/i))) { push('Identity', 'Nationality', m[1]); }
    else if ((m = seg.match(/^citizen(?:ship)?\s+(.+)/i))) { push('Identity', 'Citizenship', m[1]); }
    else if ((m = seg.match(/^Gender\s+(.+)/i))) { push('Identity', 'Gender', m[1]); }
    else if ((m = seg.match(/^(Passport)\s+(.+)/i))) { push('Documents', 'Passport', m[2]); pushId('Passport', m[2].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^National\s+ID\s+(?:No\.?\s*)?(.+)/i))) { push('Documents', 'National ID', m[1]); pushId('National ID', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^(?:Cedula|C\.?I\.?)\s+(?:No\.?\s*)?(.+)/i))) { push('Documents', 'Cedula No.', m[1]); pushId('Cedula', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^Tax\s+ID\s+(?:No\.?\s*)?(.+)/i))) { push('Documents', 'Tax ID', m[1]); pushId('Tax ID', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^(?:Business\s+)?Registration\s+Number\s+(.+)/i))) { push('Documents', 'Registration No.', m[1]); pushId('Registration', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^IMO\s+(.+)/i))) { push('Vessel / Aircraft', 'IMO', m[1]); pushId('IMO', m[1]); }
    else if ((m = seg.match(/^MMSI\s+(.+)/i))) { push('Vessel / Aircraft', 'MMSI', m[1]); pushId('MMSI', m[1]); }
    else if ((m = seg.match(/^(?:Other\s+Vessel\s+)?Call\s+Sign\s+(.+)/i))) { push('Vessel / Aircraft', 'Call Sign', m[1]); pushId('Call Sign', m[1]); }
    else if ((m = seg.match(/^Aircraft\s+Tail\s+Number\s+(.+)/i))) { push('Vessel / Aircraft', 'Aircraft Tail No.', m[1]); pushId('Aircraft Tail', m[1]); }
    else if ((m = seg.match(/^Digital\s+Currency\s+Address\s*-\s*(\w+)\s+(.+)/i))) { push('Digital & Contact', `Digital Currency (${m[1]})`, m[2]); pushId(`Crypto ${m[1]}`, m[2]); }
    else if ((m = seg.match(/^Email\s+Address\s+(.+)/i))) { push('Digital & Contact', 'Email', m[1]); pushId('Email', m[1]); }
    else if ((m = seg.match(/^Phone\s+Number\s+(.+)/i))) { push('Digital & Contact', 'Phone', m[1]); pushId('Phone', m[1]); }
    else if ((m = seg.match(/^Website\s+(.+)/i))) { push('Digital & Contact', 'Website', m[1]); }
    else if ((m = seg.match(/^Secondary\s+sanctions\s+risk:?\s*(.+)/i))) { push('Program', 'Secondary Sanctions Risk', m[1]); }
    else if ((m = seg.match(/^(?:Organization\s+)?Established\s+Date\s+(.+)/i))) { push('Identity', 'Established Date', m[1]); }
    else if ((m = seg.match(/^Linked\s+To:?\s*(.+)/i))) { push('Program', 'Linked To', m[1]); }
    else push('Other', 'Remark', seg);
  }
  return { attributes, identifiers };
}

// SDN.CSV cols: 0 ent_num,1 name,2 type,3 program,4 title,5 call_sign,6 vess_type,
//               7 tonnage,8 grt,9 vess_flag,10 vess_owner,11 remarks
function buildIndex(primText, altText, addText, listLabel) {
  const byId = new Map();

  for (const r of parseCsv(primText)) {
    if (r.length < 4) continue;
    const id = clean(r[0]);
    if (!id || !/^\d+$/.test(id)) continue;

    const remarks = clean(r[11]);
    const { attributes, identifiers } = parseRemarks(remarks);

    // Dedicated vessel columns → attributes + identifiers.
    const vessel = [
      ['Call Sign', clean(r[5]), 'Call Sign'],
      ['Vessel Type', clean(r[6]), null],
      ['Tonnage', clean(r[7]), null],
      ['Gross Tonnage (GRT)', clean(r[8]), null],
      ['Vessel Flag', clean(r[9]), null],
      ['Vessel Owner', clean(r[10]), null],
    ];
    for (const [label, value, idType] of vessel) {
      if (value) { attributes.push({ group: 'Vessel / Aircraft', label, value }); if (idType) identifiers.push({ type: idType, value }); }
    }

    byId.set(id, {
      id,
      list: listLabel,
      name: clean(r[1]),
      type: clean(r[2]) || 'Individual',
      title: clean(r[4]),
      programs: clean(r[3]).split(/[;\/]/).map((s) => s.trim()).filter(Boolean),
      sanctionsTypes: [],
      sanctionsType: '',
      legalAuthorities: [],
      datePublished: '',
      names: [{ name: clean(r[1]), type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: '', parts: [] }],
      addresses: [],
      idDocuments: [],
      relationships: [],
      attributes,
      identifiers,
      remarks,
    });
  }

  // ALT.CSV cols: 0 ent_num,1 alt_num,2 alt_type,3 alt_name,4 alt_remarks
  for (const r of parseCsv(altText)) {
    if (r.length < 4) continue;
    const e = byId.get(clean(r[0]));
    if (!e) continue;
    const alt = clean(r[3]);
    if (!alt) continue;
    e.names.push({ name: alt, type: clean(r[2]) || 'A.K.A.', primary: false, lowQuality: /weak|low/i.test(clean(r[4])), script: 'Latin', native: '', parts: [] });
  }

  // ADD.CSV cols: 0 ent_num,1 add_num,2 address,3 city_state_zip,4 country,5 add_remarks
  for (const r of parseCsv(addText)) {
    if (r.length < 5) continue;
    const e = byId.get(clean(r[0]));
    if (!e) continue;
    const parts = [clean(r[2]), clean(r[3]), clean(r[4])].filter(Boolean);
    if (parts.length) e.addresses.push({ full: parts.join(', '), country: clean(r[4]) });
  }

  return [...byId.values()];
}

async function fetchListSet(set, label) {
  const [prim, alt, add] = await Promise.all([
    httpGet(`/api/download/${set.prim}`),
    httpGet(`/api/download/${set.alt}`),
    httpGet(`/api/download/${set.add}`),
  ]);
  return buildIndex(prim, alt, add, label);
}

// /changes/latest is a 302 redirect (empty body). The real publication id + date
// come from /changes/history/{year}; the max publicationID is the current one.
async function fetchPublicationInfo() {
  try {
    const year = new Date().getFullYear();
    let hist = await httpGet(`/changes/history/${year}`, { json: true }).catch(() => []);
    if (!hist || !hist.length) hist = await httpGet(`/changes/history/${year - 1}`, { json: true }).catch(() => []);
    if (!hist || !hist.length) return { id: 'unknown', date: '', history: [] };
    hist.sort((a, b) => b.publicationID - a.publicationID);
    return {
      id: String(hist[0].publicationID),
      date: hist[0].datePublished || '',
      history: hist.slice(0, 12).map((h) => ({ id: h.publicationID, date: h.datePublished })),
    };
  } catch { return { id: 'unknown', date: '', history: [] }; }
}

// Advanced path: the SLS /entities XML carries the FULL object model
// (typed names + scripts, every feature, id documents, relationships).
async function fetchEntitiesByList(listName) {
  const xml = await httpGet(`/entities?list=${encodeURIComponent(listName)}`);
  return parseEntitiesXml(xml, listName);
}

/*
 * One OFAC list failing must not quietly remove it.
 *
 * Each list is its own request, and a failed one used to be skipped with an
 * empty catch: the poison-pill floor only guards the total, so losing a small
 * list — CMIC, NS-MBS, the PLC list — published a snapshot without it and
 * nothing anywhere said so. Its parties then screened clean.
 *
 * A failed list, or one that parses to nothing when the previous snapshot had
 * parties on it, now contributes its records from the last good snapshot — the
 * same carry-forward the other authorities get — and is reported on the source
 * so the build ends red.
 */
async function buildAdvancedSnapshot(pub, carryForward) {
  const lists = await httpGet('/sanctions-lists', { json: true });
  const previous = (carryForward && Array.isArray(carryForward.entities))
    ? carryForward.entities.filter((e) => (e.authority || 'OFAC') === 'OFAC') : [];
  const onList = (l) => previous.filter((e) => (e.lists || [e.list]).includes(l));
  // Sequential on purpose: fetching all lists in parallel holds every raw XML
  // in memory at once, which OOM-kills small containers (e.g. 512MB free tiers).
  const entities = [];
  const failedLists = [];
  for (const l of lists) {
    let error = '';
    try {
      const batch = await fetchEntitiesByList(l);
      if (batch.length || !onList(l).length) {
        entities.push(...batch);
        if (global.gc) global.gc();
        continue;
      }
      error = 'parsed 0 entities';
    } catch (e) {
      error = (e && e.message) || String(e);
    }
    const carried = onList(l);
    entities.push(...carried);
    failedLists.push({ list: l, error, carried: carried.length });
    console.warn(`OFAC list "${l}" failed (${error}) — ` +
      (carried.length ? `carrying forward ${carried.length} records from the previous snapshot.` : 'no previous records to carry forward.'));
  }
  if (entities.length < MIN_ENTITIES) {
    throw new Error(`poison-pill: only ${entities.length} entities parsed via advanced (floor ${MIN_ENTITIES}).`);
  }
  return { entities, failedLists };
}

// Fallback path: classic flat files (name/alias/address + remarks-derived features).
async function buildFlatEntities() {
  const [sdn, cons] = await Promise.all([
    fetchListSet(FILES.sdn, 'SDN List'),
    fetchListSet(FILES.cons, 'Consolidated List').catch(() => []),
  ]);
  const entities = [...sdn, ...cons];
  if (entities.length < MIN_ENTITIES) {
    throw new Error(`poison-pill: only ${entities.length} entities parsed via flat files (floor ${MIN_ENTITIES}).`);
  }
  return entities;
}

/*
 * The non-OFAC feeds. `authorities` is what each one is expected to CONTRIBUTE
 * to the snapshot — the CSL is a single fetch that carries two of them, so a
 * silent CSL failure costs both BIS and State. Naming them here is what lets
 * the caller notice that loss; see assertAuthorityCoverage.
 */
const EXTRA_SOURCES = [
  { label: 'EU FSD', authorities: ['EU'], fn: () => require('./sources/eu').fetchEU() },
  { label: 'UN Security Council', authorities: ['UN'], fn: () => require('./sources/un').fetchUN() },
  { label: 'UK OFSI', authorities: ['UK'], fn: () => require('./sources/uk').fetchUK() },
  { label: 'U.S. export-control (BIS + State)', authorities: ['BIS', 'State'], fn: () => require('./sources/csl').fetchCSL() },
];

// Every authority a healthy snapshot carries. Used as the fallback baseline when
// there is no previous snapshot to compare against.
const EXPECTED_AUTHORITIES = ['OFAC', ...EXTRA_SOURCES.flatMap((s) => s.authorities)];

/*
 * Assemble the full multi-authority snapshot: OFAC (advanced → flat fallback)
 * plus the EU, UN, UK and U.S. export-control lists.
 *
 * `carryForward` is the previous snapshot's entities, and it is what stops one
 * publisher's outage from freezing every other authority.
 *
 * The coverage guard refuses to publish a snapshot that lost an authority,
 * which is right — a screening list that quietly gets smaller produces false
 * negatives. But the cost landed somewhere nobody intended: the EU list served
 * HTTP 500 from 2026-08-01, the guard blocked every build for two days, and
 * OFAC, UN and UK data went stale alongside it. Four healthy sources frozen by
 * a fifth, and the app cannot even refresh at runtime on its own instance.
 *
 * So a source that fails now contributes its records from the last good
 * snapshot instead of contributing nothing. The authority stays present and
 * screenable, the fresh authorities publish on time, and each carries its own
 * as-of timestamp so the staleness is visible per authority rather than hidden
 * inside one snapshot date. Withholding a designation that IS in hand, because
 * an unrelated publisher is down, helps nobody.
 */
async function buildLiveSnapshot(carryForward) {
  const pub = await fetchPublicationInfo();
  let source = 'OFAC SLS (advanced /entities)';
  let entities;
  let failedLists = [];
  const sources = [];
  try {
    ({ entities, failedLists } = await buildAdvancedSnapshot(pub, carryForward));
  } catch (e) {
    console.warn(`Advanced snapshot failed (${e.message}). Falling back to flat files.`);
    entities = await buildFlatEntities();
    source = 'OFAC SLS (flat files)';
  }
  const ofac = { label: source, authorities: ['OFAC'], ok: true, count: entities.length, error: '' };
  if (failedLists.length) {
    ofac.failedLists = failedLists;
    ofac.error = 'lists failed: ' + failedLists.map((f) => `${f.list} (${f.error}; carried forward ${f.carried})`).join('; ');
  }
  sources.push(ofac);
  const authorities = ['OFAC'];

  for (const src of EXTRA_SOURCES) {
    try {
      const recs = await src.fn();
      entities.push(...recs);
      authorities.push(...src.authorities);
      if (global.gc) global.gc();
      console.log(`${src.label}: ${recs.length} records`);
      const entry = { label: src.label, authorities: src.authorities, ok: true, count: recs.length, error: '' };
      // Something the parser noticed but could work around — an unknown list
      // label, say. The data publishes; the run must still go red.
      if (Array.isArray(recs.warnings) && recs.warnings.length) entry.warnings = recs.warnings.slice();
      sources.push(entry);
    } catch (e) {
      const kept = carriedRecordsFor(carryForward, src.authorities);
      if (kept.records.length) {
        entities.push(...kept.records);
        authorities.push(...src.authorities);
        console.warn(`${src.label} failed (${e.message}) — carrying forward ${kept.records.length} records from ${kept.asOf || 'the previous snapshot'}.`);
        sources.push({
          label: src.label, authorities: src.authorities, ok: false, count: kept.records.length,
          error: e.message, carriedForward: true, asOf: kept.asOf,
        });
      } else {
        console.warn(`${src.label} source skipped: ${e.message}`);
        sources.push({ label: src.label, authorities: src.authorities, ok: false, count: 0, error: e.message });
      }
    }
  }

  const retrievedAt = new Date().toISOString();
  return finalizeSnapshot(entities, {
    source: `${source} + ${authorities.slice(1).join(' + ') || 'OFAC only'}`,
    sources,
    // When each authority's data was actually fetched. One snapshot date cannot
    // describe a snapshot whose parts were retrieved days apart, and the
    // difference is exactly what a reviewer needs to know before relying on it.
    authorityFreshness: freshnessOf(sources, retrievedAt),
    publicationId: pub.id, publishedDate: pub.date, publications: pub.history, retrievedAt,
  });
}

/*
 * Records belonging to the given authorities in the previous snapshot.
 *
 * `carryForward` is `{ entities, retrievedAt, authorityFreshness }` — whatever
 * the caller could read off the last published build. The as-of date preferred
 * is the authority's own, so carrying forward twice does not reset the clock
 * and make two-day-old data look fresh.
 */
function carriedRecordsFor(carryForward, wanted) {
  if (!carryForward || !Array.isArray(carryForward.entities)) return { records: [], asOf: '' };
  const want = new Set(wanted);
  const records = carryForward.entities.filter((e) => want.has(e.authority));
  if (!records.length) return { records: [], asOf: '' };
  const prior = carryForward.authorityFreshness || {};
  const asOf = wanted.map((a) => prior[a]).filter(Boolean).sort()[0] || carryForward.retrievedAt || '';
  return { records, asOf };
}

/*
 * Swap the named authorities' records for the ones the previous snapshot had.
 *
 * The field-level quality gate used to answer a regression in ONE authority by
 * refusing the whole build. In October 2026 State renamed one of its lists, the
 * parser dropped it, State's party count fell 17% — and OFAC, EU, UN, UK and BIS
 * stopped updating for thirteen days alongside it, OFAC designations included.
 * That is the outage carry-forward was built to prevent, reached by a second
 * door.
 *
 * So a regression scoped to an authority is answered the way an unreachable
 * source is: that authority keeps its last good records, labelled with their
 * own as-of date, and everything else publishes. Returns null when there is
 * nothing to carry, so the caller falls back to refusing the build.
 */
function replaceAuthorities(snapshot, authorities, carryForward) {
  const want = new Set(authorities);
  const kept = carriedRecordsFor(carryForward, authorities);
  const have = new Set(kept.records.map((e) => e.authority));
  if (authorities.some((a) => !have.has(a))) return null;
  const prior = (carryForward && carryForward.authorityFreshness) || {};
  const freshness = Object.assign({}, snapshot.authorityFreshness);
  for (const a of authorities) freshness[a] = prior[a] || (carryForward && carryForward.retrievedAt) || '';
  const sources = (snapshot.sources || []).map((src) => {
    const hit = src.authorities.filter((a) => want.has(a));
    return hit.length ? Object.assign({}, src, { qualityCarriedForward: hit }) : src;
  });
  const { entities, count, lists, programs, authorities: _a, ...meta } = snapshot;
  return finalizeSnapshot(
    entities.filter((e) => !want.has(e.authority)).concat(kept.records),
    Object.assign(meta, { sources, authorityFreshness: freshness }),
  );
}

/*
 * Authorities whose data is materially older than the snapshot itself, because
 * their source was down when it was built. A day's tolerance: the pipeline
 * republishes daily and a few hours of lag is the normal state.
 *
 * Measured against the snapshot's own retrieval time, not against now. Against
 * now, a snapshot that is simply old — the daily build blocked, say — listed
 * every authority here, and the banner told the reader each of those sources
 * had been unreachable when none of them had. An old snapshot is reported on
 * its own, through snapshotAgeHours. ageHours stays relative to now, because
 * that is how old the data the reader is screening against actually is.
 */
const STALE_AUTHORITY_HOURS = 24;
function staleAuthorities(snapshot, now = Date.now()) {
  const freshness = snapshot.authorityFreshness || {};
  const built = Date.parse(snapshot.retrievedAt);
  const out = [];
  for (const [authority, asOf] of Object.entries(freshness)) {
    const at = Date.parse(asOf);
    if (!Number.isFinite(at)) continue;
    const lag = Number.isFinite(built) ? (built - at) / 36e5 : (now - at) / 36e5;
    if (lag >= STALE_AUTHORITY_HOURS) out.push({ authority, asOf, ageHours: Math.round((now - at) / 36e5) });
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

// authority → when its data was retrieved.
function freshnessOf(sources, retrievedAt) {
  const out = {};
  for (const src of sources) {
    const asOf = src.carriedForward ? (src.asOf || '') : retrievedAt;
    for (const a of src.authorities) out[a] = asOf;
  }
  return out;
}

/*
 * Refuse to promote a snapshot that lost an authority.
 *
 * A source failing open is the failure mode this exists for: on 2026-07-28 the
 * trade.gov TLS certificate expired, the CSL fetch threw, the build "succeeded",
 * and 6,256 BIS + State export-control records vanished from the published
 * snapshot with the UI still offering both as filters. A screening list that
 * silently gets smaller produces false negatives, so a build that would shrink
 * the authority set is an error, not a warning.
 *
 * Two different failures live here and they deserve different handling:
 *
 *   regression — the previous snapshot had this authority and this one does not.
 *                A source just broke. Do NOT publish: keep serving the complete
 *                list until someone looks at it.
 *   standing gap — the authority is configured but was already missing last time
 *                too. Refusing again would be counterproductive: it freezes the
 *                OTHER four authorities as well, so missed new designations pile
 *                up on top of a gap that is already known. Publish the fresh
 *                data, keep the alarm on.
 *
 * Comparing only against the previous snapshot would ratchet — one degraded
 * publish makes the shrunken set the new floor and the check goes quiet forever.
 * That was already the live state when this was written: BIS and State had been
 * gone since 2026-07-28, and a previous-only baseline waved the next build
 * straight through. So the standing gap is measured against EXPECTED_AUTHORITIES,
 * which is derived from the configured source list — retiring an authority means
 * deleting its source from EXTRA_SOURCES, a reviewable code change.
 */
function assertAuthorityCoverage(snapshot, baseline) {
  const have = new Set(snapshot.authorities || []);
  const prev = baseline || [];
  const missing = EXPECTED_AUTHORITIES.filter((a) => !have.has(a));
  const regression = prev.filter((a) => !have.has(a));

  const why = (bad) => (snapshot.sources || [])
    .filter((s) => !s.ok && s.authorities.some((a) => bad.includes(a)))
    .map((s) => `${s.label}: ${s.error}`);

  const result = {
    ok: !missing.length,
    missing,
    regression,
    // Only a regression blocks publication; a standing gap alarms but ships.
    publishable: !regression.length,
    reasons: why(missing),
  };
  if (missing.length) {
    result.error = new Error(
      `authority coverage incomplete: ${missing.join(', ')} missing` +
      (regression.length ? ` (REGRESSION vs previous snapshot: ${regression.join(', ')})` : ' (standing gap, also missing from the previous snapshot)') +
      (result.reasons.length ? ` — ${result.reasons.join('; ')}` : '')
    );
  }
  return result;
}

// Relationships reference the related party by ID only. Resolve display names
// from the snapshot so both the record card and the graph show real names, and
// so distinct related entities are not collapsed into one placeholder node.
function resolveRelationshipNames(entities) {
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  for (const e of entities) {
    for (const rel of e.relationships || []) {
      if (rel.relatedName || !rel.relatedId) continue;
      const t = byId.get(String(rel.relatedId));
      rel.relatedName = t ? t.name : `Entity ${rel.relatedId} (unlisted)`;
      rel.inSnapshot = !!t;
    }
  }
}

// Fetching every list returns some entities more than once (the Consolidated
// umbrella overlaps its sublists). Dedup by id, preferring the copy labeled
// with the more specific list over the generic "Consolidated List".
function dedupEntities(entities) {
  const byId = new Map();
  for (const e of entities) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    // Same entity seen under two list fetches. Union the memberships rather
    // than discarding one: an entity is on the Consolidated List AND on the
    // specific non-SDN list, and the specific one carries the prohibition.
    const merged = [...new Set([...(prev.lists || [prev.list]), ...(e.lists || [e.list])])].filter(Boolean);
    const keep = (prev.list === 'Consolidated List' && e.list !== 'Consolidated List') ? e : prev;
    keep.lists = merged;
    byId.set(e.id, keep);
  }
  return [...byId.values()];
}

// Document frequency of every name token across the snapshot → IDF weighting in
// the matcher (rare surnames outweigh common words like COMPANY / MOHAMMED).
function computeCorpus(entities) {
  const df = new Map();
  for (const e of entities) {
    const seen = new Set();
    // Same surface the scorer and the index use, native-script names included —
    // otherwise a Cyrillic token looks corpus-rare and gets over-weighted.
    for (const n of searchableNames(e)) for (const t of nameTokens(n)) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  setCorpus(df, entities.length);
}

/*
 * Remove identifiers that are not identifiers, on read.
 *
 * lib/advanced used to classify any feature label containing "national" as a
 * national ID, so OFAC's "Nationality Country" filed a party's nationality as
 * their identity-document number. Identifiers are matched EXACTLY, so the query
 * "Russia" returned 1,700 parties at score 1.00 as "exact National ID
 * identifier match" — the strongest verdict this system issues, on a word that
 * identifies nobody.
 *
 * The classifier is fixed, but the fix only reaches the data through a rebuild,
 * and a rebuild cannot publish while an upstream feed is down. So the same
 * correction is applied to whatever snapshot is loaded. It is narrow on purpose:
 * an identity or registration number that contains no digit at all AND names a
 * jurisdiction this app recognizes is our parsing artefact, not a document
 * number anybody was issued. The nationality itself is untouched — it is still
 * on the record as the attribute the authority actually published.
 */
function dropMisfiledIdentifiers(e) {
  const ids = e.identifiers;
  if (!ids || !ids.length) return;
  let bad = 0;
  for (const id of ids) if (isMisfiledIdentifier(id)) bad++;
  if (!bad) return;   // the overwhelming majority: leave the array alone
  e.identifiers = ids.filter((id) => !isMisfiledIdentifier(id));
}

function isMisfiledIdentifier(id) {
  if (!id || !id.value) return false;
  const kind = identifierKind(id.type);
  if (kind !== 'national_id' && kind !== 'registration') return false;
  const value = String(id.value);
  if (/[0-9]/.test(value)) return false;
  return countryCodes(value).length > 0;
}

function finalizeSnapshot(entities, meta) {
  entities = dedupEntities(entities);
  for (const e of entities) {
    if (!e.authority) e.authority = 'OFAC';
    // Sources that publish one list per record (EU, UN, UK, CSL) and snapshots
    // written before multi-list support still only carry `list`.
    if (!e.lists || !e.lists.length) e.lists = e.list ? [e.list] : [];
    dropMisfiledIdentifiers(e);
    // Snapshots built before lib/sources/csl stopped doing so label State
    // nonproliferation records with ITAR, which governs only the debarred
    // list. Corrected on read so a carried-forward record says the right thing.
    if (e.authority === 'State' && /Nonproliferation/.test(e.list || '') && (e.legalAuthorities || []).includes('Arms Export Control Act / ITAR')) {
      e.legalAuthorities = (e.programs || []).length ? e.programs.slice() : ['Nonproliferation statutes (see Federal Register notice)'];
    }
  }
  /*
   * NOT annotated here, deliberately.
   *
   * An earlier version tagged every attribute with its canonical `kind` and a
   * parsed date interval at this point. It cost 114MB of resident memory —
   * writing a new property onto 88,209 existing attribute objects forces a
   * hidden-class transition on each — which on a 512MB container is the
   * difference between booting and being OOM-killed.
   *
   * Nothing needs it: lib/matcher derives the kind on demand and memoizes the
   * result per record for the life of the snapshot, lib/stats and lib/quality
   * call lib/vocab directly. Deriving costs one pass over the attributes the
   * first time a record is scored, against a permanent memory charge for every
   * record whether it is ever scored or not.
   */
  resolveRelationshipNames(entities);
  computeCorpus(entities);
  // Facet over every membership, so selecting "Non-SDN CMIC List" reaches all
  // 68 of them and not just the one whose primary label happened to be CMIC.
  const lists = [...new Set(entities.flatMap((e) => e.lists))].sort();
  const programs = [...new Set(entities.flatMap((e) => e.programs))].sort();
  const authorities = [...new Set(entities.map((e) => e.authority))].sort();
  return Object.freeze({
    ...meta,
    authorityFreshness: meta.authorityFreshness || {},
    publishedDate: meta.publishedDate || '',
    publications: meta.publications || [],
    sources: meta.sources || [],
    entities, count: entities.length, lists, programs, authorities,
  });
}

// Persist a parsed snapshot to disk so the server can boot instantly from cache
// instead of re-fetching + re-parsing ~20k entities (~2 min) on every start.
// What lands on disk is exactly what the authorities published — the canonical
// kinds and parsed date intervals are derived by their consumers, never stored.
function writeCache(entities, meta) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ meta, entities }));
    return true;
  } catch (e) { console.warn('cache write failed:', e.message); return false; }
}

const SHARD_NAME = /^[A-Za-z0-9_-]+$/;

// Write a snapshot as per-authority NDJSON shards. meta.json goes last and
// records the shard list and the count, so a half-written directory is
// detectable on read rather than silently short.
function writeSnapshotDir(meta, entities, dir = SNAPSHOT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const byAuthority = new Map();
  for (const e of entities) {
    const a = SHARD_NAME.test(e.authority || '') ? e.authority : 'OFAC';
    if (!byAuthority.has(a)) byAuthority.set(a, []);
    byAuthority.get(a).push(e);
  }
  const shards = [...byAuthority.keys()].sort();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.ndjson') && !byAuthority.has(f.slice(0, -'.ndjson'.length))) fs.unlinkSync(path.join(dir, f));
  }
  const byId = (x, y) => { const a = String(x.id), b = String(y.id); return a < b ? -1 : a > b ? 1 : 0; };
  for (const a of shards) {
    const lines = byAuthority.get(a).slice().sort(byId).map((e) => JSON.stringify(e));
    const file = path.join(dir, `${a}.ndjson`);
    fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n');
    fs.renameSync(file + '.tmp', file);
  }
  const m = Object.assign({}, meta, { shards, count: entities.length });
  fs.writeFileSync(path.join(dir, 'meta.json') + '.tmp', JSON.stringify(m, null, 1) + '\n');
  fs.renameSync(path.join(dir, 'meta.json') + '.tmp', path.join(dir, 'meta.json'));
}

function readSnapshotDir(dir = SNAPSHOT_DIR) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const entities = [];
  for (const a of meta.shards || []) {
    if (!SHARD_NAME.test(a)) throw new Error(`bad shard name ${a}`);
    const text = fs.readFileSync(path.join(dir, `${a}.ndjson`), 'utf8');
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end === -1) end = text.length;
      if (end > start) entities.push(JSON.parse(text.slice(start, end)));
      start = end + 1;
    }
  }
  if (Number.isFinite(meta.count) && entities.length !== meta.count) {
    throw new Error(`snapshot directory holds ${entities.length} parties, meta.json says ${meta.count}`);
  }
  const { shards, count, ...rest } = meta;
  return { meta: rest, entities };
}

/*
 * The newest readable raw snapshot — { meta, entities } as stored, before
 * finalizeSnapshot — or null. The runtime cache a refresh wrote, the committed
 * directory, and a legacy .gz all qualify; the newest by file time wins, so a
 * refresh written on a persistent disk last week cannot shadow a newer deploy,
 * and a truncated newer copy falls back to an older intact one.
 */
function readRawSnapshot() {
  const zlib = require('zlib');
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return -1; } };
  const sources = [
    { at: mtime(CACHE_PATH), name: path.basename(CACHE_PATH), load: () => JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) },
    { at: mtime(path.join(SNAPSHOT_DIR, 'meta.json')), name: 'snapshot/', load: () => readSnapshotDir() },
    { at: mtime(CACHE_GZ_PATH), name: path.basename(CACHE_GZ_PATH), load: () => JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_GZ_PATH)).toString('utf8')) },
  ].filter((x) => x.at >= 0).sort((a, b) => b.at - a.at);
  for (const src of sources) {
    try {
      const raw = src.load();
      if (raw && raw.entities && raw.entities.length) return raw;
    } catch (e) { console.warn(`cache read failed for ${src.name}: ${e.message}`); }
  }
  return null;
}

// Read the cached snapshot, or null. Returns { snapshot, ageMs }.
function readCache() {
  try {
    const raw = readRawSnapshot();
    if (!raw) return null;
    const meta = raw.meta || {};
    const snapshot = finalizeSnapshot(raw.entities, {
      source: meta.source || 'OFAC SLS (cached)',
      authorityFreshness: meta.authorityFreshness || {},
      publicationId: meta.publicationId || 'unknown',
      publishedDate: meta.publishedDate || '',
      publications: meta.publications || [],
      sources: meta.sources || [],
      retrievedAt: meta.retrievedAt || new Date().toISOString(),
      isLive: meta.isLive !== false,
    });
    const ageMs = Date.now() - Date.parse(meta.retrievedAt || 0) || Infinity;
    return { snapshot, ageMs };
  } catch (e) { console.warn('cache read failed:', e.message); return null; }
}

module.exports = {
  buildLiveSnapshot, buildIndex, parseRemarks, finalizeSnapshot, parseCsv,
  writeCache, readCache, readRawSnapshot, writeSnapshotDir, readSnapshotDir,
  assertAuthorityCoverage, carriedRecordsFor, replaceAuthorities, staleAuthorities,
  CACHE_PATH, CACHE_GZ_PATH, SNAPSHOT_DIR, MIN_ENTITIES, EXPECTED_AUTHORITIES,
};
