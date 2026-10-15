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

/*
 * Where the file comes from, in order.
 *
 * The token in the URL is not a credential of ours: it is a general token the
 * Commission prints in its own public download links, the same for everyone,
 * and nothing stops it being rotated. The FSF manual's intended route is a
 * token tied to a registered EU Login account. So:
 *
 *   1. EU_FSF_TOKEN, when the operator has registered one (a repository
 *      secret for the nightly build);
 *   2. the public token;
 *   3. if both are refused (401/403), whatever 1.1 XML URL the dataset's own
 *      record on data.europa.eu currently lists — the catalogue the
 *      Commission keeps for exactly this — restricted to the Commission's
 *      host, so a tampered catalogue cannot point the build anywhere else.
 *
 * Any route but the first that works is reported as a warning, which ends the
 * nightly build red: the data is fine, but the next rotation will not be.
 */
const EU_BASE = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content';
const PUBLIC_TOKEN = 'dG9rZW4tMjAxNw';
const EU_URL = `${EU_BASE}?token=${PUBLIC_TOKEN}`;
const CATALOG_URL = 'https://data.europa.eu/api/hub/search/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions';
const FSF_HOST = 'webgate.ec.europa.eu';

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

  // Every function and title the aliases carry: a listing often names
  // several roles across its language versions, and only the first used to
  // survive (as the record title).
  const functions = [...new Set(aliases.map((a) => A(a, 'function')).filter(Boolean))];
  const titles = [...new Set(aliases.map((a) => A(a, 'title')).filter(Boolean))];
  const genderCode = aliases.map((a) => A(a, 'gender').toUpperCase()).find((g) => g === 'M' || g === 'F');
  const remarkTexts = (n) => children(n, 'remark').map((r) => clean(r.text)).filter(Boolean);

  const rec = {
    id, authority: 'EU', list: 'EU Consolidated List', type: mapType(node),
    name: names[0].name,
    title: functions[0] || titles[0] || '',
    programs, sanctionsTypes: ['Asset freeze'],
    legalAuthorities: legalAuthorities.length ? legalAuthorities : ['EU Council Regulation'],
    datePublished: A(node, 'designationDate') || (regs[0] ? A(regs[0], 'publicationDate') : ''),
    names, addresses: [], idDocuments: [], relationships: [],
    attributes: [], identifiers: [],
    // Every entity-level remark, not only the first.
    remarks: remarkTexts(node).join(' '),
  };

  const euRef = A(node, 'euReferenceNumber');
  if (euRef) rec.attributes.push({ group: 'Program', label: 'EU reference', value: euRef });
  const unId = A(node, 'unitedNationId');
  if (unId) rec.attributes.push({ group: 'Program', label: 'UN reference', value: unId });
  const details = A(node, 'designationDetails');
  if (details) rec.attributes.push({ group: 'Program', label: 'Designation details', value: details });
  for (const r of regs) {
    const url = clean(text(r, 'publicationUrl'));
    if (url) rec.attributes.push({ group: 'Program', label: 'Official Journal', value: url });
  }
  if (genderCode) rec.attributes.push({ group: 'Identity', label: 'Gender', value: genderCode === 'M' ? 'Male' : 'Female' });
  for (const f of functions) rec.attributes.push({ group: 'Identity', label: 'Function', value: f });
  for (const t of titles) rec.attributes.push({ group: 'Identity', label: 'Title', value: t });

  const withNote = (attr, notes) => { const n = notes.filter(Boolean).join('; '); if (n) attr.note = n; return attr; };

  for (const b of children(node, 'birthdate')) {
    /*
     * The most precise form the listing gives: a full date, else year and
     * month, else the year, else the year range (55 values that used to be
     * dropped outright). A Hijri date is labelled as one rather than read as
     * a Gregorian year — "1343" is 1924/25, not 1343.
     */
    const month = Number(A(b, 'monthOfYear'));
    let d = A(b, 'birthdate')
      || (A(b, 'year') && month >= 1 && month <= 12 ? `${A(b, 'year')}-${String(month).padStart(2, '0')}` : A(b, 'year'));
    if (!d && A(b, 'yearRangeFrom')) d = A(b, 'yearRangeTo') ? `${A(b, 'yearRangeFrom')} to ${A(b, 'yearRangeTo')}` : A(b, 'yearRangeFrom');
    if (d) {
      if (/islamic/i.test(A(b, 'calendarType'))) d += ' (Islamic calendar)';
      rec.attributes.push(withNote({ group: 'Identity', label: 'Date of Birth', value: (A(b, 'circa') === 'true' ? 'circa ' : '') + d }, remarkTexts(b)));
    }
    const pob = [A(b, 'place'), A(b, 'city'), A(b, 'region'), A(b, 'countryDescription')].filter((x) => x && x !== 'UNKNOWN').join(', ');
    if (pob) rec.attributes.push({ group: 'Identity', label: 'Place of Birth', value: pob });
  }
  for (const c of children(node, 'citizenship')) {
    const v = A(c, 'countryDescription');
    if (v && v !== 'UNKNOWN') rec.attributes.push(withNote({ group: 'Identity', label: 'Citizenship', value: v }, remarkTexts(c)));
  }

  // Contact details sit INSIDE <address> in this schema (1,685 of them); the
  // entity-level read found none. Both places are read.
  const CONTACT = { WEB: 'Website', PHONE: 'Phone number', EMAIL: 'Email address', FAX: 'Fax' };
  const addContacts = (n) => {
    for (const ci of children(n, 'contactInfo')) {
      const v = A(ci, 'value');
      if (!v) continue;
      const key = A(ci, 'key').toUpperCase();
      const label = CONTACT[key] || A(ci, 'typeDescription') || 'Contact';
      rec.attributes.push({ group: 'Digital & Contact', label, value: v });
      if (key === 'EMAIL' || /e-?mail/i.test(label)) rec.identifiers.push({ type: 'Email', value: v });
    }
  };
  addContacts(node);
  for (const ad of children(node, 'address')) {
    const parts = [A(ad, 'street'), A(ad, 'poBox'), A(ad, 'city'), A(ad, 'zipCode'), A(ad, 'region'), A(ad, 'place')].filter(Boolean);
    const country = A(ad, 'countryDescription');
    if (country && country !== 'UNKNOWN') parts.push(country);
    const note = [A(ad, 'asAtListingTime') === 'true' ? 'at the time of listing' : '', ...remarkTexts(ad)].filter(Boolean).join('; ');
    if (parts.length) {
      const addr = { full: parts.join(', '), country: country === 'UNKNOWN' ? '' : country };
      if (note) addr.note = note;
      rec.addresses.push(addr);
    }
    addContacts(ad);
  }

  for (const idn of children(node, 'identification')) {
    const num = A(idn, 'number') || A(idn, 'latinNumber');
    if (!num) continue;
    const dtype = A(idn, 'identificationTypeDescription') || 'Document';
    const country = A(idn, 'countryDescription');
    const remarks = remarkTexts(idn);
    /*
     * The EU's own flags on the document. knownFalse is a forged or false
     * document; revoked and expired ones were valid once. All still belong to
     * the listed person — they are often what the person travels on.
     */
    const status = A(idn, 'knownFalse') === 'true' ? 'false'
      : A(idn, 'revokedByIssuer') === 'true' ? 'revoked'
        : A(idn, 'reportedLost') === 'true' ? 'reported lost'
          : A(idn, 'knownExpired') === 'true' ? 'expired' : '';
    const note = [
      A(idn, 'issuedBy') && `issued by ${A(idn, 'issuedBy')}`,
      A(idn, 'region') && `issued in ${A(idn, 'region')}`,
      A(idn, 'validFrom') && `valid from ${A(idn, 'validFrom')}`,
      A(idn, 'diplomatic') === 'true' && 'diplomatic',
      A(idn, 'nameOnDocument'),
      ...remarks,
    ].filter(Boolean).join('; ');
    rec.idDocuments.push({
      type: dtype, number: num, issuingCountry: country === 'UNKNOWN' ? '' : country,
      issueDate: A(idn, 'issueDate') || A(idn, 'issuedDate'), expirationDate: A(idn, 'validTo'),
      status, note,
    });
    // "Other identification number" (616) says nothing about what the number
    // is; a short remark on it usually does ("INN", "OGRN", "IMO number").
    const detail = /^other/i.test(A(idn, 'identificationTypeCode')) && remarks[0] && remarks[0].length <= 30 ? remarks[0] : '';
    const kind = /passport/i.test(dtype) ? 'Passport'
      : /national/i.test(dtype) ? 'National ID'
      : /imo/i.test(dtype) ? 'IMO'
      : /tax/i.test(dtype) ? 'Tax ID'
      : /registration/i.test(dtype) ? 'Registration' : (detail ? `${dtype} (${detail})` : dtype);
    const id = { type: kind, value: num };
    if (status) id.status = status;
    rec.identifiers.push(id);
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

const isAuthFailure = (e) => !!e && (e.statusCode === 401 || e.statusCode === 403);
const redact = (u) => String(u).replace(/token=[^&]+/, 'token=…');

// Every FSF 1.1 XML URL anywhere in the catalogue record, on the Commission's
// host only. Shape-agnostic on purpose: the record's JSON layout is the
// catalogue's business and has changed before.
function catalogueUrls(record) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!/xmlFullSanctionsList_1_1/.test(v)) return;
      try {
        const u = new URL(v);
        if (u.protocol === 'https:' && u.hostname === FSF_HOST) found.add(u.toString());
      } catch { /* not a URL */ }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(record);
  return [...found];
}

