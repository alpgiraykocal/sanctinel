'use strict';

// Fields the feeds publish that the parsers used to drop, found by
// scripts/source-inventory.js against the live feeds. Fixtures mirror the
// shapes that inventory printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntitiesXml } = require('../lib/advanced');
const eu = require('../lib/sources/eu');
const un = require('../lib/sources/un');
const uk = require('../lib/sources/uk');
const { normalizeRecord, splitIdentifiers, scriptOf, expiredOn } = require('../lib/normalize');
const { parseDateValue } = require('../lib/dates');
const { identifierKind, isRefuted } = require('../lib/vocab');
const { matchIdentifier } = require('../lib/matcher');

const ofacEntity = (inner) => `<entities><entity id="9"><generalInfo><entityType>Entity</entityType><remarks>Linked To: ACME.</remarks><title>Director</title></generalInfo><names><name><isPrimary>true</isPrimary><translations><translation><isPrimary>true</isPrimary><formattedFullName>ACME</formattedFullName></translation></translations></name></names>${inner}</entity></entities>`;

test('OFAC: document dates, validity and issuing authority are read', () => {
  const [e] = parseEntitiesXml(ofacEntity(`<identityDocuments><identityDocument>
    <type>Identification Number</type><documentNumber>7701234567</documentNumber><isValid>false</isValid>
    <issuingAuthority>INN</issuingAuthority><issuingCountry>Russia</issuingCountry>
    <issueDate id="1"><fromDateBegin>2011-02-14</fromDateBegin><toDateEnd>2011-02-14</toDateEnd><isDateRange>false</isDateRange></issueDate>
    <expirationDate id="2"><fromDateBegin>2021-02-14</fromDateBegin><toDateEnd>2021-02-14</toDateEnd></expirationDate>
  </identityDocument></identityDocuments>`));
  assert.deepEqual(e.idDocuments, [{
    type: 'Identification Number', number: '7701234567', issuingCountry: 'Russia',
    issueDate: '2011-02-14', expirationDate: '2021-02-14', status: 'invalid', note: 'issuing authority: INN',
  }]);
  assert.deepEqual(e.identifiers, [{ type: 'Identification Number (INN)', value: '7701234567', status: 'invalid' }]);
  assert.equal(identifierKind(e.identifiers[0].type), 'tax_id');
  assert.equal(e.remarks, 'Linked To: ACME.');
  assert.equal(e.title, 'Director');
});

test('OFAC: a feature marked False is kept, annotated, and is not evidence or an identifier', () => {
  const [e] = parseEntitiesXml(ofacEntity(`<features>
    <feature><type>Birthdate</type><value>1970</value><reliability>False</reliability></feature>
    <feature><type>Email Address</type><value>x@acme.ru</value><reliability>False</reliability></feature>
    <feature><type>Website</type><value>acme.ru</value><reliability>Reported</reliability><comments>old site</comments></feature>
  </features><relationships><relationship><type>Owned or Controlled By</type><relatedEntity entityId="77">PARENT CO</relatedEntity></relationship></relationships>`));
  const dob = e.attributes.find((a) => a.label === 'Birthdate');
  assert.ok(isRefuted(dob));
  assert.equal(dob.note, 'marked false by OFAC');
  assert.equal(e.attributes.find((a) => a.label === 'Website').note, 'reported, not confirmed; old site');
  assert.ok(!e.identifiers.some((i) => i.value === 'x@acme.ru'));
  assert.equal(e.relationships[0].relatedName, 'PARENT CO');
});

test('EU: contacts inside addresses, gender, functions, document flags and birth-date forms', () => {
  const [e] = eu.parseXml(`<export><sanctionEntity designationDetails="Date of UN designation: 1 November 2005." unitedNationId="" euReferenceNumber="EU.1.1" logicalId="11">
    <remark>first</remark><remark>second</remark>
    <regulation programme="TAQA" numberTitle="881/2002 (OJ L139)"><publicationUrl>http://eur-lex.europa.eu/x</publicationUrl></regulation>
    <subjectType code="person"/>
    <nameAlias wholeName="John Doe" gender="M" function="Leader" title="Mullah"/><nameAlias wholeName="Jon Doe" function="Financier"/>
    <birthdate calendarType="ISLAMIC" year="1343"/>
    <birthdate yearRangeFrom="1953" yearRangeTo="1958" calendarType="GREGORIAN"><remark>between 1953 and 1958</remark></birthdate>
    <address city="Kabul" countryDescription="AFGHANISTAN" asAtListingTime="true"><contactInfo key="EMAIL" value="a@b.com"/><contactInfo key="PHONE" value="+93 1"/></address>
    <identification number="7701" identificationTypeCode="other" identificationTypeDescription="Other identification number" knownExpired="true" issueDate="2000-07-17" validTo="2010-01-01"><remark>INN</remark></identification>
    <identification number="P1" identificationTypeCode="passport" identificationTypeDescription="National passport" knownFalse="true"/>
  </sanctionEntity></export>`);
  const attr = (label) => e.attributes.filter((a) => a.label === label).map((a) => a.value);
  assert.deepEqual(attr('Gender'), ['Male']);
  assert.deepEqual(attr('Function'), ['Leader', 'Financier']);
  assert.deepEqual(attr('Email address'), ['a@b.com']);
  assert.deepEqual(attr('Phone number'), ['+93 1']);
  assert.deepEqual(attr('Official Journal'), ['http://eur-lex.europa.eu/x']);
  assert.deepEqual(attr('Date of Birth'), ['1343 (Islamic calendar)', '1953 to 1958']);
  assert.equal(parseDateValue('1343 (Islamic calendar)'), null);
  assert.equal(e.addresses[0].note, 'at the time of listing');
  assert.equal(e.remarks, 'first second');
  assert.deepEqual(e.idDocuments.map((d) => [d.issueDate, d.expirationDate, d.status]), [['2000-07-17', '2010-01-01', 'expired'], ['', '', 'false']]);
  assert.deepEqual(e.identifiers.map((i) => [i.type, i.status]), [['Email', undefined], ['Other identification number (INN)', 'expired'], ['Passport', 'false']]);
});

