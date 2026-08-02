'use strict';

/*
 * Canonical vocabulary for attribute labels and identifier types.
 *
 * Four authorities describe the same field in their own words, and the raw
 * counts show how far that spreads: 92 distinct attribute labels and 131
 * distinct identifier types across one snapshot, for maybe two dozen real
 * concepts. A birth date is `Birthdate` under OFAC and `Date of Birth`
 * everywhere else — 8,254 against 8,721 — and a national identity number
 * appears as `National ID` (6,906), `National ID No.` (1,699) and
 * `National Identification Number` (149).
 *
 * That was survivable only because the consumers pattern-matched their way
 * around it: the screening modifier tested `/birth|born|dob/i` against the
 * label, statistics tested `label === 'Nationality' || label === 'Citizenship'`.
 * Both are one upstream rewording away from silently reading nothing — and a
 * secondary identifier that silently stops being checked does not fail loudly,
 * it just stops catching things.
 *
 * So every attribute and identifier is tagged with a `kind` at ingest, once.
 * The authority's own label is never touched: it is what the record card shows
 * and what an analyst cites. The kind is what code compares.
 */

// Attribute label → kind. Matched on the label lowercased with trailing
// punctuation and separator noise stripped, so "Organization Type:" and
// "Additional Sanctions Information -" land on their bare form.
const ATTRIBUTE_KINDS = {
  'date of birth': 'dob',
  'birthdate': 'dob',
  'place of birth': 'pob',
  'nationality': 'nationality',
  'nationality country': 'nationality',
  'nationality of registration': 'nationality',
  'citizenship': 'citizenship',
  'citizenship country': 'citizenship',
  'gender': 'gender',
  'position': 'position',
  'title': 'position',
  'target type': 'target_type',
  'organization established date': 'established',
  'established date': 'established',
  'organization type': 'org_type',
  'secondary sanctions risk': 'secondary_sanctions',
  'email address': 'email',
  'email': 'email',
  'phone number': 'phone',
  'website': 'website',
  'swift/bic': 'swift',
  'isin': 'isin',
  'equity ticker': 'ticker',
  'issuer name': 'issuer',
  'd-u-n-s number': 'duns',
  'registration country': 'registration_country',
  'un/locode': 'locode',
  'micex code': 'ticker',
  'bik (ru)': 'bank_code',
  'eu reference': 'source_reference',
  'un reference': 'source_reference',
  'remark': 'remark',
};

// Ordered patterns for labels the table above does not name outright. First
// match wins, so the specific vessel/aircraft forms are tested before the
// generic date and program families.
const ATTRIBUTE_PATTERNS = [
  [/^digital currency address/, 'crypto'],
  [/^(other |former )?vessel (flag|type|call sign|tonnage|gross|year|owner)/, 'vessel'],
  [/^(other |former )?vessel/, 'vessel'],
  [/^vessel type$/, 'vessel'],
  [/^aircraft/, 'aircraft'],
  [/^previous aircraft/, 'aircraft'],
  [/(executive order|caatsa|hkaa|paipa|peesa|ifca|additional sanctions information|transactions prohibited)/, 'program_info'],
  [/^(effective|listing|purchase\/sales for divestment) date/, 'program_date'],
  [/passport/, 'passport'],
  [/national id/, 'national_id'],
];

const ATTRIBUTE_DATE_KINDS = new Set(['dob', 'established', 'program_date']);

