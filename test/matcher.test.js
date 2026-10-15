'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { finalizeSnapshot } = require('../lib/ingest');
const { screenEntity, tokens } = require('../lib/matcher');

// The fictional demo data: small, stable, and it exercises aliases, scripts,
// identifiers and every party type.
const sample = require(path.join(__dirname, '..', 'sample-data', 'sample.json'));
const snap = finalizeSnapshot(sample.entities, { publicationId: 'test' });
const byId = (id) => snap.entities.find((e) => String(e.id) === String(id));

function top(q, threshold = 0.95, mods = null) {
  return snap.entities
    .map((e) => ({ e, m: screenEntity(q, e, threshold, mods) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score);
}

test('tokens strip legal forms, dotted or not, but never a whole name', () => {
  assert.deepEqual(tokens('Acme S.A.'), ['ACME']);
  assert.deepEqual(tokens('ACME SA'), ['ACME']);
  assert.deepEqual(tokens('OOO Romashka'), ['ROMASHKA']);
  assert.ok(tokens('S.A.').length > 0);
});

test('a one-letter typo still ranks the party first, as a strong match', () => {
  // 0.94 for a dropped letter in a two-token name: strong, but under the 0.95
  // default — which is the product's chosen line, not a defect.
  const hits = top('Nothern Star Trading LLC', 0.9);
  assert.equal(String(hits[0].e.id), '90002');
  assert.equal(hits[0].m.matchType, 'strong');
});

test('exact, alias and reordered names find the party', () => {
  for (const [q, id] of [
    ['IVANOV, Dmitri Sergeyevich', 90001],
    ['Dmitri Sergeyevich Ivanov', 90001],
    ['Dmitry Ivanov', 90001],
    ['NORTH STAR TRADING', 90002],
    ['Crimson Horizon', 90003],
    ['Caspian Maritime Logistics', 90005],
  ]) {
    const hits = top(q);
    assert.ok(hits.length, `no hit for ${q}`);
    assert.equal(String(hits[0].e.id), String(id), `${q} → ${hits[0].e.name}`);
  }
});

/*
 * Descriptor words (TRADING, LIMITED…) are stripped before scoring. A typo in
 * one used to stay in the query as a token nothing could match, and dragged an
 * exact name from 1.00 to 0.78 — under the default threshold. The matcher now
 * also scores the query without a token one edit from a descriptor.
 */
test('a misspelled descriptor word does not sink an exact name', () => {
  for (const q of ['Northern Star Tradng LLC', 'Northern Star Trading Limted', 'Caspian Maritme Logistics']) {
    const hits = top(q);
    assert.ok(hits.length, `no hit for ${q}`);
  }
  assert.equal(String(top('Northern Star Tradng LLC')[0].e.id), '90002');
  assert.equal(top('Northern Star Tradng LLC')[0].m.score, 1);
});

test('the descriptor-typo variant never lowers a score', () => {
  const { screenEntity: score } = require('../lib/matcher');
  for (const e of snap.entities) {
    for (const n of e.names) {
      const m = score(n.name, e, 0);
      assert.ok(m && m.score >= 0.95, `${n.name} against its own record: ${m && m.score}`);
    }
  }
});

test('Cyrillic input is transliterated, not deleted', () => {
  const hits = top('ИВАНОВ Дмитрий');
  assert.ok(hits.some((h) => String(h.e.id) === '90001'));
});

test('identifiers match exactly, ignoring case and punctuation, and need 4+ characters', () => {
  const imo = top('IMO 9345678').find((h) => String(h.e.id) === '90003') || top('9345678').find((h) => String(h.e.id) === '90003');
  assert.ok(imo, 'IMO number finds the vessel');
  assert.equal(imo.m.matchType, 'identifier');
  assert.ok(top('ex 45012').some((h) => String(h.e.id) === '90011'), 'tail number with different punctuation');
  assert.equal(screenEntity('751', byId(90001), 0.95), null, 'three characters is not an identifier');
});

test('scores stay within [0,1] and never below the requested threshold', () => {
  for (const q of ['a', 'Mohammed', 'Bank', 'zz', 'x'.repeat(120), '<script>', '金正恩', 'محمد']) {
    for (const t of [0.8, 0.95, 1]) {
      for (const h of top(q, t)) {
        assert.ok(h.m.score >= t && h.m.score <= 1, `${q}@${t}: ${h.m.score}`);
      }
    }
  }
});

test('an unrelated name does not clear the default threshold', () => {
  assert.equal(top('Completely Unrelated Person').length, 0);
});

test('a contradicting year of birth is flagged as a conflict', () => {
  const hit = top('Dmitri Sergeyevich Ivanov', 0.95, { yob: '1800', country: '' })[0];
  if (hit) assert.equal(!!hit.m.conflict || hit.m.score < 1, true);
});

// bestNameFor skips names whose best possible score is under the floor (less
// the most the year-of-birth/country modifiers can add). That is only sound if
// it never changes an answer: every hit at a floor must be exactly the hit a
// floor-free run returns, and nothing below the floor may appear.
test('floor pruning returns exactly the floor-free hits above the floor', () => {
  const typo = (s) => (s.length > 6 ? s.slice(0, 3) + s.slice(4) : s);
  const queries = [];
  for (const e of snap.entities.slice(0, 40)) queries.push(e.name, typo(e.name), e.name.split(' ')[0]);
  // Plus each record's OWN year of birth and country, with near-miss spellings
  // of its name: the case where the modifiers lift a sub-floor name over it.
  const own = [];
  for (const e of snap.entities) {
    const dob = (e.attributes || []).find((a) => /date of birth/i.test(a.label));
    const yob = dob && (String(dob.value).match(/\b(19|20)\d\d\b/) || [])[0];
    const country = ((e.addresses || []).find((a) => a.country) || {}).country || '';
    if (!yob && !country) continue;
    const variants = [];
    for (let i = 1; i < e.name.length - 1; i += 2) variants.push(e.name.slice(0, i) + e.name.slice(i + 1));
    own.push({ mods: { yob: yob || '', country }, variants });
  }
  const modsList = [null, { yob: '1970', country: '' }, { yob: '', country: 'Russia' }, { yob: '1965', country: 'Iran' }];
  for (const o of own) for (const v of o.variants) for (const e of snap.entities) {
    const free = screenEntity(v, e, 0, o.mods);
    for (const floor of [0.9, 0.95]) {
      const got = screenEntity(v, e, floor, o.mods);
      if (got) assert.deepEqual(got, free, `${v} / ${e.id} @ ${floor}`);
      else if (free) assert.ok(free.score < floor + 1e-4, `${v} / ${e.id} @ ${floor} (own modifiers)`);
    }
  }
  let compared = 0, hits = 0;
  for (const q of queries) {
    for (const mods of modsList) {
      for (const e of snap.entities) {
        const free = screenEntity(q, e, 0, mods);
        for (const floor of [0.8, 0.9, 0.95]) {
          const got = screenEntity(q, e, floor, mods);
          const at = `${q} / ${e.id} @ ${floor}`;
          // Reported scores are rounded to 4 places and the floor is applied
          // before rounding, so a score that displays as exactly the floor may
          // fall either side of it; anywhere else the answer is determined.
          if (got) { assert.deepEqual(got, free, at); hits++; }
          else if (free) assert.ok(free.score < floor + 1e-4, at);
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 1000 && hits > 100, `${compared} comparisons, ${hits} hits`);
});

// ---- matcher improvements measured with scripts/eval-matching.js ----------
const { matchName, tokenSim, queryVariants } = require('../lib/matcher');
const person = (name) => ({ id: 'p', type: 'Individual', name, names: [{ name, primary: true }] });
const org = (name) => ({ id: 'o', type: 'Entity', name, names: [{ name, primary: true }] });
const score = (q, rec) => { const m = matchName(q, rec, 0, null); return m ? m.score : 0; };

test('a person\'s name keeps the short words an organisation name would drop', () => {
  // SOE, YU, HAN are organisation descriptors in rigour's tables and common
  // syllables of Burmese and Chinese names.
  assert.deepEqual(tokens('Soe Win', true), ['SOE', 'WIN']);
  assert.deepEqual(tokens('Soe Win'), ['WIN']);
  assert.deepEqual(tokens('Ahmad al-Hassan de la Cruz', true), ['AHMAD', 'HASSAN', 'CRUZ']);
  assert.ok(score('Soe Win', person('Aung Win')) < 0.8, 'one shared word is not the same person');
  assert.ok(score('Zhang Yu', person('Zhang Wei')) < 0.8);
  assert.equal(score('Soe Win', person('Soe Win')), 1);
});

test('one-keystroke typos and adjacent swaps are near-matches', () => {
  assert.equal(tokenSim('MOHNEN', 'MOHSEN'), 0.95);
  // Short swaps stay under 0.95 alone: they share no trigram for the index.
  const swap = tokenSim('NEAV', 'NEVA');
  assert.ok(swap >= 0.94 && swap < 0.95, String(swap));
  assert.ok(score('SHAFA\'I Mohnen', person('SHAFA\'I, Mohsen')) >= 0.95);
  assert.ok(score('ZHNAG Yu', person('ZHANG, Yu')) >= 0.95);
  // A different first letter is a different word, not a typo.
  assert.ok(tokenSim('KARIMOV', 'MARIMOV') < 0.95);
});

test('Arabic articles and particles match however they are written', () => {
  assert.equal(score('EL-FREIJ, Fahd Jassem', person('AL-FREIJ, Fahd Jassem')), 1);
  assert.ok(score('Mohammed ALGHABRA', person('Mohammed AL GHABRA')) >= 0.97);
  assert.ok(score('Sundus Abd EL-Ghafur', person('Sundus Abdul Ghafur')) >= 0.99);
  assert.equal(score('Haji Khaled NASRI', person('Khaled NASRI')), 1);
  assert.equal(score('General Ali Hassan Majid', person('Ali Hassan MAJID')), 1);
});

test('words run together or split apart still match', () => {
  assert.ok(score('ERMAKOV Alek sandr', person('ERMAKOV, Aleksandr')) >= 0.99);
  assert.ok(score('Abdulrahman Ali', person('Abdul Rahman Ali')) >= 0.99);
  // …but below the name exactly as written.
  assert.ok(score('Abdulrahman Ali', person('Abdul Rahman Ali')) < 1);
});

test('a typo in a word that canonicalization rewrites is read as that word', () => {
  assert.ok(queryVariants('ANWEN TEHCNOLOGY CO. LTD.').some((v) => v.join(' ') === 'ANWEN TECH'));
  assert.equal(score('ANWEN TEHCNOLOGY CO. LTD.', org('ANWEN TECHNOLOGY CO., LTD.')), 1);
});

test('explanations never show the canonical form rigour gives PUTIN', () => {
  const m = matchName('Vladimir Putin', person('Vladimir Puttin'), 0, null);
  assert.ok(!/KHUYLO/.test(m.explain), m.explain);
});
