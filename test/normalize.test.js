'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRecord, isoDate, tidyName, splitUkOtherInformation } = require('../lib/normalize');
const { parseEntity } = require('../lib/advanced');
const { parse } = require('../lib/xml');
const { countryCodes } = require('../lib/countries');
const { build } = require('../lib/crosslist');
const quality = require('../lib/quality');

const rec = (over = {}) => Object.assign({
  id: '1', authority: 'OFAC', list: 'SDN List', type: 'Entity', name: 'ACME', title: '', programs: [],
  sanctionsTypes: [], legalAuthorities: [], datePublished: '', remarks: '',
  names: [{ name: 'ACME', type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: '', parts: [] }],
  addresses: [], idDocuments: [], relationships: [], attributes: [], identifiers: [],
}, over);

test('listing dates become ISO; day-first for UK, month-first for U.S. sources', () => {
  assert.equal(isoDate('24/06/2008', 'UK'), '2008-06-24');
  assert.equal(isoDate('03/04/2020', 'UK'), '2020-04-03');
  assert.equal(isoDate('8/11/2015', 'BIS'), '2015-08-11');
  assert.equal(isoDate('25/12/2019', 'BIS'), '2019-12-25'); // only readable one way
  assert.equal(isoDate('2015-03-27-04:00', 'UN'), '2015-03-27');
  assert.equal(isoDate('2015-03-27T00:00:00Z', 'UN'), '2015-03-27');
  assert.equal(isoDate('2015-03-27', 'EU'), '2015-03-27');
  assert.equal(isoDate('sometime in 2015', 'EU'), 'sometime in 2015');
  assert.equal(isoDate('', 'UK'), '');
});

test('names lose formatting debris but keep what is part of the name', () => {
  assert.equal(tidyName('Sinno Electronics Co., Ltd.,'), 'Sinno Electronics Co., Ltd.');
  assert.equal(tidyName('-CJSC VAD'), 'CJSC VAD');
  assert.equal(tidyName('. ПАО АНК “Башнефть”'), 'ПАО АНК “Башнефть”');
  assert.equal(tidyName('ACME HOLDING CO. LTD.'), 'ACME HOLDING CO. LTD.');
  assert.equal(tidyName('JOINT  STOCK COMPANY'), 'JOINT STOCK COMPANY');
  assert.equal(tidyName('‫بابک  زنجانی‬'), 'بابک زنجانی');
});

test('exact repeats are removed; the primary survives and keeps a repeat\'s native form', () => {
  const e = normalizeRecord(rec({
    names: [
      { name: 'Acme', type: 'a.k.a.', primary: false, native: 'АКМЕ' },
      { name: 'ACME', type: 'Primary', primary: true, native: '' },
      { name: 'ACME TRADING', type: 'a.k.a.', primary: false, native: '' },
      { name: 'Acme  Trading', type: 'a.k.a.', primary: false, native: '' },
    ],
    addresses: [{ full: 'Colombia', country: 'Colombia' }, { full: 'Colombia', country: 'Colombia' }, { full: 'Calle 1, Cali, Colombia', country: 'Colombia' }],
    attributes: [{ group: 'Identity', label: 'Place of Birth', value: 'TUNISIA' }, { group: 'Identity', label: 'Place of Birth', value: 'TUNISIA' }, { group: 'Identity', label: 'Nationality', value: 'na' }],
    identifiers: [{ type: 'IMO', value: 'IMO  8730455' }, { type: 'IMO', value: 'IMO 8730455' }, { type: 'Passport', value: '  ' }],
  }));
  assert.deepEqual(e.names.map((n) => n.name), ['ACME', 'ACME TRADING']);
  assert.equal(e.names[0].native, 'АКМЕ');
  assert.equal(e.addresses.length, 2);
  assert.deepEqual(e.attributes.map((a) => a.value), ['TUNISIA']);
  assert.deepEqual(e.identifiers, [{ type: 'IMO', value: 'IMO 8730455' }]);
});