test('UN: original-script name, titles, designations, approximate dates and document details', () => {
  const [e] = un.parseXml(`<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>SADDAM</FIRST_NAME><SECOND_NAME>HUSSEIN</SECOND_NAME>
    <REFERENCE_NUMBER>IQi.001</REFERENCE_NUMBER><NAME_ORIGINAL_SCRIPT>صدام حسين</NAME_ORIGINAL_SCRIPT>
    <TITLE><VALUE>Haji</VALUE></TITLE><DESIGNATION><VALUE>President</VALUE></DESIGNATION><INTERPOL_LINK>https://www.interpol.int/x</INTERPOL_LINK>
    <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>APPROXIMATELY</TYPE_OF_DATE><YEAR>1937</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
    <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>A123</NUMBER><DATE_OF_ISSUE>2013-06-11</DATE_OF_ISSUE><DATE_OF_EXPIRY>2018-06-10</DATE_OF_EXPIRY><NOTE>Expired 28 Nov. 2016</NOTE></INDIVIDUAL_DOCUMENT>
  </INDIVIDUAL></INDIVIDUALS><ENTITIES><ENTITY><DATAID>2</DATAID><FIRST_NAME>X CORP</FIRST_NAME><ENTITY_ALIAS><QUALITY>f.k.a.</QUALITY><ALIAS_NAME>Y CORP</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES></CONSOLIDATED_LIST>`);
  assert.equal(e.names[0].native, 'صدام حسين');
  assert.equal(e.title, 'Haji');
  assert.ok(e.attributes.some((a) => a.label === 'Designation' && a.value === 'President'));
  assert.ok(e.attributes.some((a) => a.label === 'INTERPOL-UN notice'));
  assert.ok(e.attributes.some((a) => a.label === 'Date of Birth' && a.value === 'circa 1937'));
  assert.deepEqual([e.idDocuments[0].issueDate, e.idDocuments[0].expirationDate, e.idDocuments[0].status], ['2013-06-11', '2018-06-10', 'expired']);
  const [ent] = un.parseXml(`<CONSOLIDATED_LIST><ENTITIES><ENTITY><DATAID>2</DATAID><FIRST_NAME>X CORP</FIRST_NAME><ENTITY_ALIAS><QUALITY>f.k.a.</QUALITY><ALIAS_NAME>Y CORP</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES></CONSOLIDATED_LIST>`);
  assert.equal(ent.names[1].type, 'f.k.a.');
});

test('UK: passports and national IDs become documents with OFSI\'s description', () => {
  const [e] = uk.parseCsvText('Last Updated,01/01/2020\nName 6,Name 1,Group ID,Group Type,Alias Type,Passport Number,Passport Details,National Identification Number,National Identification Details\nDOE,John,1,Individual,Primary name,P123,Libya. Expired,(1) 11 (2) 22,(1) Tunisia (2) Egypt\n');
  assert.deepEqual(e.idDocuments.map((d) => [d.type, d.number, d.status, d.note]), [
    ['Passport', 'P123', 'expired', 'Libya. Expired'],
    ['National ID', '(1) 11 (2) 22', '', '(1) Tunisia (2) Egypt'],
  ]);
});

test('numbered multi-value identifiers split into one identifier each', () => {
  assert.deepEqual(splitIdentifiers([
    { type: 'Business Registration Number', value: '(1) BvD ID: IR30193GN (2) ISN Number: IRO1AZAB0006' },
    { type: 'Passport', value: '(1) MM611523 (2) EE947317' },
    { type: 'National ID No.', value: 'K357514(4)' },
    { type: 'Business Registration Number', value: '(1) Kazakhstan BIN - 170440031562' },
  ]), [
    { type: 'Business Registration Number (BvD ID)', value: 'IR30193GN' },
    { type: 'Business Registration Number (ISN Number)', value: 'IRO1AZAB0006' },
    { type: 'Passport', value: 'MM611523' },
    { type: 'Passport', value: 'EE947317' },
    { type: 'National ID No.', value: 'K357514(4)' },
    { type: 'Business Registration Number (Kazakhstan BIN)', value: '170440031562' },
  ]);
  const rec = normalizeRecord({ id: 'UK-1', authority: 'UK', name: 'X', names: [{ name: 'X', primary: true }], identifiers: [{ type: 'Passport', value: '(1) MM611523 (2) EE947317' }], attributes: [], addresses: [] });
  assert.ok(matchIdentifier('EE947317', rec));
});

