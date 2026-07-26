'use strict';

/*
 * U.S. export-control restricted-party lists → normalized records.
 * Source: trade.gov Consolidated Screening List (public, no API key).
 *
 * We take ONLY the export-control lists from the CSL:
 *   BIS   — Entity List, Denied Persons List, Unverified List, Military End User
 *   State — ITAR Debarred (DDTC), Nonproliferation Sanctions (ISN)
 * The CSL's Treasury/OFAC entries are skipped: we already ingest those straight
 * from OFAC's own SLS with far richer detail (aliases, IDs, relationships).
 *
 * IMPORTANT compliance distinction: these are EXPORT-CONTROL restrictions, not
 * financial sanctions. The obligation is a licence requirement / denial of
 * export privileges — NOT an asset freeze. Records carry the licence
 * requirement + policy text so the UI can say exactly that.
 */

const { fetchText } = require('../fetch');

const CSL_URL = 'https://api.trade.gov/static/consolidated_screening_list/consolidated.json';

// CSL `source` string → { authority, list }
const SOURCE_MAP = {
  'Entity List (EL) - Bureau of Industry and Security': { authority: 'BIS', list: 'BIS Entity List' },
  'Denied Persons List (DPL) - Bureau of Industry and Security': { authority: 'BIS', list: 'BIS Denied Persons List' },
  'Unverified List (UVL) - Bureau of Industry and Security': { authority: 'BIS', list: 'BIS Unverified List' },
  'Military End User (MEU) List - Bureau of Industry and Security': { authority: 'BIS', list: 'BIS Military End-User List' },
  'ITAR Debarred (DTC) - State Department': { authority: 'State', list: 'ITAR Debarred List' },
  'Nonproliferation Sanctions (ISN) - State Department': { authority: 'State', list: 'Nonproliferation Sanctions' },
};

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function looksLikeVessel(r) {
  return !!(clean(r.vessel_type) || clean(r.call_sign) || clean(r.vessel_flag));
}

// The CSL carries no person/entity flag for these lists. Only claim a type when
// the data actually supports it — otherwise say "Listed party" rather than
// mislabelling an individual as a company.
function inferType(r) {
  if (looksLikeVessel(r)) return 'Vessel';
  if ((r.dates_of_birth || []).length || (r.places_of_birth || []).length || (r.nationalities || []).length || (r.citizenships || []).length) return 'Individual';
  return 'Listed party';
}

function mapRecord(r, i) {
  const m = SOURCE_MAP[r.source];
  if (!m) return null;
  const name = clean(r.name);
  if (!name) return null;

  const id = `${m.authority}-${r.id ? String(r.id).slice(0, 12) : 'x' + i}`;
  const rec = {
    id, authority: m.authority, list: m.list, type: inferType(r),
    name, title: clean(r.title),
    programs: (r.programs || []).map(clean).filter(Boolean),
    // Export control: the restriction is a licence requirement, not a freeze.
    sanctionsTypes: [m.authority === 'BIS' && /Denied Persons/.test(m.list) ? 'Denial of export privileges' : 'Export licence requirement'],
    legalAuthorities: m.authority === 'BIS' ? ['Export Administration Regulations (EAR)'] : ['Arms Export Control Act / ITAR'],
    datePublished: clean(r.start_date),
    names: [{ name, type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: '', parts: [] }],
    addresses: [], idDocuments: [], relationships: [],
    attributes: [], identifiers: [],
    remarks: clean(r.remarks),
  };

  for (const alt of r.alt_names || []) {
    const a = clean(alt);
    if (a && a.toUpperCase() !== name.toUpperCase()) {
      rec.names.push({ name: a, type: 'a.k.a.', primary: false, lowQuality: false, script: 'Latin', native: '', parts: [] });
    }
  }

  for (const ad of r.addresses || []) {
    const parts = [clean(ad.address), clean(ad.city), clean(ad.state), clean(ad.postal_code), clean(ad.country)].filter(Boolean);
    if (parts.length) rec.addresses.push({ full: parts.join(', '), country: clean(ad.country) });
  }

  const push = (group, label, value) => { const v = clean(value); if (v) rec.attributes.push({ group, label, value: v }); };
  for (const d of r.dates_of_birth || []) push('Identity', 'Date of Birth', d);
  for (const p of r.places_of_birth || []) push('Identity', 'Place of Birth', p);
  for (const n of r.nationalities || []) push('Identity', 'Nationality', n);
  for (const c of r.citizenships || []) push('Identity', 'Citizenship', c);

  // Export-control specifics — the operative restriction for these lists.
  push('Program', 'Licence requirement', r.license_requirement);
  push('Program', 'Licence policy', r.license_policy);
  push('Program', 'Federal Register notice', r.federal_register_notice);
  if (clean(r.standard_order)) push('Program', 'Standard order', clean(r.standard_order) === 'Y' ? 'Yes' : clean(r.standard_order));
  if (clean(r.end_date)) push('Program', 'End date', r.end_date);
  push('Vessel / Aircraft', 'Vessel Type', r.vessel_type);
  push('Vessel / Aircraft', 'Call Sign', r.call_sign);
  push('Vessel / Aircraft', 'Vessel Flag', r.vessel_flag);
  if (clean(r.call_sign)) rec.identifiers.push({ type: 'Call Sign', value: clean(r.call_sign) });

  for (const idn of r.ids || []) {
    const num = clean(idn.number);
    if (!num) continue;
    const t = clean(idn.type) || 'Document';
    rec.idDocuments.push({ type: t, number: num, issuingCountry: clean(idn.country), issueDate: '', expirationDate: '' });
    rec.identifiers.push({ type: /passport/i.test(t) ? 'Passport' : t, value: num });
  }

  return rec;
}

function parseJson(text) {
  const j = JSON.parse(text);
  const out = [];
  (j.results || []).forEach((r, i) => { const rec = mapRecord(r, i); if (rec) out.push(rec); });
  return out;
}

async function fetchCSL() {
  const text = await fetchText(CSL_URL, { timeout: 90000 });
  const recs = parseJson(text);
  if (recs.length < 2000) throw new Error(`CSL: only ${recs.length} export-control records parsed`);
  return recs;
}

module.exports = { fetchCSL, parseJson, SOURCE_MAP };
