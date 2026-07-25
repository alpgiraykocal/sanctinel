'use strict';

/*
 * Build the repo-bundled OFAC snapshot: fetch + parse the full live dataset and
 * write it gzipped to cache/snapshot.json.gz. Run daily by the GitHub Action
 * (.github/workflows/refresh-data.yml) so every deploy ships fresh data and the
 * server never needs a heavy runtime fetch.
 *
 *   node scripts/build-cache.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildLiveSnapshot, CACHE_GZ_PATH } = require('../lib/ingest');

(async () => {
  const t = Date.now();
  const s = await buildLiveSnapshot();
  const payload = {
    meta: { source: s.source, publicationId: s.publicationId, retrievedAt: s.retrievedAt, isLive: true },
    entities: s.entities,
  };
  fs.mkdirSync(path.dirname(CACHE_GZ_PATH), { recursive: true });
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  fs.writeFileSync(CACHE_GZ_PATH, gz);
  console.log(`built ${path.basename(CACHE_GZ_PATH)}: ${s.count} entities, ${(gz.length / 1048576).toFixed(1)}MB gz, in ${((Date.now() - t) / 1000).toFixed(0)}s`);
})().catch((e) => { console.error('build-cache failed:', e.message); process.exit(1); });
