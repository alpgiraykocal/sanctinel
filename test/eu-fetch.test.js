'use strict';

// lib/sources/eu.js route order against a stubbed network. The stub must be in
// place before eu.js loads, so this has its own file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fetchMod = require('../lib/fetch');

const xml = `<export>${Array.from({ length: 1001 }, (_, i) =>
  `<sanctionEntity logicalId="${i}" euReferenceNumber="EU.${i}"><subjectType code="person"/><nameAlias wholeName="Person ${i}"/></sanctionEntity>`).join('')}</export>`;
const httpErr = (code) => Object.assign(new Error(`HTTP ${code}`), { statusCode: code });

let handler = async () => xml;
const calls = [];
fetchMod.fetchText = async (url) => { calls.push(url); return handler(url); };
const { fetchEU, catalogueUrls } = require('../lib/sources/eu');

test.beforeEach(() => { calls.length = 0; delete process.env.EU_FSF_TOKEN; });

test('the public token is used when nothing else is configured, without warnings', async () => {
  handler = async () => xml;
  const recs = await fetchEU();
  assert.equal(recs.length, 1001);
  assert.equal(recs.warnings, undefined);
  assert.match(calls[0], /token=dG9rZW4tMjAxNw/);
});

test('an operator token goes first; falling back to the public one warns', async () => {
  process.env.EU_FSF_TOKEN = 'mine';
  handler = async (u) => { if (u.includes('token=mine')) throw httpErr(403); return xml; };
  const recs = await fetchEU();
  assert.match(calls[0], /token=mine/);
  assert.equal(recs.warnings.length, 1);
  assert.doesNotMatch(recs.warnings[0], /token=mine/, 'tokens are redacted from warnings');
});

test('when every token is refused, the catalogue URL is used — on the Commission host only', async () => {
  const good = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=NEW';
  const evil = 'https://evil.example/xmlFullSanctionsList_1_1/content?token=x';
  handler = async (u) => {
    if (u.includes('data.europa.eu')) return JSON.stringify({ result: { distributions: [{ access_url: [evil, good] }] } });
    if (u === good) return xml;
    throw httpErr(401);
  };
  const recs = await fetchEU();
  assert.equal(recs.length, 1001);
  assert.ok(!calls.includes(evil), 'a URL off the Commission host is never fetched');
  assert.match(recs.warnings[0], /catalogue URL/);
});

test('an outage is not retried with another token — it is the carry-forward path', async () => {
  handler = async () => { throw httpErr(500); };
  await assert.rejects(fetchEU(), /HTTP 500/);
  assert.equal(calls.length, 1);
});

test('catalogueUrls finds FSF 1.1 URLs anywhere in the record and ignores other hosts', () => {
  const urls = catalogueUrls({ a: [{ b: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=T' }], c: 'http://webgate.ec.europa.eu/x/xmlFullSanctionsList_1_1', d: 'https://other.eu/xmlFullSanctionsList_1_1' });
  assert.deepEqual(urls, ['https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=T']);
});
