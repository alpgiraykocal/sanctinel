'use strict';

/*
 * Inventory every field each upstream source actually publishes.
 *
 *   node scripts/source-inventory.js [ofac|eu|un|uk|csl ...]
 *
 * The parsers in lib/ and lib/sources/ were written against an idea of each
 * feed's shape, and that idea can be wrong without anything failing: OFAC's
 * address lines sat in typed <addressPart> elements the parser never looked
 * for, so every OFAC address came through as its country alone, and the build
 * was green for months. A parser only reads what it asks for. This reads what
 * is THERE — every element path, attribute and CSV/JSON column, how many
 * records carry it, sample values, and the full value set of small
 * enumerations (address part types, document types, feature types) — so the
 * parsers can be checked against the feed rather than against themselves.
 *
 * Read-only: it fetches and prints. Run by .github/workflows/source-inventory.yml,
 * because the sources are reachable from the CI runners.
 */

const { fetchText } = require('../lib/fetch');
const { parse, descendants } = require('../lib/xml');
const { parseCsv } = require('../lib/csv');

const OFAC_BASE = 'https://sanctionslistservice.ofac.treas.gov';
const EU_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
const UN_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const UK_URL = 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv';
const CSL_URL = 'https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json';

const SAMPLE = 3, ENUM_MAX = 40, CUT = 70;
const short = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > CUT ? t.slice(0, CUT) + '…' : t; };

