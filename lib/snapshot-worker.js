'use strict';

/*
 * Background worker: fetches + parses the full live OFAC snapshot (~20k entities,
 * CPU-heavy XML parse) off the main thread so the HTTP server stays responsive,
 * writes the result to the on-disk cache, and reports completion. The main
 * process reloads the snapshot from cache once this signals done.
 */

const { parentPort } = require('worker_threads');
const { buildLiveSnapshot, writeCache } = require('./ingest');

(async () => {
  const started = Date.now();
  try {
    const snap = await buildLiveSnapshot();
    writeCache(snap.entities, {
      source: snap.source,
      publicationId: snap.publicationId,
      retrievedAt: snap.retrievedAt,
      isLive: true,
    });
    parentPort.postMessage({ ok: true, count: snap.count, publicationId: snap.publicationId, source: snap.source, ms: Date.now() - started });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
})();
