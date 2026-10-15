'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ingest = require('../lib/ingest');

const ent = (id, authority, extra = {}) => Object.assign({ id, authority, list: authority + ' list', name: 'N' + id, names: [{ name: 'N' + id, primary: true }], programs: [] }, extra);

test('replaceAuthorities keeps fresh authorities and restores the regressed one with its own as-of date', () => {
  const fresh = ingest.finalizeSnapshot([ent('o1', 'OFAC'), ent('s-new', 'State')], {
    retrievedAt: '2026-10-15T00:00:00Z',
    authorityFreshness: { OFAC: '2026-10-15T00:00:00Z', State: '2026-10-15T00:00:00Z' },
    sources: [{ label: 'OFAC', authorities: ['OFAC'], ok: true }, { label: 'CSL', authorities: ['BIS', 'State'], ok: true }],
  });
  const carry = { entities: [ent('s-old', 'State'), ent('o-old', 'OFAC')], retrievedAt: '2026-10-02T00:00:00Z', authorityFreshness: { State: '2026-10-01T00:00:00Z' } };
  const out = ingest.replaceAuthorities(fresh, ['State'], carry);
  assert.deepEqual(out.entities.map((e) => e.id).sort(), ['o1', 's-old']);
  assert.equal(out.authorityFreshness.State, '2026-10-01T00:00:00Z');
  assert.equal(out.authorityFreshness.OFAC, '2026-10-15T00:00:00Z');
  assert.deepEqual(out.sources.find((s) => s.label === 'CSL').qualityCarriedForward, ['State']);
});

test('replaceAuthorities refuses when there is nothing to carry', () => {
  const fresh = ingest.finalizeSnapshot([ent('s1', 'State')], {});
  assert.equal(ingest.replaceAuthorities(fresh, ['State'], { entities: [] }), null);
  assert.equal(ingest.replaceAuthorities(fresh, ['State'], null), null);
});

test('staleAuthorities flags only authorities lagging the snapshot', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const snap = { retrievedAt: '2026-10-02T00:00:00Z', authorityFreshness: { OFAC: '2026-10-02T00:00:00Z', EU: '2026-10-01T00:00:00Z' } };
  const out = ingest.staleAuthorities(snap, now);
  assert.deepEqual(out.map((x) => x.authority), ['EU']);
  assert.equal(out[0].ageHours, 14 * 24);
});

test('authority coverage: regression blocks, standing gap ships', () => {
  const missingBis = { authorities: ingest.EXPECTED_AUTHORITIES.filter((a) => a !== 'BIS'), sources: [] };
  const regression = ingest.assertAuthorityCoverage(missingBis, ingest.EXPECTED_AUTHORITIES);
  assert.equal(regression.publishable, false);
  const standing = ingest.assertAuthorityCoverage(missingBis, missingBis.authorities);
  assert.equal(standing.publishable, true);
  assert.equal(standing.ok, false);
});

test('finalizeSnapshot drops nationality misfiled as a national ID and relabels legacy State records', () => {
  const snap = ingest.finalizeSnapshot([
    ent('1', 'OFAC', { identifiers: [{ type: 'National ID No.', value: 'Russia' }, { type: 'Passport', value: 'AB123' }] }),
    ent('2', 'State', { list: 'Nonproliferation Sanctions', programs: ['INKSNA'], legalAuthorities: ['Arms Export Control Act / ITAR'] }),
  ], {});
  assert.deepEqual(snap.entities[0].identifiers.map((i) => i.value), ['AB123']);
  assert.deepEqual(snap.entities[1].legalAuthorities, ['INKSNA']);
});

test('dedup keeps the specific list label and unions memberships', () => {
  const snap = ingest.finalizeSnapshot([
    ent('7', 'OFAC', { list: 'Consolidated List' }),
    ent('7', 'OFAC', { list: 'Non-SDN CMIC List' }),
  ], {});
  assert.equal(snap.count, 1);
  assert.equal(snap.entities[0].list, 'Non-SDN CMIC List');
  assert.deepEqual(snap.entities[0].lists.sort(), ['Consolidated List', 'Non-SDN CMIC List']);
});

test('parseRemarks extracts typed identifiers from OFAC remarks', () => {
  const { identifiers } = ingest.parseRemarks('DOB 01 Jan 1970; Passport X1234567 (Iran); IMO 9187629; Digital Currency Address - XBT 1abc');
  assert.deepEqual(identifiers.map((i) => i.type), ['Passport', 'IMO', 'Crypto XBT']);
});
