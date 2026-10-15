'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../lib/quality');

const auth = (count, extra = {}) => Object.assign({
  count, aliasRate: 0.5, addressRate: 0.5, identifierRate: 0.5, birthDateRate: 0.5, nationalityRate: 0.5, relationshipEdges: 0,
}, extra);
const prof = (authorities, derived = {}) => ({
  authorities,
  derived: Object.assign({ dobParseRate: 1, countryResolveRate: 1, attributeUnclassifiedRate: 0, identifierUnclassifiedRate: 0.04 }, derived),
});

test('ordinary churn passes', () => {
  const r = quality.compare(prof({ OFAC: auth(20100) }), prof({ OFAC: auth(20000) }));
  assert.equal(r.publishable, true);
  assert.equal(r.ok, true);
});

test('a party count drop over 10% is a regression scoped to that authority', () => {
  const r = quality.compare(prof({ OFAC: auth(20000), State: auth(801) }), prof({ OFAC: auth(20000), State: auth(962) }));
  assert.equal(r.publishable, false);
  assert.deepEqual(r.regressions.map((f) => f.metric), ['State.count']);
  assert.deepEqual(quality.regressedAuthorities(r, ['OFAC', 'State']), ['State']);
});

test('a fill-rate collapse is a regression; a near-empty field is not compared', () => {
  const r = quality.compare(prof({ EU: auth(6000, { addressRate: 0.1, identifierRate: 0.02 }) }),
    prof({ EU: auth(6000, { addressRate: 0.4, identifierRate: 0.04 }) }));
  assert.deepEqual(r.regressions.map((f) => f.metric), ['EU.addressRate']);
});

test('a global regression cannot be scoped to an authority', () => {
  const r = quality.compare(prof({ OFAC: auth(20000) }, { dobParseRate: 0.5 }), prof({ OFAC: auth(20000) }));
  assert.equal(r.publishable, false);
  assert.equal(quality.regressedAuthorities(r, ['OFAC']), null);
});

test('below a floor without regressing publishes but is not ok', () => {
  const r = quality.compare(prof({ OFAC: auth(1) }, { dobParseRate: 0.9 }), prof({ OFAC: auth(1) }, { dobParseRate: 0.9 }));
  assert.equal(r.publishable, true);
  assert.equal(r.ok, false);
});

test('profile measures per authority', () => {
  const p = quality.profile({ entities: [
    { authority: 'UN', names: [{ name: 'a' }, { name: 'b' }], addresses: [{ country: 'Iran' }], identifiers: [], attributes: [{ label: 'Date of Birth', value: '1970-01-01' }] },
    { authority: 'UN', names: [{ name: 'c' }], addresses: [], identifiers: [], attributes: [] },
  ] });
  assert.equal(p.authorities.UN.count, 2);
  assert.equal(p.authorities.UN.aliasRate, 0.5);
  assert.equal(p.authorities.UN.birthDateRate, 0.5);
  assert.equal(p.derived.dobParseRate, 1);
});
