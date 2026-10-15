'use strict';

/*
 * How good is the matcher? A benchmark built from the snapshot itself.
 *
 *   node scripts/eval-matching.js [perCategory=150] [--json out.json] [--misses]
 *
 * scripts/verify-recall.js proves the fast path equals a full scan. It says
 * nothing about whether the scorer finds the right party in the first place —
 * a matcher that misses every transliteration would pass it perfectly. This
 * measures that, with ground truth the data already holds:
 *
 *   variant      An alias the publisher itself lists for a party — a real
 *                second spelling ("Mohamad Iqbal A Rahman", "Abu Jibril
 *                Abdurrahman") — held out: removed from the record, then
 *                searched for. The question is whether a spelling the list
 *                does NOT carry still finds the party.
 *   crossAuth    The same party as written by another authority, from
 *                cross-listing groups linked on an identifier or a birth year
 *                ("TSANG, Yung Yuan" at OFAC, "Yun Yuan Tsang" at the EU).
 *   typo1/typo2  One or two keyboard edits.
 *   reorder      Name order reversed, the "SURNAME, Given" swap.
 *   dropMiddle   A middle name or patronymic left out.
 *   joinSplit    Two words run together, or one split ("Abdul Rahman" ↔
 *                "Abdulrahman").
 *   translit     Romanization variants (ou/u, ee/i, kh/h, y/i, -iy/-y …).
 *   particles    Arabic particles written another way (al-, el, bin/ibn,
 *                abdul/abd al).
 *   initials     A given name reduced to its initial ("V. PUTIN").
 *   noise        A title or legal form added ("Mr", "LLC", "Trading").
 *
 * For each query: is the true party among the hits at the 0.95 default
 * (recall), is it ranked first (top1 — ties at the top count), and how many
 * hits does the query raise in total (alerts — the review cost).
 *
 *   negative     Two real name halves from different listed individuals,
 *                recombined into a person nobody listed. Every hit is a false
 *                alert; the number to keep down.
 *
 * Deterministic: a fixed seed, so two runs are comparable.
 */

const { readCache } = require('../lib/ingest');
const { screenEntity, normalize } = require('../lib/matcher');
const searchIndex = require('../lib/searchindex');
const { index: crossIndex } = require('../lib/crosslist');

const THRESHOLD = 0.95;
const args = process.argv.slice(2);
const PER = Number(args.find((a) => /^\d+$/.test(a))) || 150;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';
const showMisses = args.includes('--misses');

let seed = 20261015;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const latin = (s) => /^[A-Za-z][A-Za-z .,'\-]*$/.test(String(s || '').trim());
const words = (s) => String(s || '').replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);

const cached = readCache();
if (!cached) { console.error('No snapshot on disk.'); process.exit(1); }
const snap = cached.snapshot;
const E = snap.entities;
const idx = searchIndex.build(E);
const byId = new Map(E.map((e, i) => [String(e.id), i]));

