'use strict';

/*
 * Build the snapshot from the live feeds IN MEMORY and report what the parsers
 * got out of them — without writing anything.
 *
 *   node scripts/parse-check.js
 *
 * scripts/build-cache.js publishes; this only measures. It exists so a parser
 * change can be checked against the real feeds before it is merged: the field
 * profile lib/quality computes, the gate's verdict against the published
 * profile, and counts for the fields that only exist because a parser reads
 * them (address lines, document dates and statuses, source annotations,
 * original-script names, contact details).
 */

const fs = require('fs');
const path = require('path');
const { buildLiveSnapshot, SNAPSHOT_DIR } = require('../lib/ingest');
const quality = require('../lib/quality');
const { expiredOn } = require('../lib/normalize');

(async () => {
  const s = await buildLiveSnapshot(null);
  for (const src of s.sources || []) console.log(`  ${src.ok ? 'ok  ' : 'FAIL'} ${src.label} — ${src.ok ? `${src.count} records` : src.error}`);

  const now = quality.profile(s);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const cols = ['count', 'aliasRate', 'addressRate', 'addressDetailRate', 'identifierRate', 'birthDateRate', 'nationalityRate', 'relationshipEdges'];
  console.log(`\n${['authority'.padEnd(10), ...cols.map((c) => c.padStart(18))].join('')}`);
  for (const [name, a] of Object.entries(now.authorities)) {
    console.log([name.padEnd(10), ...cols.map((c) => (c.endsWith('Rate') ? pct(a[c]) : String(a[c])).padStart(18))].join(''));
  }
  console.log('derived', JSON.stringify(now.derived));
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(path.dirname(SNAPSHOT_DIR), 'quality.json'), 'utf8')); } catch { /* none */ }
  const gate = quality.compare(now, prev);
  console.log(quality.format(gate));
  console.log(`verdict against the published profile: ${gate.publishable ? (gate.ok ? 'clean' : 'publishable, would go red') : 'WOULD BLOCK'}`);

  const by = {};
  const bump = (auth, k, n = 1) => { (by[auth] ||= {})[k] = (by[auth][k] || 0) + n; };
  for (const e of s.entities) {
    const a = e.authority;
    for (const d of e.idDocuments || []) {
      bump(a, 'documents');
      if (d.issueDate) bump(a, 'doc issue date');
      if (d.expirationDate) bump(a, 'doc expiry date');
      if (d.status) bump(a, `doc status ${d.status}`);
      if (d.note) bump(a, 'doc note');
    }
    for (const at of e.attributes || []) {
      if (at.note) bump(a, 'attribute note');
      if (at.status === 'false') bump(a, 'attribute marked false');
      if (at.group === 'Digital & Contact') bump(a, `contact ${at.label}`);
      if (/^(Gender|Function|Designation|Title|Official Journal|INTERPOL-UN notice)$/.test(at.label)) bump(a, `attr ${at.label}`);
    }
    for (const ad of e.addresses || []) if (ad.note) bump(a, 'address note');
    if ((e.names || []).some((n) => n.native)) bump(a, 'records with native name');
    if (e.remarks) bump(a, 'records with remarks');
    for (const i of e.identifiers || []) if (i.status) bump(a, `identifier status ${i.status}`);
    if (expiredOn(e)) bump(a, 'lapsed denial');
    for (const r of e.relationships || []) if (r.relatedName && !r.inSnapshot) bump(a, 'related party named but not listed');
  }
  console.log('\nfields read from the feeds, per authority:');
  for (const [auth, counts] of Object.entries(by)) {
    console.log(`  ${auth}: ${Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
})().catch((e) => { console.error('parse-check failed:', e.message); process.exit(1); });
