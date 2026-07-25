'use strict';

/*
 * UN Security Council Consolidated List → normalized records.
 * Source: https://scsanctions.un.org/resources/xml/en/consolidated.xml (302 → signed blob).
 * Schema: <CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL>… and <ENTITIES><ENTITY>…
 */

const { fetchText } = require('../fetch');
const { parse, child, children, text, descendants } = require('../xml');

const UN_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function nameParts(node) {
  return [text(node, 'FIRST_NAME'), text(node, 'SECOND_NAME'), text(node, 'THIRD_NAME'), text(node, 'FOURTH_NAME')]
    .map(clean).filter(Boolean).join(' ');
}

function baseRecord(node, type) {
  const id = 'UN-' + text(node, 'DATAID');
  const primary = clean(nameParts(node)) || `UN entity ${text(node, 'DATAID')}`;
  const programs = [text(node, 'UN_LIST_TYPE')].map(clean).filter(Boolean);
  const ref = text(node, 'REFERENCE_NUMBER');
  const rec = {
    id, authority: 'UN', list: 'UN Consolidated List', type,
    name: primary, title: '',
    programs, sanctionsTypes: ['Asset freeze'],
    legalAuthorities: ['UN Security Council Resolution'], datePublished: text(node, 'LISTED_ON'),
    names: [{ name: primary, type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: '', parts: [] }],
    addresses: [], idDocuments: [], relationships: [],
    attributes: [], identifiers: [],
    remarks: clean(text(node, 'COMMENTS1')),
  };
  if (ref) rec.attributes.push({ group: 'Program', label: 'UN reference', value: ref });
  const gender = clean(text(node, 'GENDER'));
  if (gender) rec.attributes.push({ group: 'Identity', label: 'Gender', value: gender });
  return rec;
}

function addAliases(rec, node, tag) {
  for (const a of children(node, tag)) {
    const nm = clean(text(a, 'ALIAS_NAME'));
    if (!nm) continue;
    const q = clean(text(a, 'QUALITY'));
    rec.names.push({ name: nm, type: 'a.k.a.', primary: false, lowQuality: /low|weak/i.test(q), script: 'Latin', native: '', parts: [] });
  }
}

function addAddresses(rec, node, tag) {
  for (const ad of children(node, tag)) {
    const parts = [text(ad, 'STREET'), text(ad, 'CITY'), text(ad, 'STATE_PROVINCE'), text(ad, 'COUNTRY'), text(ad, 'NOTE')].map(clean).filter(Boolean);
    if (parts.length) rec.addresses.push({ full: parts.join(', '), country: clean(text(ad, 'COUNTRY')) });
  }
}

function parseXml(xml) {
  const root = parse(xml);
  const out = [];

  for (const node of descendants(root, 'INDIVIDUAL')) {
    const rec = baseRecord(node, 'Individual');
    addAliases(rec, node, 'INDIVIDUAL_ALIAS');
    addAddresses(rec, node, 'INDIVIDUAL_ADDRESS');
    for (const n of children(node, 'NATIONALITY')) {
      const v = clean(text(n, 'VALUE'));
      if (v) rec.attributes.push({ group: 'Identity', label: 'Nationality', value: v });
    }
    for (const d of children(node, 'INDIVIDUAL_DATE_OF_BIRTH')) {
      const v = clean(text(d, 'DATE') || text(d, 'YEAR') || [text(d, 'FROM_YEAR'), text(d, 'TO_YEAR')].filter(Boolean).join('–'));
      if (v) rec.attributes.push({ group: 'Identity', label: 'Date of Birth', value: v });
    }
    for (const p of children(node, 'INDIVIDUAL_PLACE_OF_BIRTH')) {
      const v = [text(p, 'CITY'), text(p, 'STATE_PROVINCE'), text(p, 'COUNTRY')].map(clean).filter(Boolean).join(', ');
      if (v) rec.attributes.push({ group: 'Identity', label: 'Place of Birth', value: v });
    }
    for (const doc of children(node, 'INDIVIDUAL_DOCUMENT')) {
      const num = clean(text(doc, 'NUMBER'));
      const dtype = clean(text(doc, 'TYPE_OF_DOCUMENT')) || 'Document';
      if (num) {
        rec.idDocuments.push({ type: dtype, number: num, issuingCountry: clean(text(doc, 'ISSUING_COUNTRY')), issueDate: '', expirationDate: '' });
        rec.identifiers.push({ type: /passport/i.test(dtype) ? 'Passport' : dtype, value: num });
      }
    }
    out.push(rec);
  }

  for (const node of descendants(root, 'ENTITY')) {
    const rec = baseRecord(node, 'Entity');
    addAliases(rec, node, 'ENTITY_ALIAS');
    addAddresses(rec, node, 'ENTITY_ADDRESS');
    out.push(rec);
  }
  return out;
}

async function fetchUN() {
  const xml = await fetchText(UN_URL);
  const recs = parseXml(xml);
  if (recs.length < 200) throw new Error(`UN: only ${recs.length} records parsed`);
  return recs;
}

module.exports = { fetchUN, parseXml };
