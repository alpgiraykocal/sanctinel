'use strict';

/*
 * Ingestion for the OFAC Sanctions List Service (SLS).
 *
 * The SLS API has NO name-search endpoint. To screen a name you pull the full
 * list and match locally. This module downloads the classic OFAC flat files,
 * parses them into a COMPLETE structured record (names+alias types, addresses,
 * and every extractable identifier: DOB, POB, nationality, citizenship, gender,
 * passport, national/tax/registration IDs, IMO, MMSI, call sign, vessel + aircraft
 * data, digital-currency addresses, email, phone, website), and holds the result
 * as an IMMUTABLE snapshot pinned to a publication id.
 *
 * Poison-pill guard: refuse to promote a snapshot with too few entities; a
 * silently truncated parse (clean run, zero hits) is the worst screening failure.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { parseEntitiesXml } = require('./advanced');

const BASE = 'https://sanctionslistservice.ofac.treas.gov';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'snapshot.json');
const USER_AGENT = 'ofac-screening-demo/1.0 (compliance screening; contact: admin@example.com)';
const MIN_ENTITIES = 100;

const FILES = {
  sdn: { prim: 'SDN.CSV', alt: 'ALT.CSV', add: 'ADD.CSV' },
  cons: { prim: 'CONS_PRIM.CSV', alt: 'CONS_ALT.CSV', add: 'CONS_ADD.CSV' },
};

function httpGet(path, { json = false } = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, timeout: 30000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (json) { try { return resolve(JSON.parse(body)); } catch (e) { return reject(e); } }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout for ${url}`)));
    req.on('error', reject);
  });
}

function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const clean = (v) => { if (v == null) return ''; const t = v.trim(); return t === '-0-' ? '' : t; };

/*
 * Parse the free-text OFAC remarks blob into structured attributes + identifiers.
 * OFAC concatenates identifier segments separated by ';'. We recognize the common
 * labels and route the remainder to "Other".
 */
function parseRemarks(remarks) {
  const attributes = [];
  const identifiers = [];
  if (!remarks) return { attributes, identifiers };

  const push = (group, label, value) => value && attributes.push({ group, label, value });
  const pushId = (type, value) => value && identifiers.push({ type, value });

  for (let seg of remarks.split(';')) {
    seg = seg.trim();
    if (!seg) continue;
    let m;

    if ((m = seg.match(/^(?:alt\.?\s*)?DOB\s+(.+)/i))) { push('Identity', 'Date of Birth', m[1]); }
    else if ((m = seg.match(/^POB\s+(.+)/i))) { push('Identity', 'Place of Birth', m[1]); }
    else if ((m = seg.match(/^nationality\s+(.+)/i))) { push('Identity', 'Nationality', m[1]); }
    else if ((m = seg.match(/^citizen(?:ship)?\s+(.+)/i))) { push('Identity', 'Citizenship', m[1]); }
    else if ((m = seg.match(/^Gender\s+(.+)/i))) { push('Identity', 'Gender', m[1]); }
    else if ((m = seg.match(/^(Passport)\s+(.+)/i))) { push('Documents', 'Passport', m[2]); pushId('Passport', m[2].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^National\s+ID\s+(?:No\.?\s*)?(.+)/i))) { push('Documents', 'National ID', m[1]); pushId('National ID', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^(?:Cedula|C\.?I\.?)\s+(?:No\.?\s*)?(.+)/i))) { push('Documents', 'Cedula No.', m[1]); pushId('Cedula', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^Tax\s+ID\s+(?:No\.?\s*)?(.+)/i))) { push('Documents', 'Tax ID', m[1]); pushId('Tax ID', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^(?:Business\s+)?Registration\s+Number\s+(.+)/i))) { push('Documents', 'Registration No.', m[1]); pushId('Registration', m[1].split(/[\s(]/)[0]); }
    else if ((m = seg.match(/^IMO\s+(.+)/i))) { push('Vessel / Aircraft', 'IMO', m[1]); pushId('IMO', m[1]); }
    else if ((m = seg.match(/^MMSI\s+(.+)/i))) { push('Vessel / Aircraft', 'MMSI', m[1]); pushId('MMSI', m[1]); }
    else if ((m = seg.match(/^(?:Other\s+Vessel\s+)?Call\s+Sign\s+(.+)/i))) { push('Vessel / Aircraft', 'Call Sign', m[1]); pushId('Call Sign', m[1]); }
    else if ((m = seg.match(/^Aircraft\s+Tail\s+Number\s+(.+)/i))) { push('Vessel / Aircraft', 'Aircraft Tail No.', m[1]); pushId('Aircraft Tail', m[1]); }
    else if ((m = seg.match(/^Digital\s+Currency\s+Address\s*-\s*(\w+)\s+(.+)/i))) { push('Digital & Contact', `Digital Currency (${m[1]})`, m[2]); pushId(`Crypto ${m[1]}`, m[2]); }
    else if ((m = seg.match(/^Email\s+Address\s+(.+)/i))) { push('Digital & Contact', 'Email', m[1]); pushId('Email', m[1]); }
    else if ((m = seg.match(/^Phone\s+Number\s+(.+)/i))) { push('Digital & Contact', 'Phone', m[1]); pushId('Phone', m[1]); }
    else if ((m = seg.match(/^Website\s+(.+)/i))) { push('Digital & Contact', 'Website', m[1]); }
    else if ((m = seg.match(/^Secondary\s+sanctions\s+risk:?\s*(.+)/i))) { push('Program', 'Secondary Sanctions Risk', m[1]); }
    else if ((m = seg.match(/^(?:Organization\s+)?Established\s+Date\s+(.+)/i))) { push('Identity', 'Established Date', m[1]); }
    else if ((m = seg.match(/^Linked\s+To:?\s*(.+)/i))) { push('Program', 'Linked To', m[1]); }
    else push('Other', 'Remark', seg);
  }
  return { attributes, identifiers };
}

