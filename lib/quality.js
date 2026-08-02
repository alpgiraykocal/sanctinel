'use strict';

/*
 * Field-level quality profile of a snapshot, and the gate that compares one
 * build against the last.
 *
 * The coverage guard in lib/ingest catches an authority vanishing. It cannot
 * catch the failure one level down: the authority is still there, the entity
 * count is normal, and a FIELD has gone quiet. That is not hypothetical — every
 * feed here is parsed from a format its publisher can change without telling
 * anyone, and this app reads those fields for real decisions:
 *
 *   - if OFAC renamed `Birthdate`, every birth date would stop being a birth
 *     date, the year-of-birth modifier would silently stop corroborating
 *     anything, and the build would go green;
 *   - if the EU reordered its XML, addresses could empty out while names kept
 *     parsing perfectly;
 *   - if the relationship block moved, the 50 Percent Rule module would report
 *     "no ownership chain to a blocked person" for every party in the list, and
 *     that reads exactly like a clean result.
 *
 * None of those shrink the snapshot enough to trip a count floor. So the build
 * measures how full each field actually is, stores the profile next to the
 * snapshot, and refuses to let the numbers fall quietly.
 *
 * Two failure classes, the same split the coverage guard already draws:
 *
 *   regression — this build is materially worse than the published one. The
 *                snapshot on disk is better; do not publish, exit 1.
 *   below floor — worse than a minimum written down in THIS file, but not worse
 *                than last time. Publish (the data is still fresher than what
 *                is deployed) and end the run red, exit 3.
 *
 * The floors are constants in code rather than a high-water mark from the
 * previous profile, for the reason the coverage guard spells out: comparing
 * only against last time ratchets, so one degraded publish becomes the new
 * normal and the alarm never fires again. Moving a floor is a reviewable diff.
 */

const { countryCodes } = require('./countries');

/*
 * Minimum acceptable values for the derived qualities — the ones that depend on
 * OUR parsing rather than on what a publisher chose to include. A drop here
 * means this code stopped understanding the feed, which is always a defect.
 * Current measured values are in the comments; the floors sit well below them
 * so ordinary list churn cannot trip the gate.
 */
const FLOORS = {
  dobParseRate: 0.95,             // measured 0.9999
  countryResolveRate: 0.95,       // measured 0.9996
  attributeUnclassifiedRate: 0.10, // measured 0.0000 (max, not min)
  identifierUnclassifiedRate: 0.25, // measured 0.0422 (max, not min)
};

// Rates where a HIGHER number is worse.
const INVERTED = new Set(['attributeUnclassifiedRate', 'identifierUnclassifiedRate']);

/*
 * How far a measure may fall against the previous published profile before it
 * counts as a regression. Entity counts get a tighter bound than fill rates: a
 * sanctions list does not lose a tenth of its parties overnight, whereas a fill
 * rate moves whenever a batch of sparse designations lands.
 */
const MAX_COUNT_DROP = 0.10;
const MAX_RATE_DROP = 0.25;
// Below this, a rate is too small for a relative comparison to mean anything —
// 2% falling to 1% is noise, not a regression.
const RATE_FLOOR_FOR_COMPARISON = 0.05;

const rate = (n, d) => (d > 0 ? n / d : 0);

/*
 * Measure one snapshot. Per authority, because the authorities have genuinely
 * different shapes — the UK publishes an identifier for 15% of its parties and
 * OFAC for 84%, and averaging those into one number would hide either one
 * collapsing.
 */
