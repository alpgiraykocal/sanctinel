'use strict';

// buildLiveSnapshot against a stubbed network. Its own file because the stub
// has to be in place before lib/ingest and the source modules are loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fetchMod = require('../lib/fetch');

const entityXml = (id, name) => `<entity id="${id}"><generalInfo><entityType>Entity</entityType></generalInfo><names><name><isPrimary>true</isPrimary><translations><translation><isPrimary>true</isPrimary><formattedFullName>${name}</formattedFullName></translation></translations></name></names></entity>`;
const many = (n, base) => `<entities>${Array.from({ length: n }, (_, i) => entityXml(base + i, `NAME ${base + i}`)).join('')}</entities>`;

fetchMod.fetchJson = async (url) => {
  if (url.includes('/sanctions-lists')) return ['SDN List', 'Non-SDN CMIC List', 'CAPTA List'];
  if (url.includes('/changes/history')) return [{ publicationID: 9, datePublished: '2026-10-15' }];
  throw new Error('unexpected json ' + url);
};
fetchMod.fetchText = async (url) => {
  if (url.includes('SDN%20List')) return many(150, 1000);
  if (url.includes('CMIC')) throw new Error('HTTP 500 for cmic');
  if (url.includes('CAPTA')) return '<entities></entities>';
  throw Object.assign(new Error('HTTP 500 for ' + url), { statusCode: 500 });
};

const ingest = require('../lib/ingest');

test('a failed or empty OFAC list and a down source are carried forward, not dropped', async () => {
  const previous = [
    { id: 'c1', authority: 'OFAC', list: 'Non-SDN CMIC List', lists: ['Non-SDN CMIC List'], names: [{ name: 'CMIC ONE' }], programs: [] },
    { id: 'c2', authority: 'OFAC', list: 'CAPTA List', lists: ['CAPTA List'], names: [{ name: 'CAPTA ONE' }], programs: [] },
    { id: 'EU-1', authority: 'EU', list: 'EU Consolidated List', names: [{ name: 'EU ONE' }], programs: [] },
  ];
  const warn = console.warn; console.warn = () => {}; const log = console.log; console.log = () => {};
  let snap;
  try {
    snap = await ingest.buildLiveSnapshot({ entities: previous, retrievedAt: '2026-10-01T00:00:00Z', authorityFreshness: { EU: '2026-09-30T00:00:00Z' } });
  } finally { console.warn = warn; console.log = log; }

  const ofac = snap.sources[0];
  assert.deepEqual(ofac.failedLists.map((f) => [f.list, f.carried]), [['Non-SDN CMIC List', 1], ['CAPTA List', 1]]);
  assert.ok(snap.entities.some((e) => e.id === 'c1'));
  assert.ok(snap.entities.some((e) => e.id === 'c2'));

  const eu = snap.sources.find((s) => s.label === 'EU FSD');
  assert.equal(eu.carriedForward, true);
  assert.equal(snap.authorityFreshness.EU, '2026-09-30T00:00:00Z');
  assert.ok(snap.entities.some((e) => e.id === 'EU-1'));
});