// SDN.CSV cols: 0 ent_num,1 name,2 type,3 program,4 title,5 call_sign,6 vess_type,
//               7 tonnage,8 grt,9 vess_flag,10 vess_owner,11 remarks
function buildIndex(primText, altText, addText, listLabel) {
  const byId = new Map();

  for (const r of parseCsv(primText)) {
    if (r.length < 4) continue;
    const id = clean(r[0]);
    if (!id || !/^\d+$/.test(id)) continue;

    const remarks = clean(r[11]);
    const { attributes, identifiers } = parseRemarks(remarks);

    // Dedicated vessel columns → attributes + identifiers.
    const vessel = [
      ['Call Sign', clean(r[5]), 'Call Sign'],
      ['Vessel Type', clean(r[6]), null],
      ['Tonnage', clean(r[7]), null],
      ['Gross Tonnage (GRT)', clean(r[8]), null],
      ['Vessel Flag', clean(r[9]), null],
      ['Vessel Owner', clean(r[10]), null],
    ];
    for (const [label, value, idType] of vessel) {
      if (value) { attributes.push({ group: 'Vessel / Aircraft', label, value }); if (idType) identifiers.push({ type: idType, value }); }
    }

    byId.set(id, {
      id,
      list: listLabel,
      name: clean(r[1]),
      type: clean(r[2]) || 'Individual',
      title: clean(r[4]),
      programs: clean(r[3]).split(/[;\/]/).map((s) => s.trim()).filter(Boolean),
      sanctionsTypes: [],
      sanctionsType: '',
      legalAuthorities: [],
      datePublished: '',
      names: [{ name: clean(r[1]), type: 'Primary', primary: true, lowQuality: false, script: 'Latin', native: '', parts: [] }],
      addresses: [],
      idDocuments: [],
      relationships: [],
      attributes,
      identifiers,
      remarks,
    });
  }

  // ALT.CSV cols: 0 ent_num,1 alt_num,2 alt_type,3 alt_name,4 alt_remarks
  for (const r of parseCsv(altText)) {
    if (r.length < 4) continue;
    const e = byId.get(clean(r[0]));
    if (!e) continue;
    const alt = clean(r[3]);
    if (!alt) continue;
    e.names.push({ name: alt, type: clean(r[2]) || 'A.K.A.', primary: false, lowQuality: /weak|low/i.test(clean(r[4])), script: 'Latin', native: '', parts: [] });
  }

  // ADD.CSV cols: 0 ent_num,1 add_num,2 address,3 city_state_zip,4 country,5 add_remarks
  for (const r of parseCsv(addText)) {
    if (r.length < 5) continue;
    const e = byId.get(clean(r[0]));
    if (!e) continue;
    const parts = [clean(r[2]), clean(r[3]), clean(r[4])].filter(Boolean);
    if (parts.length) e.addresses.push({ full: parts.join(', '), country: clean(r[4]) });
  }

  return [...byId.values()];
}

async function fetchListSet(set, label) {
  const [prim, alt, add] = await Promise.all([
    httpGet(`/api/download/${set.prim}`),
    httpGet(`/api/download/${set.alt}`),
    httpGet(`/api/download/${set.add}`),
  ]);
  return buildIndex(prim, alt, add, label);
}

