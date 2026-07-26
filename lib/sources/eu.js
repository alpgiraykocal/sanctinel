'use strict';

/*
 * EU Consolidated Financial Sanctions List → normalized records.
 * Source: EU FSD/FSF full XML (v1.1), discoverable via data.europa.eu.
 * NOTE the access token has NO base64 padding — the padded form 500s.
 *
 * Schema (attribute-driven):
 *   <sanctionEntity euReferenceNumber logicalId unitedNationId>
 *     <remark>, <regulation programme numberTitle publicationDate>,
 *     <subjectType code classificationCode>,
 *     <nameAlias wholeName firstName lastName function title strong>,
 *     <citizenship countryDescription>, <birthdate birthdate year city countryDescription>,
 *     <identification number identificationTypeDescription countryDescription>,
 *     <address street city zipCode countryDescription>, <contactInfo …>
 */

const { fetchText } = require('../fetch');
const { parse, child, children, text, descendants } = require('../xml');

const EU_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const A = (node, name) => clean(node.attrs[name] || '');

// person | enterprise | vessel → our display types
function mapType(node) {
  const st = child(node, 'subjectType');
  const code = st ? A(st, 'code').toLowerCase() : '';
  if (code === 'person') return 'Individual';
  if (code === 'vessel' || code === 'ship') return 'Vessel';
  if (code === 'aircraft') return 'Aircraft';
  return 'Entity';
}

function parseEntity(node) {
  const id = 'EU-' + (A(node, 'logicalId') || A(node, 'euReferenceNumber'));
  const aliases = children(node, 'nameAlias');
  const names = [];
  for (const a of aliases) {
    const whole = A(a, 'wholeName') || [A(a, 'firstName'), A(a, 'middleName'), A(a, 'lastName')].filter(Boolean).join(' ');
    if (!whole) continue;
    if (names.some((n) => n.name.toUpperCase() === whole.toUpperCase())) continue;
    names.push({
      name: whole,
      type: names.length === 0 ? 'Primary' : 'a.k.a.',
      primary: names.length === 0,
      // EU marks weak aliases with strong="false"
      lowQuality: A(a, 'strong').toLowerCase() === 'false',
      script: 'Latin', native: '', parts: [],
    });
  }
  if (!names.length) names.push({ name: `EU listing ${id}`, type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: '', parts: [] });

  const regs = children(node, 'regulation');
  const programs = [...new Set(regs.map((r) => A(r, 'programme')).filter(Boolean))];
  const legalAuthorities = [...new Set(regs.map((r) => {
    const t = A(r, 'numberTitle');
    return t ? `Council Regulation ${t}` : '';
  }).filter(Boolean))];

  const rec = {
    id, authority: 'EU', list: 'EU Consolidated List', type: mapType(node),
    name: names[0].name,
    title: clean(aliases.map((a) => A(a, 'function') || A(a, 'title')).find(Boolean) || ''),
    programs, sanctionsTypes: ['Asset freeze'],
    legalAuthorities: legalAuthorities.length ? legalAuthorities : ['EU Council Regulation'],
    datePublished: A(node, 'designationDate') || (regs[0] ? A(regs[0], 'publicationDate') : ''),
    names, addresses: [], idDocuments: [], relationships: [],
    attributes: [], identifiers: [],
    remarks: clean(text(node, 'remark')),
  };

  const euRef = A(node, 'euReferenceNumber');
  if (euRef) rec.attributes.push({ group: 'Program', label: 'EU reference', value: euRef });
  const unId = A(node, 'unitedNationId');
  if (unId) rec.attributes.push({ group: 'Program', label: 'UN reference', value: unId });

  for (const b of children(node, 'birthdate')) {
    const d = A(b, 'birthdate') || A(b, 'year');
    if (d) rec.attributes.push({ group: 'Identity', label: 'Date of Birth', value: (A(b, 'circa') === 'true' ? 'circa ' : '') + d });
    const pob = [A(b, 'city'), A(b, 'region'), A(b, 'countryDescription')].filter((x) => x && x !== 'UNKNOWN').join(', ');
    if (pob) rec.attributes.push({ group: 'Identity', label: 'Place of Birth', value: pob });
  }
  for (const c of children(node, 'citizenship')) {
    const v = A(c, 'countryDescription');
    if (v && v !== 'UNKNOWN') rec.attributes.push({ group: 'Identity', label: 'Citizenship', value: v });
  }
  for (const ad of children(node, 'address')) {
    const parts = [A(ad, 'street'), A(ad, 'poBox'), A(ad, 'city'), A(ad, 'zipCode'), A(ad, 'region'), A(ad, 'place')].filter(Boolean);
    const country = A(ad, 'countryDescription');
    if (country && country !== 'UNKNOWN') parts.push(country);
    if (parts.length) rec.addresses.push({ full: parts.join(', '), country: country === 'UNKNOWN' ? '' : country });
  }
  for (const idn of children(node, 'identification')) {
    const num = A(idn, 'number') || A(idn, 'latinNumber');
    if (!num) continue;
    const dtype = A(idn, 'identificationTypeDescription') || 'Document';
    const country = A(idn, 'countryDescription');
    rec.idDocuments.push({ type: dtype, number: num, issuingCountry: country === 'UNKNOWN' ? '' : country, issueDate: '', expirationDate: '' });
    const kind = /passport/i.test(dtype) ? 'Passport'
      : /national/i.test(dtype) ? 'National ID'
      : /imo/i.test(dtype) ? 'IMO'
      : /tax/i.test(dtype) ? 'Tax ID'
      : /registration/i.test(dtype) ? 'Registration' : dtype;
    rec.identifiers.push({ type: kind, value: num });
  }
  for (const ci of children(node, 'contactInfo')) {
    const v = A(ci, 'value');
    const k = A(ci, 'typeDescription') || 'Contact';
    if (!v) continue;
    rec.attributes.push({ group: 'Digital & Contact', label: k, value: v });
    if (/e-?mail/i.test(k)) rec.identifiers.push({ type: 'Email', value: v });
  }
  return rec;
}

// Slice per-<sanctionEntity> block and parse each on its own: the full document
// is ~24MB and a single tree would spike memory on small containers.
function parseXml(xml) {
  const out = [];
  const OPEN = '<sanctionEntity ', CLOSE = '</sanctionEntity>';
  let i = xml.indexOf(OPEN);
  while (i !== -1) {
    const end = xml.indexOf(CLOSE, i);
    if (end === -1) break;
    const root = parse(xml.slice(i, end + CLOSE.length));
    const node = root.children.find((c) => c.tag === 'sanctionEntity');
    if (node) out.push(parseEntity(node));
    i = xml.indexOf(OPEN, end + CLOSE.length);
  }
  return out;
}

async function fetchEU() {
  const xml = await fetchText(EU_URL, { timeout: 90000 });
  const recs = parseXml(xml);
  if (recs.length < 1000) throw new Error(`EU: only ${recs.length} records parsed`);
  return recs;
}

module.exports = { fetchEU, parseXml };