test('OFSI "Other Information" becomes fields, identifiers and a shorter remark', () => {
  const e = normalizeRecord(rec({
    authority: 'UK', id: 'UK-1', datePublished: '24/06/2008',
    remarks: '(UK Sanctions List Ref):INU0308. (UK Statement of Reasons):Provides financial services. (Phone number):+44 20 7600 3636 (Email address):info@example.com (Business Reg No):4152338 (UN Ref):QDi.241. Distinguishing marks include scars. (2022): “being leaders”',
  }));
  const attr = Object.fromEntries(e.attributes.map((a) => [a.label, a.value]));
  assert.equal(attr['UK Sanctions List Ref'], 'INU0308');
  assert.equal(attr['UK Statement of Reasons'], 'Provides financial services.');
  assert.equal(attr['Business Reg No'], '4152338');
  assert.equal(attr['UN Ref'], 'QDi.241');
  assert.deepEqual(e.identifiers, [
    { type: 'Email', value: 'info@example.com' },
    { type: 'Business Registration Number', value: '4152338' },
  ]);
  // Prose stays prose — including a "(2022):" that is a quotation, not a field.
  assert.equal(e.remarks, 'Distinguishing marks include scars. (2022): “being leaders”');
  assert.equal(e.datePublished, '2008-06-24');
  assert.equal(splitUkOtherInformation('No labelled fields here.'), null);
});

