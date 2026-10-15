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
const { labelCanBeIdentifier } = require('./vocab');

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
  // A label that names a concept — nationality, place of birth, a programme
  // note — cannot carry an identifier no matter which substring it contains.
  // Without this gate "Nationality Country" matched /national/ below and filed
  // 5,821 country names as national ID numbers, each one exactly matchable.
  if (!labelCanBeIdentifier(label)) return null;
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

/*
 * One <address> → { full, country }.
 *
 * OFAC's entity model publishes the lines of an address as typed parts:
 *
 *   <address><country>Iran</country><translations><translation>
 *     <addressParts>
 *       <addressPart><type>ADDRESS1</type><value>Ferdowsi Avenue</value></addressPart>
 *       <addressPart><type>CITY</type><value>Tehran</value></addressPart>
 *     </addressParts>
 *   </translation></translations></address>
 *
 * This used to look for <address1>, <city> … directly under <translation>,
 * which that shape never has, so every OFAC address came through as its
 * country alone — 22,190 of them — and 3,378 with no country came through as
 * "(address on file)". Street, city, region and postcode were dropped for all
 * 19,818 OFAC parties. Both shapes are read now, typed parts first, in postal
 * order; anything else under the translation that carries text is kept rather
 * than lost, so a further change in the feed degrades to an unordered address
 * instead of an empty one.
 */
const ADDRESS_PART_ORDER = ['ADDRESS1', 'ADDRESS2', 'ADDRESS3', 'CITY', 'STATE/PROVINCE', 'STATE', 'PROVINCE', 'REGION', 'POSTAL CODE', 'POSTALCODE', 'ZIP'];
const ADDRESS_FLAT_KEYS = ['address1', 'address2', 'address3', 'city', 'stateOrProvince', 'region', 'postalCode'];
const ADDRESS_SKIP = new Set(['isPrimary', 'script', 'addressParts', 'formattedAddress', 'country']);

function addressLines(tr) {
  const partsNode = child(tr, 'addressParts');
  if (partsNode) {
    const typed = children(partsNode, 'addressPart')
      .map((p) => ({ type: (text(p, 'type') || '').toUpperCase(), value: text(p, 'value') }))
      .filter((p) => p.value);
    if (typed.length) {
      const rank = (t) => { const i = ADDRESS_PART_ORDER.indexOf(t); return i === -1 ? ADDRESS_PART_ORDER.length : i; };
      return typed.map((p, i) => ({ ...p, i })).sort((a, b) => rank(a.type) - rank(b.type) || a.i - b.i).map((p) => p.value);
    }
  }
  const flat = ADDRESS_FLAT_KEYS.map((k) => text(tr, k)).filter(Boolean);
  if (flat.length) return flat;
  const formatted = text(tr, 'formattedAddress');
  if (formatted) return [formatted];
  // Unknown shape: keep whatever leaf text there is, in document order.
  return (tr.children || [])
    .filter((c) => c.tag && !ADDRESS_SKIP.has(c.tag) && !(c.children || []).some((g) => g.tag))
    .map((c) => (c.text || '').trim())
    .filter(Boolean);
}

function parseAddress(addrNode) {
  const country = text(addrNode, 'country');
  const tNode = child(addrNode, 'translations');
  const translations = tNode ? children(tNode, 'translation') : [];
  // The primary (Latin) translation when there is one; otherwise the first.
  const tr = translations.find((t) => bool(text(t, 'isPrimary'))) || translations[0];
  const lines = tr ? addressLines(tr) : [];
  const parts = [...new Set(lines)];
  if (country && !parts.some((p) => p.toUpperCase() === country.toUpperCase())) parts.push(country);
  return { full: parts.filter(Boolean).join(', ') || country || '(address on file)', country };
}

/*
 * A date element as OFAC publishes it: either plain text, or — for document
 * dates — a structure whose bounds are child elements:
 *
 *   <expirationDate><fromDateBegin>2023-09-26</fromDateBegin>…</expirationDate>
 *
 * Reading the element's own text returned '' for every one of those, so 502
 * issue dates and 1,225 expiry dates never reached a record.
 */
function dateOf(node, ...tags) {
  for (const tag of tags) {
    const c = child(node, tag);
    if (!c) continue;
    const direct = c.text.trim();
    if (direct) return direct;
    const from = text(c, 'fromDateBegin'), to = text(c, 'toDateEnd');
    if (from && to && from !== to && bool(text(c, 'isDateRange'))) return `${from} to ${to}`;
    if (from) return from;
  }
  return '';
}

// Document types too generic to say what the number is ("Identification
// Number", "Registration ID"). For these, OFAC's issuing authority or comment
// ("INN", "OGRN", "IMO Number") is the actual type.
const GENERIC_DOC_TYPE = /^(identification number|registration (id|number)|other|document|id number)$/i;

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
      const authority = text(it, 'issuingAuthority');
      const comments = text(it, 'comments');
      const location = text(it, 'issuingLocation');
      // isValid=false on 340 OFAC documents: OFAC's own statement that the
      // document is not a valid one (cancelled, fraudulent, superseded).
      const invalid = /^false$/i.test(text(it, 'isValid'));
      const expired = /\bexpired\b/i.test(comments);
      out.push({
        type,
        number,
        issuingCountry: text(it, 'issuingCountry') || text(it, 'country'),
        issueDate: dateOf(it, 'issueDate', 'issuedDate'),
        expirationDate: dateOf(it, 'expirationDate', 'expiryDate'),
        status: invalid ? 'invalid' : expired ? 'expired' : '',
        note: [authority && `issuing authority: ${authority}`, location && `issued in ${location}`, comments].filter(Boolean).join('; '),
        // Not part of the stored shape; consumed below for the identifier type.
        _detail: authority || (comments && comments.length <= 40 ? comments : ''),
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
      // OFAC names the related party inline; the snapshot's own record is
      // preferred when present (resolveRelationshipNames), this when it is not.
      out.push({ type, relatedId, relatedName: re ? re.text.trim() : '' });
    }
  }
  return out;
}