function search(q, recordOverride) {
  const cand = searchIndex.candidates(idx, q) || E.map((_, i) => i);
  const hits = [];
  for (const i of cand) {
    const e = recordOverride && recordOverride.i === i ? recordOverride.e : E[i];
    const m = screenEntity(q, e, THRESHOLD, null);
    if (m) hits.push({ id: String(e.id), score: m.score });
  }
  // A held-out record must be scored even if the index (built on the full
  // record) would not have proposed it for this spelling — the question is the
  // scorer's, and verify-recall separately proves the index matches a full scan.
  if (recordOverride && !cand.includes(recordOverride.i)) {
    const m = screenEntity(q, recordOverride.e, THRESHOLD, null);
    if (m) hits.push({ id: String(recordOverride.e.id), score: m.score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

// ---- generators ----------------------------------------------------------
const persons = E.filter((e) => /individual/i.test(e.type) && latin(e.name) && words(e.name).length >= 2);
const orgs = E.filter((e) => /entity/i.test(e.type) && latin(e.name) && words(e.name).length >= 2);
const people3 = persons.filter((e) => words(e.name).length >= 3);

function edit(w) {
  if (w.length < 4) return w;
  const a = w.split('');
  const i = 1 + Math.floor(rnd() * (a.length - 2));
  const k = Math.floor(rnd() * 4);
  if (k === 0) a.splice(i, 1);
  else if (k === 1) { const t = a[i]; a[i] = a[i + 1] || t; a[i + 1] = t; }
  else if (k === 2) a[i] = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)];
  else a.splice(i, 0, a[i]);
  return a.join('');
}
const longWords = (ws) => ws.map((w, i) => [w, i]).filter(([w]) => w.replace(/\W/g, '').length >= 4);

const TRANSLIT = [
  [/OU/gi, 'U'], [/U(?=[^aeiouAEIOU])/g, 'OU'], [/EE/gi, 'I'], [/KH/gi, 'H'], [/IY\b/gi, 'Y'], [/Y\b/gi, 'IY'],
  [/Y(?=[AEIOUaeiou])/g, 'I'], [/I(?=[AEIOUaeiou])/g, 'Y'], [/PH/gi, 'F'], [/SH/gi, 'SCH'], [/J/g, 'DZH'],
  [/V\b/g, 'FF'], [/MM/gi, 'M'], [/M(?=AD\b)/g, 'MM'], [/CK/gi, 'K'], [/Q/g, 'K'], [/Z/g, 'S'], [/E(?=V\b)/g, 'YE'],
  [/X/g, 'KS'], [/AI/g, 'AY'], [/O(?=[^aeiouAEIOU]+A)/g, 'U'],
];
function translit(name) {
  for (let tries = 0; tries < 12; tries++) {
    const [re, to] = pick(TRANSLIT);
    const out = name.replace(re, (m) => (m === m.toLowerCase() ? to.toLowerCase() : to));
    if (out !== name) return out;
  }
  return null;
}

const PARTICLES = [
  [/\bAL[- ]/gi, ''], [/\bAL[- ]/gi, 'EL-'], [/\bAL[- ](\w)/gi, 'AL$1'], [/\bBIN\b/gi, 'IBN'], [/\bIBN\b/gi, 'BIN'],
  [/\bABDUL\s?/gi, 'ABD AL-'], [/\bABD\s?AL[- ]?/gi, 'ABDUL'], [/\bABU\b/gi, 'ABOU'], [/\bBEN\b/gi, 'BIN'],
  [/\bEL[- ]/gi, 'AL-'],
];
function particle(name) {
  for (const [re, to] of PARTICLES.slice().sort(() => rnd() - 0.5)) {
    re.lastIndex = 0;
    if (re.test(name)) { re.lastIndex = 0; const out = name.replace(re, to).replace(/\s+/g, ' ').trim(); if (out !== name) return out; }
  }
  return null;
}

const NOISE_PERSON = ['Mr', 'Dr', 'Sheikh', 'General', 'Haji'];
const NOISE_ORG = ['LLC', 'Ltd', 'Company', 'Trading', 'Group', 'Co.', 'JSC', 'International'];

function buildCases() {
  const cases = [];
  const add = (kind, q, id, extra) => { if (q && q.trim().length >= 3) cases.push({ kind, q: q.trim(), id: String(id), ...extra }); };

  // variant: a publisher-listed alias, held out of its own record.
  const withAliases = E.filter((e) => (e.names || []).filter((n) => !n.primary && latin(n.name) && words(n.name).length >= 2).length);
  for (let n = 0, guard = 0; n < PER && guard < PER * 50; guard++) {
    const e = pick(withAliases);
    const alias = pick(e.names.filter((x) => !x.primary && latin(x.name) && words(x.name).length >= 2));
    /*
     * Only aliases that are another SPELLING of the primary name: the same
     * number of words, each word paired with a primary word that starts with
     * the same consonant skeleton letter and is of similar length. A nom de
     * guerre, a maiden name or a renamed company is a different name — no
     * spelling-based scorer can or should find it, so it is not a miss.
     */
    const p = normalize(e.name).split(' '), a = normalize(alias.name).split(' ');
    if (p.length !== a.length || normalize(alias.name) === normalize(e.name)) continue;
    const first = (t) => t.replace(/^[AEIOUY]+/, '')[0] || t[0];
    const used = new Set();
    const paired = a.every((t) => {
      const j = p.findIndex((u, k) => !used.has(k) && first(u) === first(t) && Math.abs(u.length - t.length) <= 2);
      if (j === -1) return false; used.add(j); return true;
    });
    if (!paired) continue;
    const held = Object.assign({}, e, { names: e.names.filter((x) => x !== alias && normalize(x.name) !== normalize(alias.name)) });
    add('variant', alias.name, e.id, { held });
    n++;
  }

  // crossAuth: another authority's spelling of the same party.
  const { groups } = crossIndex(E);
  const pairs = [];
  for (const g of groups.values()) {
    if (g.basis === 'name+country') continue;
    for (const a of g.ids) for (const b of g.ids) {
      const ea = E[byId.get(String(a))], eb = E[byId.get(String(b))];
      if (!ea || !eb || ea.authority === eb.authority) continue;
      if (normalize(ea.name) === normalize(eb.name)) continue;
      pairs.push([ea, eb]);
    }
  }
  for (let n = 0; n < PER && pairs.length; n++) { const [a, b] = pick(pairs); add('crossAuth', a.name, b.id); }

  for (let n = 0; n < PER; n++) {
    const e = pick(rnd() < 0.6 ? persons : orgs); const ws = words(e.name); const lw = longWords(ws);
    if (!lw.length) continue; const [w, i] = pick(lw); ws[i] = edit(w); add('typo1', ws.join(' '), e.id);
  }
  for (let n = 0; n < PER; n++) {
    const e = pick(persons); const ws = words(e.name); const lw = longWords(ws);
    if (lw.length < 2) continue; const [w1, i1] = lw[0], [w2, i2] = lw[lw.length - 1];
    ws[i1] = edit(w1); ws[i2] = edit(w2); add('typo2', ws.join(' '), e.id);
  }
  for (let n = 0; n < PER; n++) { const e = pick(persons); add('reorder', words(e.name).reverse().join(' '), e.id); }
  for (let n = 0; n < PER && people3.length; n++) {
    const e = pick(people3); const ws = words(e.name); ws.splice(1 + Math.floor(rnd() * (ws.length - 2)), 1); add('dropMiddle', ws.join(' '), e.id);
  }
  for (let n = 0, g = 0; n < PER && g < PER * 20; g++) {
    const e = pick(rnd() < 0.5 ? persons : orgs); const ws = words(e.name);
    let q = null;
    if (ws.length >= 3 && rnd() < 0.6) { const i = Math.floor(rnd() * (ws.length - 1)); const j = ws.slice(); j.splice(i, 2, ws[i] + ws[i + 1]); q = j.join(' '); }
    else { const lw = ws.map((w, i) => [w, i]).filter(([w]) => w.length >= 8); if (lw.length) { const [w, i] = pick(lw); const c = 3 + Math.floor(rnd() * (w.length - 6)); const j = ws.slice(); j.splice(i, 1, w.slice(0, c), w.slice(c)); q = j.join(' '); } }
    if (q) { add('joinSplit', q, e.id); n++; }
  }
  for (let n = 0, g = 0; n < PER && g < PER * 20; g++) { const e = pick(persons); const q = translit(e.name); if (q) { add('translit', q, e.id); n++; } }
  const arabic = E.filter((e) => latin(e.name) && /\b(AL|EL|BIN|IBN|ABDUL|ABD|ABU|BEN)\b/i.test(e.name));
  for (let n = 0, g = 0; n < PER && g < PER * 20; g++) { const e = pick(arabic); const q = particle(e.name); if (q) { add('particles', q, e.id); n++; } }
  for (let n = 0, g = 0; n < PER && g < PER * 20; g++) {
    const e = pick(persons); const ws = words(e.name);
    // OFAC writes "SURNAME, Given Middle"; abbreviate a given name.
    const comma = String(e.name).includes(',');
    const gi = comma ? ws.length - 1 : 0;
    if (ws.length < 2 || ws[gi].length < 3) continue;
    ws[gi] = ws[gi][0] + '.'; add('initials', ws.join(' '), e.id); n++;
  }
  for (let n = 0; n < PER; n++) {
    const isP = rnd() < 0.5; const e = pick(isP ? persons : orgs);
    add('noise', isP ? `${pick(NOISE_PERSON)} ${e.name}` : `${e.name} ${pick(NOISE_ORG)}`, e.id);
  }
  // negative: first word of one listed person + last word of another.
  for (let n = 0; n < PER; n++) {
    const a = words(pick(persons).name.replace(/,.*/, '')), b = words(pick(persons).name);
    add('negative', `${b[b.length - 1]} ${a[0]}`, '');
  }
  return cases;
}

// ---- run -----------------------------------------------------------------
const cases = buildCases();
const stats = new Map();
const misses = [];
const t0 = Date.now();
for (const c of cases) {
  const override = c.held ? { i: byId.get(c.id), e: c.held } : null;
  const hits = search(c.q, override);
  const s = stats.get(c.kind) || { n: 0, found: 0, top1: 0, alerts: 0 };
  s.n++; s.alerts += hits.length;
  if (c.kind !== 'negative') {
    const mine = hits.find((h) => h.id === c.id);
    if (mine) { s.found++; if (mine.score >= hits[0].score) s.top1++; }
    else misses.push({ kind: c.kind, q: c.q, want: E[byId.get(c.id)].name, auth: E[byId.get(c.id)].authority, best: hits[0] ? `${E[byId.get(hits[0].id)].name} ${hits[0].score}` : '' });
  }
  stats.set(c.kind, s);
}
const ms = Date.now() - t0;

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`snapshot ${snap.publicationId} · ${E.length} parties · ${cases.length} queries in ${(ms / 1000).toFixed(1)}s`);
console.log(`${'category'.padEnd(12)}${'n'.padStart(5)}${'recall'.padStart(9)}${'top1'.padStart(9)}${'alerts/q'.padStart(10)}`);
let tn = 0, tf = 0, tt = 0;
for (const [k, s] of stats) {
  console.log(`${k.padEnd(12)}${String(s.n).padStart(5)}${(k === 'negative' ? '' : pct(s.found, s.n)).padStart(9)}${(k === 'negative' ? '' : pct(s.top1, s.n)).padStart(9)}${(s.alerts / s.n).toFixed(2).padStart(10)}`);
  if (k !== 'negative') { tn += s.n; tf += s.found; tt += s.top1; }
}
console.log(`${'ALL'.padEnd(12)}${String(tn).padStart(5)}${pct(tf, tn).padStart(9)}${pct(tt, tn).padStart(9)}`);
if (showMisses) for (const m of misses) console.log(`MISS ${m.kind.padEnd(10)} q="${m.q}" want="${m.want}" [${m.auth}] best=${m.best}`);
if (jsonOut) require('fs').writeFileSync(jsonOut, JSON.stringify({ stats: Object.fromEntries(stats), misses }, null, 1));
