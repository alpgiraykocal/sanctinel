'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJson, resolveSource } = require('../lib/sources/csl');

const row = (source, extra = {}) => Object.assign({ id: Math.random().toString(16).slice(2), name: 'Party ' + source, source }, extra);
const parse = (rows) => { const unmapped = new Map(); return { recs: parseJson(JSON.stringify({ results: rows }), unmapped), unmapped }; };

test('State nonproliferation list is kept under both its ISN and ACN labels', () => {
  const { recs, unmapped } = parse([
    row('Nonproliferation Sanctions (ISN) - State Department'),
    row('Nonproliferation Sanctions (ACN) - State Department'),
  ]);
  assert.equal(recs.length, 2);
  for (const r of recs) {
    assert.equal(r.authority, 'State');
    assert.equal(r.list, 'Nonproliferation Sanctions');
  }
  assert.equal(unmapped.size, 0, 'known labels are not reported');
});

test('an unknown BIS or State label is kept under its agency and reported', () => {
  const { recs, unmapped } = parse([
    row('Brand New List (BNL) - Bureau of Industry and Security'),
    row('Some Renamed List (XYZ) - State Department'),
  ]);
  assert.deepEqual(recs.map((r) => [r.authority, r.list]), [['BIS', 'Brand New List'], ['State', 'Some Renamed List']]);
  assert.equal(unmapped.size, 2);
});

test('Treasury lists are skipped silently; an unrelated label is skipped and reported', () => {
  const { recs, unmapped } = parse([
    row('Specially Designated Nationals (SDN) - Treasury Department'),
    row('Something Else Entirely'),
  ]);
  assert.equal(recs.length, 0);
  assert.deepEqual([...unmapped.keys()], ['Something Else Entirely']);
  assert.equal(resolveSource('Something Else Entirely'), null);
});

test('legal authority follows the list, not the agency', () => {
  const { recs } = parse([
    row('ITAR Debarred (DTC) - State Department'),
    row('Nonproliferation Sanctions (ACN) - State Department', { programs: ['INKSNA'] }),
    row('Nonproliferation Sanctions (ACN) - State Department'),
    row('Entity List (EL) - Bureau of Industry and Security'),
  ]);
  assert.deepEqual(recs.map((r) => r.legalAuthorities), [
    ['Arms Export Control Act / ITAR'],
    ['INKSNA'],
    ['Nonproliferation statutes (see Federal Register notice)'],
    ['Export Administration Regulations (EAR)'],
  ]);
});

test('aliases and addresses are mapped; the primary name is not repeated as an alias', () => {
  const { recs } = parse([row('Entity List (EL) - Bureau of Industry and Security', {
    name: 'Acme Ltd', alt_names: ['ACME LTD', 'Acme Trading'],
    addresses: [{ address: '1 Road', city: 'Town', country: 'CN' }],
  })]);
  assert.deepEqual(recs[0].names.map((n) => n.name), ['Acme Ltd', 'Acme Trading']);
  assert.deepEqual(recs[0].addresses, [{ full: '1 Road, Town, CN', country: 'CN' }]);
});
