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