test('names are labelled with the script they are written in', () => {
  assert.equal(scriptOf('ГУСЕВ Денис'), 'Cyrillic');
  assert.equal(scriptOf('صدام'), 'Arabic');
  assert.equal(scriptOf('金正恩'), 'Chinese');
  assert.equal(scriptOf('ACME'), '');
  const e = normalizeRecord({ id: '1', authority: 'EU', name: 'Х', names: [{ name: 'ПАО Газпром', primary: true, script: 'Latin' }], attributes: [], addresses: [], identifiers: [] });
  assert.equal(e.names[0].script, 'Cyrillic');
});

test('a lapsed BIS denial order is marked expired; a live one is left alone', () => {
  const dpl = (end) => ({
    id: 'BIS-1', authority: 'BIS', list: 'BIS Denied Persons List', lists: ['BIS Denied Persons List'], type: 'Listed party',
    name: 'X', names: [{ name: 'X', primary: true }], sanctionsTypes: ['Denial of export privileges'],
    attributes: [{ group: 'Program', label: 'End date', value: end }], addresses: [], identifiers: [],
  });
  const old = normalizeRecord(normalizeRecord(dpl('2006-03-21'), '2026-10-15'), '2026-10-15');
  assert.equal(expiredOn(old), '2006-03-21');
  assert.deepEqual(old.sanctionsTypes, ['Denial of export privileges (expired 2006-03-21)']);
  assert.equal(old.attributes.filter((a) => a.label === 'Denial order status').length, 1);
  const live = normalizeRecord(dpl('2030-07-16'), '2026-10-15');
  assert.equal(expiredOn(live), '');
  assert.deepEqual(live.sanctionsTypes, ['Denial of export privileges']);
});

test('an identifier match on a document the source marks invalid says so', () => {
  const m = matchIdentifier('7701234567', { identifiers: [{ type: 'Identification Number (INN)', value: '7701234567', status: 'invalid' }] });
  assert.equal(m.score, 1);
  assert.match(m.explain, /document invalid per the source/);
});

test('insights report data quality, and count lapsed denials as one restriction', () => {
  const { finalizeSnapshot } = require('../lib/ingest');
  const { snapshotStats } = require('../lib/stats');
  const base = { list: 'BIS Denied Persons List', lists: ['BIS Denied Persons List'], authority: 'BIS', type: 'Listed party', programs: [], legalAuthorities: [], addresses: [], identifiers: [], relationships: [] };
  const dpl = (id, end) => Object.assign({}, base, {
    id, name: `PARTY ${id}`, names: [{ name: `PARTY ${id}`, primary: true }], sanctionsTypes: ['Denial of export privileges'],
    attributes: [{ group: 'Program', label: 'End date', value: end }], idDocuments: [],
  });
  const ofac = {
    id: '9', authority: 'OFAC', list: 'SDN List', lists: ['SDN List'], type: 'Individual', name: 'X', names: [{ name: 'X', primary: true }],
    programs: [], sanctionsTypes: ['Block'], legalAuthorities: [], addresses: [], identifiers: [], relationships: [],
    attributes: [{ group: 'Identity', label: 'Birthdate', value: '1970', status: 'false', note: 'marked false by OFAC' }],
    idDocuments: [{ type: 'Passport', number: 'A1', issuingCountry: '', issueDate: '2001-01-01', expirationDate: '', status: 'invalid', note: '' }],
  };
  const snap = finalizeSnapshot([dpl('BIS-1', '2001-01-01'), dpl('BIS-2', '2002-02-02'), dpl('BIS-3', '2099-01-01'), ofac], {
    publicationId: 't', isLive: true, sources: [{ label: 'X', authorities: ['OFAC'], ok: true, count: 1 }],
  });
  const s = snapshotStats(snap);
  const measures = Object.fromEntries(s.byMeasure.map((m) => [m.name, m.count]));
  assert.equal(measures['Denial of export privileges (expired)'], 2);
  assert.equal(measures['Denial of export privileges'], 1);
  const dq = s.dataQuality;
  assert.equal(dq.annotations.BIS.lapsedDenials, 2);
  assert.equal(dq.annotations.OFAC.refutedValues, 1);
  assert.deepEqual(dq.annotations.OFAC.documentStatus, { invalid: 1 });
  assert.equal(dq.annotations.OFAC.documentsDated, 1);
  assert.equal(dq.sources[0].ok, true);
  assert.ok(dq.fields.authorities.BIS && dq.fields.derived);
});