// Parse a single <entity> node → normalized record.
function parseEntity(entity, listFallback) {
  const gi = child(entity, 'generalInfo');
  const type = (gi && text(gi, 'entityType')) || text(entity, 'entityType') || 'Individual';

  /*
   * An entity belongs to EVERY <sanctionsList> under it, not just the first.
   * OFAC publishes the umbrella "Consolidated List" alongside the specific one:
   *
   *   <sanctionsList ...>Consolidated List</sanctionsList>
   *   <sanctionsList ...>Non-SDN CMIC List</sanctionsList>
   *
   * Keeping only listEls[0] threw the specific membership away, and that is the
   * field that decides which prohibition applies — CMIC restricts securities
   * transactions, CAPTA restricts correspondent accounts, NS-PLC drives
   * rejection rather than blocking. It also made the list filter lie: 1 of 68
   * CMIC entities and 2 of 78 NS-PLC entities were reachable through it.
   *
   * `list` stays as the most specific membership (the umbrella is the least
   * informative label) so existing single-list consumers keep working.
   */
  const listNode = child(entity, 'sanctionsLists');
  const listEls = listNode ? children(listNode, 'sanctionsList') : [];
  const lists = [...new Set(listEls.map((el) => el.text.trim()).filter(Boolean))];
  if (!lists.length && (listFallback || 'SDN List')) lists.push(listFallback || 'SDN List');
  const specific = lists.filter((l) => l !== 'Consolidated List');
  const list = specific[0] || lists[0];
  // Date of the listing we are labelling with, not whichever came first.
  const dateEl = listEls.find((el) => el.text.trim() === list) || listEls[0];
  const datePublished = (dateEl && dateEl.attrs.datePublished) || '';

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
      const value = formatDateFeature(f, text(f, 'value'));
      if (!value) continue;
      /*
       * OFAC grades a feature Confirmed, Reported or False. Reported (752) is
       * said so on the record; False (20) is kept as published but marked, so
       * nothing downstream treats it as evidence — see lib/vocab isRefuted.
       */
      const reliability = text(f, 'reliability');
      const comments = text(f, 'comments');
      const isFalse = /^false$/i.test(reliability);
      const note = [isFalse ? 'marked false by OFAC' : /^reported$/i.test(reliability) ? 'reported, not confirmed' : '', comments].filter(Boolean).join('; ');
      const attr = { group: groupFor(label), label, value };
      if (note) attr.note = note;
      if (isFalse) attr.status = 'false';
      attributes.push(attr);
      const idt = idTypeFor(label);
      if (idt && !isFalse) identifiers.push({ type: idt, value: value.replace(/^approx\.\s*/, '') });
    }
  }

  // ID documents → identifiers too (screen the full surface). A generic type
  // takes its specific name from the issuing authority or comment, and a
  // document OFAC marks invalid carries that into the match explanation.
  for (const d of idDocuments) {
    const detail = d._detail;
    delete d._detail;
    if (!d.number) continue;
    const type = d.type || 'Document';
    const id = { type: detail && GENERIC_DOC_TYPE.test(type) ? `${type} (${detail})` : type, value: d.number };
    if (d.status) id.status = d.status;
    identifiers.push(id);
  }

  // Title from features already captured; keep a top-level convenience.
  const title = attributes.find((a) => /title|position/i.test(a.label))?.value
    || (gi && text(gi, 'title')) || '';
  // OFAC's free-text remarks ("Linked To: …", "(Prior to …)") sit under
  // generalInfo in the entity model. Read where present; every OFAC record used
  // to come through with remarks: ''.
  const remarks = (gi && text(gi, 'remarks')) || text(entity, 'remarks') || '';

  return {
    id: entity.attrs.id || '',
    list,
    lists,
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
    remarks,
  };
}

// Parse a full <entities> document → record[].
//
// Memory note: parsing the whole multi-MB document into one tree spikes memory
// ~5-10x the XML size, which OOM-kills small containers (512MB). Instead we
// slice the raw string into per-<entity> blocks and parse each tiny block on
// its own, so peak memory ≈ the raw string + one entity tree. Safe because
// <entity> blocks never nest and tag names are case-sensitive (<entityType>,
// <relatedEntity> don't collide with '<entity ' / '</entity>').
function parseEntitiesXml(xmlText, listFallback) {
  const out = [];
  const OPEN = '<entity ', CLOSE = '</entity>';
  let i = xmlText.indexOf(OPEN);
  while (i !== -1) {
    const end = xmlText.indexOf(CLOSE, i);
    if (end === -1) break;
    const block = xmlText.slice(i, end + CLOSE.length);
    const root = parse(block);
    const node = root.children.find((c) => c.tag === 'entity');
    if (node) out.push(parseEntity(node, listFallback));
    i = xmlText.indexOf(OPEN, end + CLOSE.length);
  }
  // Fallback: no <entity ...> blocks found (e.g. attribute-less <entity>) —
  // parse the whole document the old way.
  if (!out.length && xmlText.includes('<entity')) {
    const root = parse(xmlText);
    return descendants(root, 'entity').map((e) => parseEntity(e, listFallback));
  }
  return out;
}

module.exports = { parseEntitiesXml, parseEntity, groupFor, idTypeFor };