// path -> { records, occurrences, samples:Set, values:Map|null }
function inventory() {
  const paths = new Map();
  let records = 0;
  const touch = (path, value, seen) => {
    let p = paths.get(path);
    if (!p) { p = { records: 0, occurrences: 0, samples: new Set(), values: new Map() }; paths.set(path, p); }
    p.occurrences++;
    if (!seen.has(path)) { seen.add(path); p.records++; }
    if (value !== undefined && value !== '') {
      const v = short(value);
      if (p.samples.size < SAMPLE) p.samples.add(v);
      if (p.values) { p.values.set(v, (p.values.get(v) || 0) + 1); if (p.values.size > ENUM_MAX) p.values = null; }
    }
  };
  return {
    record() { records++; return new Set(); },
    touch,
    print(title) {
      console.log(`\n=== ${title}: ${records} records, ${paths.size} paths ===`);
      for (const [path, p] of [...paths].sort((a, b) => a[0].localeCompare(b[0]))) {
        const pct = records ? ((p.records / records) * 100).toFixed(1) : '0';
        let line = `${path}  [${p.records} rec, ${pct}%, ${p.occurrences}x]`;
        if (p.values && p.values.size && p.values.size <= ENUM_MAX && p.occurrences > p.values.size) {
          line += `  ENUM ${[...p.values].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}=${n}`).join(' | ')}`;
        } else if (p.samples.size) line += `  e.g. ${[...p.samples].join(' | ')}`;
        console.log(line);
      }
    },
  };
}

function walkXml(node, prefix, inv, seen) {
  for (const [k, v] of Object.entries(node.attrs || {})) inv.touch(`${prefix}@${k}`, v, seen);
  const hasChildren = (node.children || []).length > 0;
  inv.touch(prefix, hasChildren ? undefined : node.text, seen);
  for (const c of node.children || []) walkXml(c, `${prefix}/${c.tag}`, inv, seen);
}

// Records delimited by an opening tag, parsed one at a time to bound memory.
function xmlBlocks(xml, tag, cb) {
  const OPEN = `<${tag} `, OPEN2 = `<${tag}>`, CLOSE = `</${tag}>`;
  let i = xml.indexOf(OPEN); if (i === -1) i = xml.indexOf(OPEN2);
  while (i !== -1) {
    const end = xml.indexOf(CLOSE, i);
    if (end === -1) break;
    const node = parse(xml.slice(i, end + CLOSE.length)).children.find((c) => c.tag === tag);
    if (node) cb(node);
    const a = xml.indexOf(OPEN, end), b = xml.indexOf(OPEN2, end);
    i = a === -1 ? b : (b === -1 ? a : Math.min(a, b));
  }
}

async function ofac() {
  const lists = JSON.parse(await fetchText(`${OFAC_BASE}/sanctions-lists`, { timeout: 60000 }));
  console.log(`\nOFAC lists: ${JSON.stringify(lists)}`);
  const inv = inventory();
  const printed = new Set();
  for (const list of ['SDN List', ...lists.filter((l) => l !== 'SDN List' && l !== 'Consolidated List')]) {
    let xml;
    try { xml = await fetchText(`${OFAC_BASE}/entities?list=${encodeURIComponent(list)}`, { timeout: 180000 }); } catch (e) { console.log(`OFAC ${list}: ${e.message}`); continue; }
    xmlBlocks(xml, 'entity', (node) => {
      walkXml(node, 'entity', inv, inv.record());
      // A raw record verbatim for each structure the parser has got wrong
      // before — an address with more than a country, an identity document, a
      // relationship — so the exact nesting is on record, not only inferred.
      const raw = JSON.stringify(node);
      for (const [kind, re] of [['address', /"tag":"address"[\s\S]*"tag":"translation"/], ['document', /ocument"/], ['relationship', /"tag":"relationship"/]]) {
        if (printed.has(kind) || raw.length > 20000 || !re.test(raw)) continue;
        const start = xml.indexOf(`<entity id="${node.attrs.id}"`);
        if (start === -1) continue;
        console.log(`\nOFAC raw sample with ${kind} (${list}, entity ${node.attrs.id}):\n${xml.slice(start, xml.indexOf('</entity>', start) + 9)}`);
        printed.add(kind);
      }
    });
  }
  inv.print('OFAC SLS /entities');
}

async function eu() {
  const xml = await fetchText(EU_URL, { timeout: 120000 });
  const inv = inventory();
  xmlBlocks(xml, 'sanctionEntity', (node) => walkXml(node, 'sanctionEntity', inv, inv.record()));
  inv.print('EU FSF xmlFullSanctionsList_1_1');
}

async function un() {
  const xml = await fetchText(UN_URL, { timeout: 120000 });
  const root = parse(xml);
  for (const tag of ['INDIVIDUAL', 'ENTITY']) {
    const inv = inventory();
    for (const node of descendants(root, tag)) walkXml(node, tag, inv, inv.record());
    inv.print(`UN consolidated ${tag}`);
  }
}

async function uk() {
  const rows = parseCsv(await fetchText(UK_URL, { timeout: 120000 }));
  const header = rows[1];
  const inv = inventory();
  for (const row of rows.slice(2)) {
    if (!row || row.length < 2) continue;
    const seen = inv.record();
    header.forEach((h, i) => { const v = (row[i] || '').trim(); if (v) inv.touch(h.trim(), v, seen); });
  }
  inv.print('UK OFSI ConList.csv (rows, one per name variant)');
}

function walkJson(v, path, inv, seen) {
  if (Array.isArray(v)) { for (const x of v) walkJson(x, `${path}[]`, inv, seen); return; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walkJson(x, path ? `${path}.${k}` : k, inv, seen); return; }
  if (v === null || v === '' || v === undefined) return;
  inv.touch(path, v, seen);
}

async function csl() {
  const j = JSON.parse(await fetchText(CSL_URL, { timeout: 120000 }));
  const bySource = new Map();
  for (const r of j.results || []) {
    const src = r.source || '(none)';
    if (!bySource.has(src)) bySource.set(src, inventory());
    const inv = bySource.get(src);
    walkJson(r, '', inv, inv.record());
  }
  for (const [src, inv] of bySource) inv.print(`CSL source "${src}"`);
}

const RUN = { ofac, eu, un, uk, csl };
(async () => {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(RUN);
  let failed = 0;
  for (const name of want) {
    try { await RUN[name](); } catch (e) { failed++; console.log(`\n=== ${name}: FAILED — ${e.message} ===`); }
  }
  process.exit(failed === want.length ? 1 : 0);
})();
