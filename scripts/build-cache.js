'use strict';

/*
 * Build the repo-bundled OFAC snapshot: fetch + parse the full live dataset and
 * write it gzipped to cache/snapshot.json.gz. Run daily by the GitHub Action
 * (.github/workflows/refresh-data.yml) so every deploy ships fresh data and the
 * server never needs a heavy runtime fetch.
 *
 *   node scripts/build-cache.js
 *
 * The new snapshot is only written if it still covers every authority the
 * PREVIOUS snapshot carried. A source that fails open (an expired TLS cert on
 * the publisher's side, say) would otherwise publish a quietly smaller list,
 * and a screening list that shrinks without telling anyone produces false
 * negatives. On coverage loss this exits non-zero and leaves the last good
 * snapshot in place, so the deployed app keeps serving complete data while the
 * upstream problem is fixed.
 *
 * A second gate measures the FIELDS. An authority can stay present, the entity
 * count can look normal, and a field can still go quiet — a renamed label, a
 * moved XML block — which no count floor detects and which silently disables
 * whatever screening control reads that field. lib/quality profiles every
 * build, stores the profile beside the snapshot, and blocks a publish that
 * would replace a fuller snapshot with an emptier one.
 *
 * ALLOW_AUTHORITY_DROP=1 overrides the first, for an authority that is
 * intentionally retired. ALLOW_QUALITY_DROP=1 overrides the second, for a field
 * a publisher genuinely stopped providing.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildLiveSnapshot, assertAuthorityCoverage, EXPECTED_AUTHORITIES, CACHE_GZ_PATH, serializeEntities } = require('../lib/ingest');
const quality = require('../lib/quality');

const CHANGES_PATH = path.join(path.dirname(CACHE_GZ_PATH), 'changes.json');
const QUALITY_PATH = path.join(path.dirname(CACHE_GZ_PATH), 'quality.json');
const MAX_LISTED = 3000; // per side, so one bad day cannot produce a huge file

/*
 * Read the snapshot we are about to replace, once, for two purposes: the
 * authority baseline the coverage guard needs, and the id→party index the delta
 * needs. Only the handful of fields the delta reports are kept, so this does
 * not double peak memory on a 400MB container.
 */
function previousSnapshot() {
  try {
    if (!fs.existsSync(CACHE_GZ_PATH)) return null;
    const prev = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_GZ_PATH)).toString('utf8'));
    const byId = new Map();
    for (const e of prev.entities || []) {
      byId.set(String(e.id), { id: String(e.id), name: e.name, authority: e.authority, list: e.list, type: e.type });
    }
    const authorities = [...new Set((prev.entities || []).map((e) => e.authority).filter(Boolean))].sort();
    return { byId, authorities: authorities.length ? authorities : null, meta: prev.meta || {}, count: byId.size };
  } catch (e) {
    console.warn(`could not read previous snapshot: ${e.message}`);
    return null;
  }
}

// The quality profile the last published build measured. Absent on a first run
// and after any manual snapshot edit, in which case only the coded floors apply.
function previousQuality() {
  try {
    if (!fs.existsSync(QUALITY_PATH)) return null;
    return JSON.parse(fs.readFileSync(QUALITY_PATH, 'utf8'));
  } catch (e) {
    console.warn(`could not read previous quality profile: ${e.message}`);
    return null;
  }
}

/*
 * What changed between the previous published snapshot and this one.
 *
 * Removals are the reason this is computed at build time rather than derived
 * from the current snapshot alone. "Designated since date X" can be read off
 * one snapshot, but a DELISTING leaves no trace in it — the party is simply
 * gone — and a delisting is exactly the event that lets a firm release blocked
 * funds. A view that could only ever show additions would be quietly telling
 * half the story.
 */
function computeChanges(prev, next) {
  const nextById = new Map(next.entities.map((e) => [String(e.id), e]));
  const added = [];
  const removed = [];

  for (const [id, e] of nextById) {
    if (prev.byId.has(id)) continue;
    added.push({ id, name: e.name, authority: e.authority, list: e.list, type: e.type, datePublished: e.datePublished || '' });
  }
  for (const [id, e] of prev.byId) {
    if (!nextById.has(id)) removed.push(e);
  }

  const sortByName = (a, b) => String(a.name).localeCompare(String(b.name));
  added.sort(sortByName);
  removed.sort(sortByName);

  return {
    from: { publicationId: prev.meta.publicationId || 'unknown', retrievedAt: prev.meta.retrievedAt || '', count: prev.count },
    to: { publicationId: next.publicationId, retrievedAt: next.retrievedAt, count: next.count },
    addedCount: added.length,
    removedCount: removed.length,
    added: added.slice(0, MAX_LISTED),
    removed: removed.slice(0, MAX_LISTED),
    truncated: added.length > MAX_LISTED || removed.length > MAX_LISTED,
    generatedAt: new Date().toISOString(),
  };
}

