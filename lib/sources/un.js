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
  // The name as written in its own script (379 listings, mostly Arabic) —
  // searchable once it is on the record as the primary name's native form.
  const original = clean(text(node, 'NAME_ORIGINAL_SCRIPT'));
  if (original && original !== primary) rec.names[0].native = original;
  const values = (tag) => { const n = child(node, tag); return n ? children(n, 'VALUE').map((v) => clean(v.text)).filter(Boolean) : []; };
  const titles = values('TITLE');
  if (titles.length) rec.title = titles[0];
  for (const t of titles) rec.attributes.push({ group: 'Identity', label: 'Title', value: t });
  for (const d of values('DESIGNATION')) rec.attributes.push({ group: 'Identity', label: 'Designation', value: d });
  const interpol = clean(text(node, 'INTERPOL_LINK'));
  if (interpol) rec.attributes.push({ group: 'Program', label: 'INTERPOL-UN notice', value: interpol });
  return rec;
}

function addAliases(rec, node, tag) {
  for (const a of children(node, tag)) {
    const nm = clean(text(a, 'ALIAS_NAME'));
    if (!nm) continue;
    // QUALITY is Good/Low for individuals and the alias type for entities
    // (a.k.a. / f.k.a.) — a former name is not a current one.
    const q = clean(text(a, 'QUALITY'));
    const type = /^f\.?k\.?a/i.test(q) ? 'f.k.a.' : 'a.k.a.';
    rec.names.push({ name: nm, type, primary: false, lowQuality: /low|weak/i.test(q), script: 'Latin', native: '', parts: [] });
  }
}

function addAddresses(rec, node, tag) {
  for (const ad of children(node, tag)) {
    const parts = [text(ad, 'STREET'), text(ad, 'CITY'), text(ad, 'STATE_PROVINCE'), text(ad, 'ZIP_CODE'), text(ad, 'COUNTRY')].map(clean).filter(Boolean);
    const note = clean(text(ad, 'NOTE'));
    if (parts.length) {
      const addr = { full: parts.join(', '), country: clean(text(ad, 'COUNTRY')) };
      if (note) addr.note = note;
      rec.addresses.push(addr);
    } else if (note) rec.addresses.push({ full: note, country: '' });
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
      let v = clean(text(d, 'DATE') || text(d, 'YEAR') || [text(d, 'FROM_YEAR'), text(d, 'TO_YEAR')].filter(Boolean).join('–'));
      // TYPE_OF_DATE APPROXIMATELY (117) used to read as an exact date.
      if (v && /^approx/i.test(clean(text(d, 'TYPE_OF_DATE')))) v = `circa ${v}`;
      const note = clean(text(d, 'NOTE'));
      if (v) rec.attributes.push(note ? { group: 'Identity', label: 'Date of Birth', value: v, note } : { group: 'Identity', label: 'Date of Birth', value: v });
    }
    for (const p of children(node, 'INDIVIDUAL_PLACE_OF_BIRTH')) {
      const v = [text(p, 'CITY'), text(p, 'STATE_PROVINCE'), text(p, 'COUNTRY')].map(clean).filter(Boolean).join(', ');
      if (v) rec.attributes.push({ group: 'Identity', label: 'Place of Birth', value: v });
    }
    for (const doc of children(node, 'INDIVIDUAL_DOCUMENT')) {
      const num = clean(text(doc, 'NUMBER'));
      const dtype = clean(text(doc, 'TYPE_OF_DOCUMENT')) || clean(text(doc, 'TYPE_OF_DOCUMENT2')) || 'Document';
      if (num) {
        const note = [clean(text(doc, 'TYPE_OF_DOCUMENT')) && clean(text(doc, 'TYPE_OF_DOCUMENT2')),
          clean(text(doc, 'CITY_OF_ISSUE')) && `issued in ${clean(text(doc, 'CITY_OF_ISSUE'))}`,
          clean(text(doc, 'NOTE'))].filter(Boolean).join('; ');
        const status = /^expired\b/i.test(clean(text(doc, 'NOTE'))) ? 'expired' : '';
        rec.idDocuments.push({
          type: dtype, number: num,
          issuingCountry: clean(text(doc, 'ISSUING_COUNTRY')) || clean(text(doc, 'COUNTRY_OF_ISSUE')),
          issueDate: clean(text(doc, 'DATE_OF_ISSUE')), expirationDate: clean(text(doc, 'DATE_OF_EXPIRY')),
          status, note,
        });
        const id = { type: /passport|pasaporte|passeport/i.test(dtype) ? 'Passport' : dtype, value: num };
        if (status) id.status = status;
        rec.identifiers.push(id);
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
