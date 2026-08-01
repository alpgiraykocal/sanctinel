'use strict';

/*
 * Recall check for the candidate prefilter.
 *
 * /api/search scores only the entities lib/searchindex hands back. If that pool
 * ever omits an entity a FULL scan would have matched, the tool reports fewer
 * hits than the data supports — a silent false negative, which in screening is
 * the failure that matters. This script proves the two paths agree.
 *
 * It runs three query families against the real snapshot:
 *   typo      — real names with a character dropped / swapped / revowelled
 *               (what an analyst actually types)
 *   acronym   — initials of multi-token names ("CCC" for China Communications
 *               Construction Company), which share no trigram with the name
 *   verbatim  — names copied exactly, incl. aliases
 *   native    — names in their own script (Cyrillic, Arabic, Hebrew, Greek,
 *               Han, kana, hangul), pasted as published. These are the ones the
 *               other families cannot reach: every query above is filtered
 *               through cleanName, which keeps only [A-Za-z ] and so could
 *               never have caught a script being dropped or mangled.
 *
 *   node scripts/verify-recall.js [sampleSize]
 *
 * Exits non-zero if the fast path loses a single hit.
 */

const { readCache } = require('../lib/ingest');
const { screenEntity, tokens, searchableNames, hasNonLatinScript } = require('../lib/matcher');
const searchIndex = require('../lib/searchindex');

const THRESHOLD = 0.95; // the default; below it server.js full-scans anyway
const SAMPLE = Number(process.argv[2]) || 120;

let seed = 20260726;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

function perturb(s) {
  const a = s.split('');
  const i = 1 + Math.floor(rnd() * Math.max(1, a.length - 2));
  const k = Math.floor(rnd() * 3);
  if (k === 0) a.splice(i, 1);
  else if (k === 1 && i + 1 < a.length) { const t = a[i]; a[i] = a[i + 1]; a[i + 1] = t; }
  else a[i] = 'AEIOU'[Math.floor(rnd() * 5)];
  return a.join('');
}

const cleanName = (n) => String(n || '').replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim();

function buildQueries(entities) {
  const qs = [];
  for (let i = 0; qs.length < SAMPLE && i < SAMPLE * 20; i++) {
    const e = pick(entities);
    const n = cleanName(e.name);
    if (n.length >= 6) qs.push({ kind: 'typo', q: perturb(n) });
  }
  for (let i = 0; i < SAMPLE * 20 && qs.filter((x) => x.kind === 'acronym').length < SAMPLE / 3; i++) {
    const e = pick(entities);
    const t = tokens(e.name);
    if (t.length < 2 || t.length > 6) continue;
    qs.push({ kind: 'acronym', q: t.map((x) => x[0]).join('') });
  }
  for (let i = 0; i < SAMPLE / 3; i++) {
    const e = pick(entities);
    const names = (e.names && e.names.length) ? e.names : [{ name: e.name }];
    const n = cleanName(pick(names).name);
    if (n.length >= 4) qs.push({ kind: 'verbatim', q: n });
  }
  // Own-script names, pasted verbatim — deliberately NOT run through cleanName.
  const native = [];
  for (const e of entities) {
    for (const n of searchableNames(e)) if (hasNonLatinScript(n)) native.push(n);
  }
  for (let i = 0; i < SAMPLE / 3 && native.length; i++) qs.push({ kind: 'native', q: pick(native) });
  return qs;
}

(function main() {
  const cached = readCache();
  if (!cached) { console.error('No snapshot cache — run scripts/build-cache.js first.'); process.exit(2); }
  const entities = cached.snapshot.entities;
  const index = searchIndex.build(entities);

  const queries = buildQueries(entities);
  const stats = {};
  let totalHits = 0, missed = 0, poolSum = 0;
  const examples = [];

  for (const { kind, q } of queries) {
    const cand = searchIndex.candidates(index, q);
    const pool = cand ? cand.map((i) => entities[i]) : entities;
    poolSum += pool.length;

    const fast = new Set();
    for (const e of pool) if (screenEntity(q, e, THRESHOLD, null)) fast.add(e.id);
    const full = new Set();
    for (const e of entities) if (screenEntity(q, e, THRESHOLD, null)) full.add(e.id);

    const lost = [...full].filter((id) => !fast.has(id));
    totalHits += full.size;
    missed += lost.length;
    (stats[kind] ||= { n: 0, hits: 0, lost: 0 });
    stats[kind].n++; stats[kind].hits += full.size; stats[kind].lost += lost.length;
    if (lost.length && examples.length < 10) {
      const e = entities.find((x) => x.id === lost[0]);
      examples.push(`${kind} ${JSON.stringify(q)} → missed ${lost.length} (e.g. ${lost[0]} ${e ? e.name : '?'})`);
    }
  }

  for (const [kind, s] of Object.entries(stats)) {
    console.log(`${kind.padEnd(9)} queries ${String(s.n).padStart(4)}  true hits ${String(s.hits).padStart(6)}  lost ${s.lost}`);
  }
  console.log(`avg candidate pool ${Math.round(poolSum / queries.length)} of ${entities.length} entities`);
  for (const ex of examples) console.log('  MISS', ex);

  if (missed) {
    console.error(`FAIL: prefilter lost ${missed} of ${totalHits} hits (recall ${((1 - missed / totalHits) * 100).toFixed(2)}%)`);
    process.exit(1);
  }
  console.log(`PASS: fast path == full scan on ${queries.length} queries / ${totalHits} hits at threshold ${THRESHOLD}`);
})();
