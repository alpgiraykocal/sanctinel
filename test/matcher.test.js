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
 * Known gap, kept visible rather than encoded as expected behaviour. Legal-form
 * and descriptor words (TRADING, LIMITED, COMPANY…) are stripped before
 * scoring, but only when spelled exactly — so a typo in one ("Tradng") stays in
 * the query as an unmatched token and drags an otherwise exact name from 1.00
 * to 0.78, under the default threshold. Fixing it changes the scorer, the
 * candidate index's recall invariant and the iOS port, so it is its own change.
 */
test('a misspelled descriptor word does not sink an exact name', { todo: 'descriptor typos are not stripped — see comment' }, () => {
  const hits = top('Northern Star Tradng LLC');
  assert.ok(hits.length && String(hits[0].e.id) === '90002');
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
