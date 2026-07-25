'use strict';

/*
 * Compile the OpenSanctions "rigour" reference YAML (data/*.yml) into one
 * compact JSON the matcher loads at runtime (data/matching.json):
 *
 *   strip[]        multilingual org descriptors + legal-form tokens to drop
 *                  (company, gmbh, ooo, ltd, sa, ag, jsc, kompaniya, …)
 *   canon{}        domain-token → canonical key (tekhnologiya → tech) so
 *                  cross-language domain words match
 *   titles[][]     safe personal honorifics (token sequences) to strip
 *   confusables[]  visually/phonetically confusable char pairs (0↔o, 1↔l)
 *
 * Only ASCII-representable tokens are kept (our normalizer folds to A-Z0-9),
 * which naturally covers the Latin + transliterated variants OFAC uses.
 *
 *   node scripts/build-matching-data.js
 *
 * Data © OpenSanctions, rigour library (MIT). See data/*.yml.
 */

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');

const stripComment = (s) => { const i = s.indexOf(' #'); return (i >= 0 ? s.slice(0, i) : s).trim(); };
const unquote = (s) => s.replace(/^["']|["']$/g, '');
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);

// --- symbols.yml: org_symbols (strip) + org_domains (canon) ---
function parseSymbols() {
  const lines = fs.readFileSync(path.join(DATA, 'symbols.yml'), 'utf8').split('\n');
  const strip = new Set(), canon = {};
  let section = null, key = null;
  for (const raw of lines) {
    if (/^org_symbols:/.test(raw)) { section = 'sym'; continue; }
    if (/^org_domains:/.test(raw)) { section = 'dom'; continue; }
    if (!section) continue;
    const km = raw.match(/^ {2}([\w-]+):\s*$/);
    if (km) { key = km[1]; continue; }
    const vm = raw.match(/^ {4}- (.+)$/);
    if (vm && key) {
      const val = unquote(stripComment(vm[1]));
      const t = toks(val);
      if (section === 'sym') { for (const x of t) strip.add(x); }
      // Canon only single-token domain values, so multi-word phrases like
      // "insurance company" don't map the common word COMPANY to a domain.
      else if (t.length === 1 && !(t[0] in canon)) canon[t[0]] = key;
    }
  }
  return { strip, canon };
}

// --- org_types.yml: list of {display, generic, compare, aliases[]} → all tokens strip ---
function parseOrgTypes() {
  const lines = fs.readFileSync(path.join(DATA, 'org_types.yml'), 'utf8').split('\n');
  const strip = new Set();
  let inAliases = false;
  for (const raw of lines) {
    const f = raw.match(/^ {2,4}- (display|generic|compare):\s*(.*)$/) || raw.match(/^ {4}(display|generic|compare):\s*(.*)$/);
    if (f) { inAliases = false; for (const t of toks(unquote(stripComment(f[2])))) strip.add(t); continue; }
    if (/^ {4}aliases:\s*$/.test(raw)) { inAliases = true; continue; }
    const a = raw.match(/^ {6}- (.+)$/);
    if (a && inAliases) { for (const t of toks(unquote(stripComment(a[1])))) strip.add(t); }
  }
  return strip;
}

// --- stopwords.yml: safe personal titles + org/obj prefixes ---
function parseStopwords() {
  const text = fs.readFileSync(path.join(DATA, 'stopwords.yml'), 'utf8');
  const block = (name) => {
    const re = new RegExp(`^${name}:\\s*$([\\s\\S]*?)^(?=\\S|$)`, 'm');
    const m = text.match(re);
    if (!m) return [];
    return m[1].split('\n').map((l) => l.match(/^\s+- (.+)$/)).filter(Boolean).map((x) => unquote(stripComment(x[1])));
  };
  // Titles that are unambiguously personal (exclude ranks/offices that also
  // appear in org names: General, President, Director, Chairman, Captain, …).
  const deny = /general|president|director|chair|secretary|captain|capt|private|pvt|commodore|admiral|colonel|brigadier|marshal|lieutenant|ambassador|amb|emperor|empress|queen|king|count|duke|earl|baron|duchess|grand|laird|seigneur|worshipful|master|prince/i;
  const titles = block('PERSON_NAME_PREFIXES')
    .filter((t) => !deny.test(t))
    .map((t) => toks(t)).filter((a) => a.length);
  const prefixes = new Set();
  for (const list of ['ORG_NAME_PREFIXES', 'OBJ_NAME_PREFIXES']) for (const p of block(list)) for (const t of toks(p)) prefixes.add(t);
  return { titles, prefixes };
}

// --- compare.yml: confusable char pairs ---
function parseCompare() {
  const text = fs.readFileSync(path.join(DATA, 'compare.yml'), 'utf8');
  const out = [];
  for (const m of text.matchAll(/^\s*- \["(.+?)",\s*"(.+?)"\]/gm)) {
    const a = m[1].toUpperCase(), b = m[2].toUpperCase();
    if (a !== b) out.push([a, b]);
  }
  return out;
}

const sym = parseSymbols();
const orgStrip = parseOrgTypes();
const stop = parseStopwords();
const confusables = parseCompare();

const strip = new Set([...sym.strip, ...orgStrip, ...stop.prefixes]);
// A canonical domain token must not also be stripped.
for (const k of Object.keys(sym.canon)) strip.delete(k);

const out = {
  strip: [...strip].filter(Boolean).sort(),
  canon: sym.canon,
  titles: stop.titles,
  confusables,
  _source: 'OpenSanctions rigour (MIT) — data/*.yml',
};
fs.writeFileSync(path.join(DATA, 'matching.json'), JSON.stringify(out));
console.log(`matching.json: ${out.strip.length} strip tokens, ${Object.keys(out.canon).length} canon, ${out.titles.length} titles, ${out.confusables.length} confusables`);