async function fetchPublicationId() {
  try {
    const latest = await httpGet('/changes/latest');
    const m = latest.match(/publicationID["'>\s:]+(\d+)/i) || latest.match(/id="(\d+)"/i);
    return m ? m[1] : 'unknown';
  } catch { return 'unknown'; }
}

// Advanced path: the SLS /entities XML carries the FULL object model
// (typed names + scripts, every feature, id documents, relationships).
async function fetchEntitiesByList(listName) {
  const xml = await httpGet(`/entities?list=${encodeURIComponent(listName)}`);
  return parseEntitiesXml(xml, listName);
}

async function buildAdvancedSnapshot(publicationId) {
  const lists = await httpGet('/sanctions-lists', { json: true });
  // Sequential on purpose: fetching all lists in parallel holds every raw XML
  // in memory at once, which OOM-kills small containers (e.g. 512MB free tiers).
  const entities = [];
  for (const l of lists) {
    try {
      const batch = await fetchEntitiesByList(l);
      entities.push(...batch);
      if (global.gc) global.gc();
    } catch { /* skip failed list; poison-pill below guards totals */ }
  }
  if (entities.length < MIN_ENTITIES) {
    throw new Error(`poison-pill: only ${entities.length} entities parsed via advanced (floor ${MIN_ENTITIES}).`);
  }
  return finalizeSnapshot(entities, { source: 'OFAC SLS (advanced /entities)', publicationId, retrievedAt: new Date().toISOString() });
}

// Fallback path: classic flat files (name/alias/address + remarks-derived features).
async function buildFlatSnapshot(publicationId) {
  const [sdn, cons] = await Promise.all([
    fetchListSet(FILES.sdn, 'SDN List'),
    fetchListSet(FILES.cons, 'Consolidated List').catch(() => []),
  ]);
  const entities = [...sdn, ...cons];
  if (entities.length < MIN_ENTITIES) {
    throw new Error(`poison-pill: only ${entities.length} entities parsed via flat files (floor ${MIN_ENTITIES}).`);
  }
  return finalizeSnapshot(entities, { source: 'OFAC SLS (flat files)', publicationId, retrievedAt: new Date().toISOString() });
}

async function buildLiveSnapshot() {
  const publicationId = await fetchPublicationId();
  try {
    return await buildAdvancedSnapshot(publicationId);
  } catch (e) {
    console.warn(`Advanced snapshot failed (${e.message}). Falling back to flat files.`);
    return await buildFlatSnapshot(publicationId);
  }
}

// Relationships reference the related party by ID only. Resolve display names
// from the snapshot so both the record card and the graph show real names, and
// so distinct related entities are not collapsed into one placeholder node.
function resolveRelationshipNames(entities) {
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  for (const e of entities) {
    for (const rel of e.relationships || []) {
      if (rel.relatedName || !rel.relatedId) continue;
      const t = byId.get(String(rel.relatedId));
      rel.relatedName = t ? t.name : `Entity ${rel.relatedId} (unlisted)`;
      rel.inSnapshot = !!t;
    }
  }
}

function finalizeSnapshot(entities, meta) {
  resolveRelationshipNames(entities);
  const lists = [...new Set(entities.map((e) => e.list))].sort();
  const programs = [...new Set(entities.flatMap((e) => e.programs))].sort();
  return Object.freeze({ ...meta, entities, count: entities.length, lists, programs });
}

// Persist a parsed snapshot to disk so the server can boot instantly from cache
// instead of re-fetching + re-parsing ~20k entities (~2 min) on every start.
function writeCache(entities, meta) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ meta, entities }));
    return true;
  } catch (e) { console.warn('cache write failed:', e.message); return false; }
}

// Read the cached snapshot, or null. Returns { snapshot, ageMs }.
function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!raw.entities || !raw.entities.length) return null;
    const meta = raw.meta || {};
    const snapshot = finalizeSnapshot(raw.entities, {
      source: meta.source || 'OFAC SLS (cached)',
      publicationId: meta.publicationId || 'unknown',
      retrievedAt: meta.retrievedAt || new Date().toISOString(),
      isLive: meta.isLive !== false,
    });
    const ageMs = Date.now() - Date.parse(meta.retrievedAt || 0) || Infinity;
    return { snapshot, ageMs };
  } catch (e) { console.warn('cache read failed:', e.message); return null; }
}

module.exports = { buildLiveSnapshot, buildIndex, parseRemarks, finalizeSnapshot, parseCsv, writeCache, readCache, CACHE_PATH, MIN_ENTITIES };