function normalizeLabel(label) {
  return String(label == null ? '' : label)
    .toLowerCase()
    .replace(/[\s:;.,\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The concept an attribute label names. Falls back to 'other' rather than
// inventing a kind: an unrecognized label is a signal to look at the feed, and
// a made-up kind would hide it.
function attributeKind(label) {
  const l = normalizeLabel(label);
  if (!l) return 'other';
  if (ATTRIBUTE_KINDS[l]) return ATTRIBUTE_KINDS[l];
  for (const [re, kind] of ATTRIBUTE_PATTERNS) if (re.test(l)) return kind;
  return 'other';
}

/*
 * Identifier type → kind.
 *
 * Deliberately coarse where the distinction carries no screening consequence
 * (every flavour of company register number is `registration`) and precise
 * where it does: a passport, a national ID and an IMO number are checked
 * against different things by a reviewer, and an IMO number can be
 * checksum-validated while a company number cannot.
 */
const IDENTIFIER_PATTERNS = [
  [/passport/, 'passport'],
  [/\bimo\b/, 'imo'],
  [/\bmmsi\b/, 'mmsi'],
  [/call sign/, 'call_sign'],
  [/aircraft tail|tail number/, 'aircraft_tail'],
  [/\bmsn\b|manufacturer.s serial|construction number/, 'aircraft_msn'],
  [/vessel registration/, 'vessel_registration'],
  [/crypto|digital currency/, 'crypto'],
  [/e-?mail/, 'email'],
  [/phone|telephone|fax/, 'phone'],
  [/swift|\bbic\b/, 'swift'],
  [/\blei\b|legal entity identifier/, 'lei'],
  [/\bisin\b/, 'isin'],
  [/d-u-n-s|\bduns\b/, 'duns'],
  // Tax before registration: "Tax ID No." and "R.F.C." are tax numbers, but a
  // "Business Registration Number" is not, and several tax forms contain the
  // word "number" that the registration pattern would otherwise claim.
  [/\btax\b|\bvat\b|\bvat\b|\bnit\b|\bruc\b|\btin\b|\brif\b|\brfc\b|fiscal code|\bfein\b|global intermediary identification/, 'tax_id'],
  [/cedula|\bci\b|\bcurp\b|\bcui\b|\bdni\b|\bnie\b|\bife\b|\bssn\b|national id|national identification|national foreign id|identity card|personal id|credencial electoral|voter|residency number|birth certificate|citizen|numero de identidad|cartilla|servicio militar|turkish identification/, 'national_id'],
  [/registration|registry|commercial regist|company number|business number|enterprise number|entity code|organization code|branch unit|certificate of incorporation|registered charity|folio mercantil|matricula|chamber of comm|social credit|gazette|\bcr no\b|\bcin\b|legal entity number|economic register/, 'registration'],
  [/licen[cs]e|permit/, 'license'],
  [/identification number|identification|other identification/, 'other_id'],
];

/*
 * Dotted abbreviations are how half these types are written — "D.N.I.",
 * "C.U.R.P.", "R.F.C." — so each type is tested both as published and with the
 * dots closed up, and the patterns above are written against the dotless form.
 * Without this, `\bdni\b` never fires on "d.n.i." and 38 Argentinian national
 * IDs fall through to the unclassified bucket.
 */
/*
 * Concepts that are never a screenable identifier, however much their label
 * looks like one.
 *
 * "Nationality Country" contains the word "national", and the identifier
 * classifier in lib/advanced matched on exactly that — so a party's nationality
 * was filed as their national ID number. 5,821 records carried an identifier
 * whose value was a country name, and because identifiers are matched EXACTLY,
 * searching "Russia" returned 1,700 parties at score 1.00 labelled "exact
 * National ID identifier match": the strongest verdict this system can issue,
 * on a word that identifies nobody.
 */
const NON_IDENTIFIER_KINDS = new Set([
  'nationality', 'citizenship', 'pob', 'dob', 'gender', 'position', 'target_type',
  'org_type', 'secondary_sanctions', 'program_info', 'program_date', 'established',
  'remark', 'source_reference', 'registration_country', 'issuer',
]);

// Can a feature with this label carry an identifier at all? Asked before the
// identifier classifier runs, so a label that names a concept rather than a
// number never reaches it.
function labelCanBeIdentifier(label) {
  return !NON_IDENTIFIER_KINDS.has(attributeKind(label));
}

function identifierKind(type) {
  const t = normalizeLabel(type);
  if (!t) return 'other_id';
  const dotless = t.replace(/\./g, '').replace(/\s+/g, ' ').trim();
  for (const [re, kind] of IDENTIFIER_PATTERNS) if (re.test(t) || re.test(dotless)) return kind;
  return 'other_id';
}

module.exports = {
  attributeKind, identifierKind, labelCanBeIdentifier, normalizeLabel,
  NON_IDENTIFIER_KINDS,
  ATTRIBUTE_DATE_KINDS,
};