function profile(snapshot) {
  const entities = snapshot.entities || [];
  const authorities = {};
  const bump = (auth) => (authorities[auth] || (authorities[auth] = {
    count: 0, withAlias: 0, withAddress: 0, withIdentifier: 0,
    withBirthDate: 0, withNationality: 0, withRelationship: 0, relationshipEdges: 0,
  }));

  let dobValues = 0, dobParsed = 0;
  let countryValues = 0, countryResolved = 0;
  let attributes = 0, attributesUnclassified = 0;
  let identifiers = 0, identifiersUnclassified = 0;

  for (const e of entities) {
    const a = bump(e.authority || 'OFAC');
    a.count++;
    if ((e.names || []).length > 1) a.withAlias++;
    if ((e.addresses || []).length) a.withAddress++;
    if ((e.identifiers || []).length) a.withIdentifier++;

    let hasDob = false, hasNationality = false;
    for (const attr of e.attributes || []) {
      attributes++;
      if (attr.kind === 'other') attributesUnclassified++;
      if (attr.kind === 'dob') {
        dobValues++;
        if (attr.date) { dobParsed++; hasDob = true; }
      }
      if (attr.kind === 'nationality' || attr.kind === 'citizenship') {
        hasNationality = true;
        countryValues++;
        if (countryCodes(attr.value).length) countryResolved++;
      }
    }
    if (hasDob) a.withBirthDate++;
    if (hasNationality) a.withNationality++;

    for (const id of e.identifiers || []) {
      identifiers++;
      if (id.kind === 'other_id') identifiersUnclassified++;
    }
    for (const ad of e.addresses || []) {
      if (!ad.country) continue;
      countryValues++;
      if (countryCodes(ad.country).length) countryResolved++;
    }

    const rels = e.relationships || [];
    if (rels.length) { a.withRelationship++; a.relationshipEdges += rels.length; }
  }

  // Counts become rates here rather than at comparison time, so the stored
  // profile reads the same way the gate reasons about it.
  const perAuthority = {};
  for (const [name, a] of Object.entries(authorities)) {
    perAuthority[name] = {
      count: a.count,
      aliasRate: rate(a.withAlias, a.count),
      addressRate: rate(a.withAddress, a.count),
      identifierRate: rate(a.withIdentifier, a.count),
      birthDateRate: rate(a.withBirthDate, a.count),
      nationalityRate: rate(a.withNationality, a.count),
      relationshipEdges: a.relationshipEdges,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    publicationId: snapshot.publicationId || '',
    retrievedAt: snapshot.retrievedAt || '',
    count: entities.length,
    authorities: perAuthority,
    derived: {
      dobParseRate: rate(dobParsed, dobValues),
      countryResolveRate: rate(countryResolved, countryValues),
      attributeUnclassifiedRate: rate(attributesUnclassified, attributes),
      identifierUnclassifiedRate: rate(identifiersUnclassified, identifiers),
      dobValues, countryValues, attributes, identifiers,
    },
  };
}

const RATE_KEYS = ['aliasRate', 'addressRate', 'identifierRate', 'birthDateRate', 'nationalityRate'];

/*
 * Compare a fresh profile against the last published one.
 *
 * Only authorities present in BOTH are compared. An authority appearing or
 * disappearing is the coverage guard's business, and reporting it twice with
 * two different verdicts would just make the log harder to read.
 */
function compare(next, prev) {
  const findings = [];
  const add = (severity, metric, message) => findings.push({ severity, metric, message });
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  for (const [key, floor] of Object.entries(FLOORS)) {
    const value = next.derived[key];
    if (value === undefined) continue;
    const bad = INVERTED.has(key) ? value > floor : value < floor;
    if (bad) {
      add('floor', key,
        `${key} is ${pct(value)}, ${INVERTED.has(key) ? 'above' : 'below'} the floor of ${pct(floor)}`);
    }
  }

  if (!prev || !prev.authorities) {
    return { findings, regressions: [], publishable: true, ok: !findings.length };
  }

  /*
   * The derived rates are also compared against last time, not only against the
   * floors. A floor answers "is this acceptable"; the comparison answers "did
   * this build just break something", and only the second one can tell that the
   * snapshot already on disk is the better of the two. Without it, a parse that
   * degrades from 99.9% to 60% would publish and merely go red, overwriting a
   * good snapshot with a worse one.
   */
  for (const key of Object.keys(FLOORS)) {
    const before = prev.derived ? prev.derived[key] : undefined;
    const after = next.derived[key];
    if (before === undefined || after === undefined) continue;
    if (INVERTED.has(key)) {
      // Doubling, with an absolute margin so 0.1% → 0.3% is not an incident.
      if (before >= 0.02 && after > before * 2) {
        add('regression', key, `${key} rose from ${pct(before)} to ${pct(after)}`);
      }
    } else if (before >= 0.5 && after < before * (1 - MAX_RATE_DROP)) {
      add('regression', key, `${key} fell from ${pct(before)} to ${pct(after)}`);
    }
  }

  for (const [name, now] of Object.entries(next.authorities)) {
    const was = prev.authorities[name];
    if (!was) continue;

    if (was.count > 0 && now.count < was.count * (1 - MAX_COUNT_DROP)) {
      add('regression', `${name}.count`,
        `${name} fell from ${was.count} to ${now.count} parties (-${pct(1 - now.count / was.count)})`);
    }
    for (const key of RATE_KEYS) {
      const before = was[key], after = now[key];
      if (before === undefined || after === undefined) continue;
      // A field that was essentially empty cannot regress meaningfully.
      if (before < RATE_FLOOR_FOR_COMPARISON) continue;
      if (after < before * (1 - MAX_RATE_DROP)) {
        add('regression', `${name}.${key}`,
          `${name} ${key} fell from ${pct(before)} to ${pct(after)}`);
      }
    }
    if (was.relationshipEdges > 100 && now.relationshipEdges < was.relationshipEdges * (1 - MAX_RATE_DROP)) {
      add('regression', `${name}.relationshipEdges`,
        `${name} relationship edges fell from ${was.relationshipEdges} to ${now.relationshipEdges}` +
        ' — the ownership graph feeds the 50 Percent Rule module, which reports "no chain to a blocked person" when it is empty');
    }
  }

  const regressions = findings.filter((f) => f.severity === 'regression');
  return { findings, regressions, publishable: !regressions.length, ok: !findings.length };
}

// One-line-per-finding rendering, for the build log and the workflow annotation.
function format(result) {
  if (!result.findings.length) return 'quality gate: no findings';
  return result.findings
    .map((f) => `  ${f.severity === 'regression' ? 'REGRESSION' : 'BELOW FLOOR'}  ${f.message}`)
    .join('\n');
}

module.exports = { profile, compare, format, FLOORS, MAX_COUNT_DROP, MAX_RATE_DROP };
