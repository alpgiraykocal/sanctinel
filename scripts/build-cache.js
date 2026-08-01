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
 * ALLOW_AUTHORITY_DROP=1 overrides, for the case where an authority is
 * intentionally retired and the baseline needs to move down.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildLiveSnapshot, assertAuthorityCoverage, CACHE_GZ_PATH } = require('../lib/ingest');

// Authorities in the snapshot we are about to replace, or null if there is none.
function previousAuthorities() {
  try {
    if (!fs.existsSync(CACHE_GZ_PATH)) return null;
    const prev = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_GZ_PATH)).toString('utf8'));
    const auth = [...new Set((prev.entities || []).map((e) => e.authority).filter(Boolean))];
    return auth.length ? auth.sort() : null;
  } catch (e) {
    console.warn(`could not read previous snapshot for baseline: ${e.message}`);
    return null;
  }
}

(async () => {
  const t = Date.now();
  const baseline = previousAuthorities();
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

  const payload = {
    meta: {
      source: s.source, sources: s.sources,
      publicationId: s.publicationId, publishedDate: s.publishedDate,
      publications: s.publications, retrievedAt: s.retrievedAt, isLive: true,
    },
    entities: s.entities,
  };
  fs.mkdirSync(path.dirname(CACHE_GZ_PATH), { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  fs.writeFileSync(CACHE_GZ_PATH, gz);
  console.log(`built ${path.basename(CACHE_GZ_PATH)}: ${s.count} entities, ${(gz.length / 1048576).toFixed(1)}MB gz, in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  console.log(`authorities: ${s.authorities.join(', ')}`);

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
})().catch((e) => { console.error('build-cache failed:', e.message); process.exit(1); });
