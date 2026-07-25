'use strict';

/*
 * Parse the OFAC SLS advanced entity model (the /entities XML shape, which is
 * also the per-entity block of SDN_ADVANCED.XML / CONS_ADVANCED.XML) into the
 * normalized record used across this app.
 *
 * Goal: surface EVERYTHING OFAC publishes. Features are handled GENERICALLY —
 * any feature type, known or not, is captured (label + value + date range +
 * approximate flag) and grouped for display, so no OFAC field is silently
 * dropped. Names carry script + native-script text + alias type + low-quality.
 * Identity documents carry issuing country + issue/expiry dates. Relationships
 * carry ownership/linkage (needed for the 50 Percent Rule).
 */

const { parse, child, children, text, descendants } = require('./xml');

const bool = (v) => /^true$/i.test((v || '').trim());

// Map a feature/document label to a display group.
function groupFor(label) {
  const l = label.toLowerCase();
  if (/(birth|nationalit|citizen|gender|born|ethnic|title|position|established|dissolved)/.test(l)) return 'Identity';
  if (/(passport|\bid\b|identif|cedula|tax|registration|licen|ssn|d-u-n-s|duns|lei|vat|commercial|folio|rfc|cuit|rut|nie|dni)/.test(l)) return 'Documents';
  if (/(vessel|imo|mmsi|call sign|tonnage|flag|aircraft|tail|msn|manufacture|gross|hull)/.test(l)) return 'Vessel / Aircraft';
  if (/(digital currency|crypto|email|e-mail|phone|fax|website|web site|swift|bic|url)/.test(l)) return 'Digital & Contact';
  return 'Other';
}

// Does this feature value look like a screenable identifier?
function idTypeFor(label) {
  const l = label.toLowerCase();
  if (/passport/.test(l)) return 'Passport';
  if (/tax/.test(l)) return 'Tax ID';
  if (/cedula/.test(l)) return 'Cedula';
  if (/registration/.test(l)) return 'Registration';
  if (/national|\bid\b|identif|dni|nie|rfc|cuit|rut/.test(l)) return 'National ID';
  if (/imo/.test(l)) return 'IMO';
  if (/mmsi/.test(l)) return 'MMSI';
  if (/call sign/.test(l)) return 'Call Sign';
  if (/tail/.test(l)) return 'Aircraft Tail';
  if (/msn/.test(l)) return 'Aircraft MSN';
  if (/digital currency|crypto/.test(l)) return 'Crypto';
  if (/email|e-mail/.test(l)) return 'Email';
  if (/swift|bic/.test(l)) return 'SWIFT/BIC';
  if (/lei/.test(l)) return 'LEI';
  if (/vat/.test(l)) return 'VAT';
  return null;
}

function formatDateFeature(feature, value) {
  const vd = child(feature, 'valueDate');
  if (!vd) return value;
  const approx = bool(text(vd, 'isApproximate'));
  const range = bool(text(vd, 'isDateRange'));
  const fromB = text(vd, 'fromDateBegin');
  const toE = text(vd, 'toDateEnd');
  let out = value;
  if (!out) out = range ? `${fromB} to ${toE}` : fromB;
  if (approx) out = `approx. ${out}`;
  else if (range && value && fromB && `${fromB} to ${toE}` !== value) out = `${value} (range ${fromB}–${toE})`;
  return out;
}

// Parse one <name> block → normalized name entries (primary + native scripts).
function parseName(nameNode) {
  const isPrimary = bool(text(nameNode, 'isPrimary'));
  const aliasType = text(nameNode, 'aliasType') || (isPrimary ? 'Primary' : 'A.K.A.');
  const lowQuality = bool(text(nameNode, 'isLowQuality'));
  const translationsNode = child(nameNode, 'translations');
  const translations = translationsNode ? children(translationsNode, 'translation') : [];

  let display = '';
  let script = '';
  let native = '';
  const parts = [];
  for (const tr of translations) {
    const full = text(tr, 'formattedFullName')
      || [text(tr, 'formattedFirstName'), text(tr, 'formattedMiddleName'), text(tr, 'formattedLastName')].filter(Boolean).join(' ');
    const sc = text(tr, 'script');
    if (bool(text(tr, 'isPrimary')) || !display) { display = full; script = sc; }
    else if (sc && sc.toLowerCase() !== 'latin') native = full;
    const npNode = child(tr, 'nameParts');
    if (npNode) for (const np of children(npNode, 'namePart')) {
      const t = text(np, 'type'); const v = text(np, 'value');
      if (t && v) parts.push(`${t}: ${v}`);
    }
  }
  return { name: display, type: isPrimary ? 'Primary' : aliasType, primary: isPrimary, lowQuality, script, native, parts };
}

function parseAddress(addrNode) {
  const country = text(addrNode, 'country');
  const tNode = child(addrNode, 'translations');
  const parts = [];
  if (tNode) {
    for (const tr of children(tNode, 'translation')) {
      for (const key of ['address1', 'address2', 'address3', 'city', 'stateOrProvince', 'postalCode']) {
        const v = text(tr, key);
        if (v) parts.push(v);
      }
      const formatted = text(tr, 'formattedAddress');
      if (formatted && !parts.length) parts.push(formatted);
    }
  }
  if (country) parts.push(country);
  return { full: parts.filter(Boolean).join(', ') || country || '(address on file)', country };
}