(async () => {
  const t = Date.now();
  const prev = previousSnapshot();
  const baseline = prev && prev.authorities;

  /*
   * Retry mode, for a run scheduled purely to recover from an upstream outage.
   *
   * On 2026-08-01 the EU list served HTTP 500 for hours; the coverage guard
   * correctly refused to publish, and because the workflow ran once a day that
   * unrelated outage froze OFAC, UN and UK data for a full 24 hours too. A
   * second run halves that — but only if it stays cheap when nothing is wrong.
   *
   * So: if the snapshot on disk already covers every authority, exit before
   * fetching anything. No build, no commit, no 5MB blob added to the history
   * for a timestamp change.
   */
  if (process.env.ONLY_IF_DEGRADED && prev) {
    const missing = EXPECTED_AUTHORITIES.filter((a) => !prev.authorities.includes(a));
    if (!missing.length) {
      console.log('Retry run: existing snapshot has full authority coverage — nothing to recover, exiting.');
      return;
    }
    console.log(`Retry run: existing snapshot is missing ${missing.join(', ')} — attempting to recover.`);
  }

  const s = await buildLiveSnapshot();

  for (const src of s.sources || []) {
    console.log(`  ${src.ok ? 'ok  ' : 'FAIL'} ${src.label} [${src.authorities.join(', ')}]` +
      (src.ok ? ` — ${src.count} records` : ` — ${src.error}`));
  }

  const coverage = assertAuthorityCoverage(s, baseline);
  const override = !!process.env.ALLOW_AUTHORITY_DROP;

  // A fresh regression means a source broke since the last good build. Stop:
  // the snapshot on disk is more complete than the one we just built.
  if (!coverage.publishable && !override) {
    console.error(`build-cache refused to publish: ${coverage.error.message}`);
    console.error('Previous snapshot left in place — it covers more than this build does.');
    console.error('Fix the source, or set ALLOW_AUTHORITY_DROP=1 if the authority is intentionally retired.');
    process.exit(1);
  }

  /*
   * Field-level quality gate. The coverage guard above answers "is an authority
   * missing"; this answers "is an authority still there but a FIELD gone quiet",
   * which no count floor can see. Same two-tier verdict, same reasoning: a
   * regression means the snapshot on disk is better and this one must not
   * replace it.
   */
  const qualityNow = quality.profile(s);
  const qualityPrev = previousQuality();
  const gate = quality.compare(qualityNow, qualityPrev);
  const qualityOverride = !!process.env.ALLOW_QUALITY_DROP;

  if (gate.findings.length) {
    console.log('\nquality gate:');
    console.log(quality.format(gate));
  } else {
    console.log('quality gate: no findings');
  }

  if (!gate.publishable && !qualityOverride) {
    console.error('\nbuild-cache refused to publish: a measured field regressed against the published snapshot.');
    console.error('That is what a broken parser looks like from the outside — the entity count holds and a field empties.');
    console.error('Check the source format, or set ALLOW_QUALITY_DROP=1 if the publisher genuinely stopped providing it.');
    process.exit(1);
  }

  const meta = {
    source: s.source, sources: s.sources,
    publicationId: s.publicationId, publishedDate: s.publishedDate,
    publications: s.publications, retrievedAt: s.retrievedAt, isLive: true,
  };
  fs.mkdirSync(path.dirname(CACHE_GZ_PATH), { recursive: true });
  // Published data only: the canonical kinds and parsed date intervals are
  // derived at read time, and baking them in would add 7.3% to a blob this
  // workflow commits every day.
  const gz = zlib.gzipSync(Buffer.from(serializeEntities(s.entities, meta)), { level: 9 });
  fs.writeFileSync(CACHE_GZ_PATH, gz);
  // Written next to the snapshot so the NEXT build has something to compare
  // against. Committed with it for the same reason the delta is: a regression
  // is only visible against what was actually published.
  fs.writeFileSync(QUALITY_PATH, JSON.stringify(qualityNow, null, 1));
  console.log(`built ${path.basename(CACHE_GZ_PATH)}: ${s.count} entities, ${(gz.length / 1048576).toFixed(1)}MB gz, in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  console.log(`authorities: ${s.authorities.join(', ')}`);

  // Written even when empty, so the app can distinguish "nothing changed" from
  // "no delta has ever been computed" — the first is information, the second is
  // an absence the UI must not present as a quiet day.
  if (prev) {
    const changes = computeChanges(prev, s);
    fs.writeFileSync(CHANGES_PATH, JSON.stringify(changes));
    console.log(`changes vs pub ${changes.from.publicationId}: +${changes.addedCount} added, -${changes.removedCount} removed`);
  } else {
    console.log('no previous snapshot — skipping the delta (nothing to compare against)');
  }

  /*
   * A standing gap ships — freezing the build would stall the four healthy
   * authorities too, and missed designations are their own false-negative
   * source — but the run still ends red so the gap cannot quietly become the
   * new normal. The snapshot is already written at this point, so the
   * workflow's commit step (which runs on success of THIS script) needs the
   * exit to come last; see refresh-data.yml, where the commit step runs before
   * the coverage gate.
   */
  if (!coverage.ok && !override) {
    console.error(`\nCOVERAGE ALARM: ${coverage.error.message}`);
    console.error('Snapshot published anyway (the gap predates this build), and the app shows an incomplete-coverage banner.');
    process.exitCode = 3; // distinct from 1 (build failed, nothing written)
  }

  // A below-floor finding that is not a regression ships for the same reason a
  // standing coverage gap does — the other fields are fresh and withholding them
  // helps nobody — but the run still ends red so it cannot become the new normal.
  if (!gate.ok && gate.publishable && !qualityOverride) {
    console.error('\nQUALITY ALARM: a measured field is below its floor but no worse than the published snapshot.');
    console.error(quality.format(gate));
    process.exitCode = 3;
  }
})().catch((e) => { console.error('build-cache failed:', e.message); process.exit(1); });
