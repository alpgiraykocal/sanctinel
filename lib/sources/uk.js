'use strict';

/*
 * UK OFSI Consolidated List (asset-freeze targets) → normalized records.
 * Source CSV: https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv
 * The CSV has one row per name-variant; rows are grouped by the "Group" column
 * (one designation = one entity with aliases/addresses spread across rows).
 */

const { fetchText } = require('../fetch');
const { parseCsv } = require('../csv');

const UK_URL = 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv';
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function joinName(row, col) {
  return [1, 2, 3, 4, 5, 6].map((n) => clean(row[col('Name ' + n)])).filter(Boolean).join(' ');
}

function parseCsvText(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 3) throw new Error('UK: CSV too short');
  // Row 0 is "Last Updated,<date>"; row 1 is the header.
  const header = rows[1].map((h) => clean(h));
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const col = (name) => (idx[name] != null ? idx[name] : -1);
  const get = (row, name) => { const i = col(name); return i >= 0 ? clean(row[i]) : ''; };

  const groups = new Map();
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const g = get(row, 'Group ID');
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  }

  const out = [];
  for (const [g, grp] of groups) {
    const primaryRow = grp.find((row) => /^primary name$/i.test(get(row, 'Alias Type'))) || grp[0];
    const name = joinName(primaryRow, col) || `UK group ${g}`;
    const groupType = get(primaryRow, 'Group Type') || 'Entity';
    const programs = [...new Set(grp.map((row) => get(row, 'Regime')).filter(Boolean))];

    const rec = {
      id: 'UK-' + g, authority: 'UK', list: 'UK Sanctions List',
      type: /individual/i.test(groupType) ? 'Individual' : (/ship|vessel/i.test(groupType) ? 'Vessel' : 'Entity'),
      title: get(primaryRow, 'Title'),
      programs, sanctionsTypes: ['Asset freeze'],
      legalAuthorities: ['UK Sanctions and Anti-Money Laundering Act 2018'],
      datePublished: get(primaryRow, 'Listed On') || get(primaryRow, 'UK Sanctions List Date Designated'),
      name,
      names: [{ name, type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: get(primaryRow, 'Name Non-Latin Script'), parts: [] }],
      addresses: [], idDocuments: [], relationships: [], attributes: [], identifiers: [],
      remarks: get(primaryRow, 'Other Information'),
    };

    const seenNames = new Set([name.toUpperCase()]);
    const seenAddr = new Set(), seenId = new Set(), seenAttr = new Set();
    for (const row of grp) {
      const nm = joinName(row, col);
      if (nm && !seenNames.has(nm.toUpperCase())) {
        seenNames.add(nm.toUpperCase());
        rec.names.push({ name: nm, type: get(row, 'Alias Type') || 'a.k.a.', primary: false, lowQuality: /weak|low|good \(low\)/i.test(get(row, 'Alias Quality')), script: 'Latin', native: get(row, 'Name Non-Latin Script'), parts: [] });
      }
      const addr = [1, 2, 3, 4, 5, 6].map((n) => get(row, 'Address ' + n)).concat([get(row, 'Post/Zip Code'), get(row, 'Country')]).filter(Boolean).join(', ');
      if (addr && !seenAddr.has(addr)) { seenAddr.add(addr); rec.addresses.push({ full: addr, country: get(row, 'Country') }); }
      const push = (label, group, value) => { if (value && !seenAttr.has(label + value)) { seenAttr.add(label + value); rec.attributes.push({ group, label, value }); } };
      push('Date of Birth', 'Identity', get(row, 'DOB'));
      push('Place of Birth', 'Identity', [get(row, 'Town of Birth'), get(row, 'Country of Birth')].filter(Boolean).join(', '));
      push('Nationality', 'Identity', get(row, 'Nationality'));
      push('Position', 'Identity', get(row, 'Position'));
      const passport = get(row, 'Passport Number');
      if (passport && !seenId.has('P' + passport)) { seenId.add('P' + passport); rec.identifiers.push({ type: 'Passport', value: passport }); rec.attributes.push({ group: 'Documents', label: 'Passport', value: passport }); }
      const natId = get(row, 'National Identification Number');
      if (natId && !seenId.has('N' + natId)) { seenId.add('N' + natId); rec.identifiers.push({ type: 'National ID', value: natId }); rec.attributes.push({ group: 'Documents', label: 'National ID', value: natId }); }
    }
    out.push(rec);
  }
  return out;
}

async function fetchUK() {
  const csv = await fetchText(UK_URL);
  const recs = parseCsvText(csv);
  if (recs.length < 200) throw new Error(`UK: only ${recs.length} records parsed`);
  return recs;
}

module.exports = { fetchUK, parseCsvText };
