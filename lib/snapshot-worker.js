'use strict';

/*
 * Background worker: fetches + parses the full live OFAC snapshot (~20k entities,
 * CPU-heavy XML parse) off the main thread so the HTTP server stays responsive,
 * writes the result to the on-disk cache, and reports completion. The main
 * process reloads the snapshot from cache once this signals done.
 *
 * Like scripts/build-cache.js, the fresh snapshot only replaces the cached one
 * if it still covers every authority the cached one had. A feed that fails open
 * would otherwise shrink the live list mid-flight — a false-negative source the
 * operator never sees. On coverage loss we keep the existing snapshot and
 * report the failure instead.
 */

const { parentPort } = require('worker_threads');
const { buildLiveSnapshot, writeCache, readCache, assertAuthorityCoverage } = require('./ingest');
const quality = require('./quality');

(async () => {
  const started = Date.now();
  try {
    const current = readCache();
    const baseline = current ? current.snapshot.authorities : null;
    const snap = await buildLiveSnapshot();

    // Only a REGRESSION blocks the swap. A gap that the cached snapshot already
    // has is not a reason to stop refreshing the authorities that still work —
    // that would trade a known gap for stale data on everything else.
    const coverage = assertAuthorityCoverage(snap, baseline);
    if (!coverage.publishable) {
      return parentPort.postMessage({
        ok: false,
        error: `${coverage.error.message} — keeping the cached snapshot rather than publishing a smaller list`,
        missing: coverage.missing,
      });
    }
    if (!coverage.ok) console.warn(`Refreshing with incomplete coverage: ${coverage.error.message}`);

    /*
     * The same field-level check the daily build runs, against the snapshot this
     * one would replace. Coverage says every authority is present; this says the
     * fields inside them are still populated. Baseline is the cached snapshot
     * itself rather than a stored profile — a running server has the previous
     * data in hand, which is the thing the swap is about to discard.
     */
    if (current) {
      const gate = quality.compare(quality.profile(snap), quality.profile(current.snapshot));
      if (!gate.publishable) {
        return parentPort.postMessage({
          ok: false,
          error: `field regression vs the cached snapshot — keeping it rather than serving an emptier list:\n${quality.format(gate)}`,
          quality: gate.findings,
        });
      }
      if (!gate.ok) console.warn(`Refreshing with a standing quality alarm:\n${quality.format(gate)}`);
    }

    writeCache(snap.entities, {
      source: snap.source,
      sources: snap.sources,
      publicationId: snap.publicationId,
      publishedDate: snap.publishedDate,
      publications: snap.publications,
      retrievedAt: snap.retrievedAt,
      isLive: true,
    });
    parentPort.postMessage({ ok: true, count: snap.count, publicationId: snap.publicationId, source: snap.source, ms: Date.now() - started });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
})();
