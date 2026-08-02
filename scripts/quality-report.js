'use strict';

/*
 * Print the field-level quality profile of the snapshot on disk, and diff it
 * against the published profile in cache/quality.json.
 *
 *   node scripts/quality-report.js          # profile + gate verdict
 *   node scripts/quality-report.js --write  # …and adopt it as the baseline
 *
 * The gate itself runs inside scripts/build-cache.js. This exists so the same
 * numbers can be read without a two-minute rebuild — when a parser change lands,
 * the question "did that move any field" should be one command, not a fetch of
 * every upstream list.
 *
 * --write is for exactly one situation: seeding the baseline, or adopting a
 * change that has been reviewed and is intended. It rewrites the file the next
 * build compares against, so using it to silence a finding disables the alarm
 * rather than answering it.
 */

const fs = require('fs');
const path = require('path');
const { readCache, CACHE_GZ_PATH } = require('../lib/ingest');
const quality = require('../lib/quality');

const QUALITY_PATH = path.join(path.dirname(CACHE_GZ_PATH), 'quality.json');

const cached = readCache();
if (!cached) {
  console.error('No snapshot on disk. Run: node scripts/build-cache.js');
  process.exit(1);
}

const now = quality.profile(cached.snapshot);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

console.log(`snapshot: publication ${now.publicationId || 'unknown'}, ${now.count} parties, retrieved ${now.retrievedAt || 'unknown'}\n`);

const cols = ['count', 'aliasRate', 'addressRate', 'identifierRate', 'birthDateRate', 'nationalityRate', 'relationshipEdges'];
console.log(['authority'.padEnd(10), ...cols.map((c) => c.padStart(19))].join(''));
for (const [name, a] of Object.entries(now.authorities)) {
  const cells = cols.map((c) => {
    const v = a[c];
    return (c.endsWith('Rate') ? pct(v) : String(v)).padStart(19);
  });
  console.log([name.padEnd(10), ...cells].join(''));
}

console.log('\nderived (these depend on our parsing, not on what a publisher included):');
for (const [key, floor] of Object.entries(quality.FLOORS)) {
  const v = now.derived[key];
  console.log(`  ${key.padEnd(30)} ${pct(v).padStart(7)}   floor ${pct(floor)}`);
}
console.log(`  ${'(dob values / country values)'.padEnd(30)} ${now.derived.dobValues} / ${now.derived.countryValues}`);

let prev = null;
try { prev = JSON.parse(fs.readFileSync(QUALITY_PATH, 'utf8')); } catch { /* no baseline yet */ }

const gate = quality.compare(now, prev);
console.log(`\nbaseline: ${prev ? `${QUALITY_PATH} (publication ${prev.publicationId || 'unknown'})` : 'none — only the coded floors apply'}`);
console.log(quality.format(gate));
console.log(`verdict: ${gate.publishable ? (gate.ok ? 'clean' : 'publishable, run would go red') : 'WOULD BLOCK PUBLICATION'}`);

if (process.argv.includes('--write')) {
  fs.writeFileSync(QUALITY_PATH, JSON.stringify(now, null, 1));
  console.log(`\nwrote ${QUALITY_PATH} — the next build compares against these numbers.`);
}