// ID document blocks (several possible container/tag names across OFAC files).
function parseIdDocuments(entity) {
  const out = [];
  const containers = ['identityDocuments', 'idDocuments', 'idRegistrationDocuments', 'identificationDocuments'];
  const itemTags = ['identityDocument', 'idDocument', 'idRegistrationDocument', 'document'];
  for (const cName of containers) {
    const c = child(entity, cName);
    if (!c) continue;
    for (const it of itemTags.flatMap((t) => children(c, t))) {
      const type = text(it, 'type') || text(it, 'documentType') || 'Document';
      const number = text(it, 'documentNumber') || text(it, 'number') || text(it, 'idNumber');
      if (!type && !number) continue;
      out.push({
        type,
        number,
        issuingCountry: text(it, 'issuingCountry') || text(it, 'country'),
        issueDate: text(it, 'issueDate') || text(it, 'issuedDate'),
        expirationDate: text(it, 'expirationDate') || text(it, 'expiryDate'),
      });
    }
  }
  return out;
}

// Real schema: <relationship><type refId>Owned or Controlled By</type>
//              <relatedEntity entityId="54236" /></relationship>
// The related party is referenced by ID only — its name is resolved later from
// the snapshot (see resolveRelationshipNames in ingest.js).
function parseRelationships(entity) {
  const out = [];
  for (const cName of ['relationships', 'profileRelationships']) {
    const c = child(entity, cName);
    if (!c) continue;
    for (const rel of children(c, 'relationship').concat(children(c, 'profileRelationship'))) {
      const type = text(rel, 'type') || text(rel, 'relationshipType') || 'Related to';
      const re = child(rel, 'relatedEntity');
      const relatedId = re ? String(re.attrs.entityId || re.attrs.id || '') : String(rel.attrs.relatedId || '');
      if (!relatedId) continue;
      out.push({ type, relatedId, relatedName: '' });
    }
  }
  return out;
}

// Parse a single <entity> node → normalized record.
function parseEntity(entity, listFallback) {
  const gi = child(entity, 'generalInfo');
  const type = (gi && text(gi, 'entityType')) || text(entity, 'entityType') || 'Individual';

  const listNode = child(entity, 'sanctionsLists');
  const listEls = listNode ? children(listNode, 'sanctionsList') : [];
  const list = (listEls[0] && listEls[0].text.trim()) || listFallback || 'SDN List';
  const datePublished = (listEls[0] && listEls[0].attrs.datePublished) || '';

  const progNode = child(entity, 'sanctionsPrograms');
  const programs = progNode ? children(progNode, 'sanctionsProgram').map((p) => p.text.trim()).filter(Boolean) : [];

  const stNode = child(entity, 'sanctionsTypes');
  const sanctionsTypes = stNode ? children(stNode, 'sanctionsType').map((p) => p.text.trim()).filter(Boolean) : [];

  const laNode = child(entity, 'legalAuthorities');
  const legalAuthorities = laNode ? children(laNode, 'legalAuthority').map((p) => p.text.trim()).filter(Boolean) : [];

  const namesNode = child(entity, 'names');
  const names = namesNode ? children(namesNode, 'name').map(parseName).filter((n) => n.name) : [];
  const primary = names.find((n) => n.primary) || names[0] || { name: `Entity ${entity.attrs.id}` };

  const addrNode = child(entity, 'addresses');
  const addresses = addrNode ? children(addrNode, 'address').map(parseAddress) : [];

  const idDocuments = parseIdDocuments(entity);
  const relationships = parseRelationships(entity);

  // Features → generic attributes + identifiers.
  const attributes = [];
  const identifiers = [];
  const featNode = child(entity, 'features');
  if (featNode) {
    for (const f of children(featNode, 'feature')) {
      const label = text(f, 'type') || 'Feature';
      let value = text(f, 'value');
      value = formatDateFeature(f, value);
      const cur = text(f, 'valueRefId') ? value : value;
      if (!cur && !value) continue;
      attributes.push({ group: groupFor(label), label, value: cur || value });
      const idt = idTypeFor(label);
      if (idt && (cur || value)) identifiers.push({ type: idt, value: (cur || value).replace(/^approx\.\s*/, '') });
    }
  }

  // ID documents → identifiers too (screen the full surface).
  for (const d of idDocuments) {
    if (d.number) identifiers.push({ type: d.type || 'Document', value: d.number });
  }

  // Title from features already captured; keep a top-level convenience.
  const title = attributes.find((a) => /title|position/i.test(a.label))?.value || '';

  return {
    id: entity.attrs.id || '',
    list,
    type,
    name: primary.name,
    title,
    programs,
    sanctionsTypes,
    sanctionsType: sanctionsTypes[0] || '',
    legalAuthorities,
    datePublished,
    names,
    addresses,
    idDocuments,
    relationships,
    attributes,
    identifiers,
    remarks: '',
  };
}

// Parse a full <entities> document → record[].
function parseEntitiesXml(xmlText, listFallback) {
  const root = parse(xmlText);
  const entityNodes = descendants(root, 'entity');
  return entityNodes.map((e) => parseEntity(e, listFallback));
}

module.exports = { parseEntitiesXml, parseEntity, groupFor, idTypeFor };