test('normalizing is idempotent', () => {
  const make = () => rec({
    authority: 'UK', datePublished: '24/06/2008', name: 'ACME ,',
    remarks: '(UK Sanctions List Ref):INU1. (IMO number):9187629. (Gender):Male',
    names: [{ name: 'ACME ,', type: 'Primary', primary: true, native: '' }, { name: 'acme', type: 'AKA', primary: false, native: '' }],
    addresses: [{ full: 'Iran', country: 'Iran' }, { full: 'Iran', country: 'Iran' }],
  });
  const once = normalizeRecord(make());
  const twice = normalizeRecord(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.deepEqual(once.identifiers, [{ type: 'IMO', value: '9187629' }]);
});

test('a CSL "Listed party" with a legal form is an entity; a personal name stays unclassified', () => {
  assert.equal(normalizeRecord(rec({ authority: 'BIS', type: 'Listed party', name: 'Sinno Electronics Co., Ltd.,' })).type, 'Entity');
  assert.equal(normalizeRecord(rec({ authority: 'BIS', type: 'Listed party', name: 'Sovtest-Servis OOO' })).type, 'Entity');
  assert.equal(normalizeRecord(rec({ authority: 'State', type: 'Listed party', name: 'Juan Lopez-Hernandez', names: [{ name: 'Juan Lopez-Hernandez', primary: true }] })).type, 'Listed party');
  assert.equal(normalizeRecord(rec({ authority: 'OFAC', type: 'Individual', name: 'BANK OF X' })).type, 'Individual');
});

test('OFAC addresses keep street, city and postcode from typed address parts', () => {
  const entity = (addresses) => parse(`<entity id="1"><names><name><isPrimary>true</isPrimary><translations><translation><isPrimary>true</isPrimary><formattedFullName>X</formattedFullName></translation></translations></name></names><addresses>${addresses}</addresses></entity>`).children[0];
  const typed = '<address><country>Iran</country><translations><translation><isPrimary>true</isPrimary><addressParts>'
    + '<addressPart><type>CITY</type><value>Tehran</value></addressPart>'
    + '<addressPart><type>ADDRESS1</type><value>Ferdowsi Avenue</value></addressPart>'
    + '<addressPart><type>POSTAL CODE</type><value>11365</value></addressPart>'
    + '</addressParts></translation></translations></address>';
  const flat = '<address><country>Cuba</country><translations><translation><address1>Calle 1</address1><city>Havana</city></translation></translations></address>';
  const regionOnly = '<address><translations><translation><addressParts><addressPart><type>REGION</type><value>Northern Mali</value></addressPart></addressParts></translation></translations></address>';
  const countryOnly = '<address><country>Syria</country></address>';
  assert.deepEqual(parseEntity(entity(typed + flat + regionOnly + countryOnly)).addresses, [
    { full: 'Ferdowsi Avenue, Tehran, 11365, Iran', country: 'Iran' },
    { full: 'Calle 1, Havana, Cuba', country: 'Cuba' },
    { full: 'Northern Mali', country: '' },
    { full: 'Syria', country: 'Syria' },
  ]);
});

test('country values the feeds publish resolve, and multi-country fields split only when every part resolves', () => {
  assert.deepEqual(countryCodes('Estonia, Russia'), ['EE', 'RU']);
  assert.deepEqual(countryCodes('Germany. Russia'), ['DE', 'RU']);
  assert.deepEqual(countryCodes('Korea, North'), ['KP']);
  assert.deepEqual(countryCodes('Congo, Republic of the'), ['CG']);
  for (const [raw, code] of [['German', 'DE'], ['British', 'GB'], ['Belrus', 'BY'], ['PRC', 'CN'], ['crimea (occupied)', 'UA'], ['Region: Gaza', 'PS'], ['Curacao', 'CW']]) {
    assert.deepEqual(countryCodes(raw), [code], raw);
  }
  assert.deepEqual(countryCodes('na'), []);
});

test('a shared UN reference links the listings that implement it, behind the name gate', () => {
  // Distinctiveness comes from corpus rarity; a large empty corpus makes every
  // name token rare, so only the reference and the name gate decide.
  require('../lib/matcher').setCorpus(new Map(), 32000);
  const unRec = (id, authority, name, label, ref) => normalizeRecord(rec({
    id, authority, type: 'Entity', name, names: [{ name, primary: true }],
    attributes: label ? [{ group: 'Program', label, value: ref }] : [],
  }));
  const entities = [
    unRec('UN-1', 'UN', 'SHAHID HEMMAT INDUSTRIAL GROUP', 'UN reference', 'IRe.040'),
    normalizeRecord(rec({ id: 'UK-1', authority: 'UK', type: 'Entity', name: 'SHAHID HEMMAT INDUSTRIAL GROUP (SHIG)', names: [{ name: 'SHAHID HEMMAT INDUSTRIAL GROUP (SHIG)', primary: true }], remarks: '(UN Ref):IRE.040. Subordinate of AIO.' })),
    // Same reference, nothing distinctive in common: not linked.
    unRec('EU-9', 'EU', 'Totally Different Company', 'UN reference', 'IRe.040'),
  ];
  const { rootOf, groups } = build(entities);
  assert.ok(rootOf.has('UN-1') && rootOf.get('UN-1') === rootOf.get('UK-1'));
  assert.equal(groups.get(rootOf.get('UN-1')).basis, 'identifier');
  assert.ok(!rootOf.has('EU-9') || rootOf.get('EU-9') !== rootOf.get('UN-1'));
});

test('the quality profile measures address detail and ISO listing dates', () => {
  const p = quality.profile({ entities: [
    rec({ id: 'a', datePublished: '2020-01-02', addresses: [{ full: 'Iran', country: 'Iran' }, { full: 'Street 1, Tehran, Iran', country: 'Iran' }] }),
    rec({ id: 'b', datePublished: '02/01/2020', addresses: [{ full: '(address on file)', country: '' }] }),
  ] });
  assert.equal(p.authorities.OFAC.addressDetailRate, 1 / 3);
  assert.equal(p.derived.datePublishedIsoRate, 0.5);
  const r = quality.compare(p, null);
  assert.ok(r.findings.some((f) => f.metric === 'datePublishedIsoRate'));
});