async function fetchEU() {
  const routes = [];
  if (process.env.EU_FSF_TOKEN) routes.push({ label: 'EU_FSF_TOKEN', url: `${EU_BASE}?token=${encodeURIComponent(process.env.EU_FSF_TOKEN)}` });
  routes.push({ label: 'public token', url: EU_URL });

  const failures = [];
  let xml = null, used = null;
  for (const r of routes) {
    try { xml = await fetchText(r.url, { timeout: 90000 }); used = r; break; } catch (e) {
      failures.push(`${r.label}: ${redact(e.message)}`);
      if (!isAuthFailure(e)) throw e; // an outage is not fixed by another token
    }
  }
  if (!xml) {
    let urls = [];
    try { urls = catalogueUrls(JSON.parse(await fetchText(CATALOG_URL, { timeout: 30000 }))); } catch (e) {
      failures.push(`catalogue: ${e.message}`);
    }
    for (const u of urls.filter((x) => !routes.some((r) => r.url === x))) {
      try { xml = await fetchText(u, { timeout: 90000 }); used = { label: 'catalogue URL', url: u }; break; } catch (e) {
        failures.push(`catalogue URL: ${redact(e.message)}`);
      }
    }
  }
  if (!xml) {
    const err = new Error(`EU: every route refused — ${failures.join('; ')}`);
    err.statusCode = 401;
    throw err;
  }

  const recs = parseXml(xml);
  if (recs.length < 1000) throw new Error(`EU: only ${recs.length} records parsed`);
  if (used !== routes[0]) {
    recs.warnings = [`EU list fetched via ${used.label} (${redact(used.url)}) after: ${failures.join('; ')}. ` +
      'Register an FSF token and set EU_FSF_TOKEN, or update the URL in lib/sources/eu.js.'];
  }
  return recs;
}

module.exports = { fetchEU, parseXml, catalogueUrls };
