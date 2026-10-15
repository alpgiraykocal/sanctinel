'use strict';

/*
 * Record hygiene, applied on read to whatever snapshot is loaded.
 *
 * What lands on disk is exactly what each authority published (see
 * lib/ingest writeCache), and that is the right thing to keep: it is what an
 * analyst cites, and a rebuild cannot publish while an upstream feed is down,
 * so a fix that only ran at ingest would not reach the data until every source
 * was healthy on the same night. This module is the read side of that
 * contract. It corrects DEFECTS — formatting noise, exact repetition, fields a
 * publisher packed into free text — and never rewrites what a publisher said:
 * labels, spellings and country names stay as published.
 *
 * Everything here is idempotent, so running it over an already-clean record
 * changes nothing, and it is measured by scripts/quality-report.js and the
 * gate in lib/quality so a regression in it shows up as a number.
 *
 * What it fixes, with the counts it was written against (snapshot 1050):
 *
 *   dates     UK publishes dd/mm/yyyy (5,135 records), the UN occasionally
 *             appends a zone offset ("2015-03-27-04:00", 9), and one CSL row
 *             is m/d/yyyy. Every other record is ISO, and sorting, the
 *             timeline and the changes view compare these as strings.
 *   text      doubled spaces, non-breaking spaces and bidi control marks in
 *             names and values (OFAC: 529), and the CSL's list-splitting
 *             leftovers — "Sinno Electronics Co., Ltd.," and "-CJSC VAD" (56).
 *   repeats   identical addresses (4,649 — mostly OFAC country-only entries),
 *             attributes (389), identifiers (19) and aliases (exact repeats of
 *             another name on the same record).
 *   UK notes  OFSI packs ~25 labelled fields into "Other Information":
 *             "(UK Sanctions List Ref):INU0054. (Business Reg No):4152338 ...".
 *             Unparsed, none of them was searchable or displayable as a field
 *             — 429 company registration numbers, 15 IMO numbers, 466 email
 *             addresses, and 986 UN references that tie a UK listing to the UN
 *             one it implements. They become attributes and identifiers here.
 *   type      the CSL carries no person/entity flag for the BIS and State
 *             lists, so 6,212 records were "Listed party". A name with an
 *             explicit legal form or organisation word (LTD, LLC, GMBH, JSC,
 *             INSTITUTE, UNIVERSITY …) is an organisation by its own say-so;
 *             nothing else is guessed.
 */


// Zero-width and bidirectional control characters. They render as nothing,
// survive copy-paste into other systems, and make two equal names unequal.
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;
const SPACES = /[\s  - 　]+/g;

// Anything tidy would change: an edge space, a doubled space, a space that is
// not U+0020, or an invisible mark. Tested first because nearly every string is
// already clean, and a test allocates nothing where two replaces would.
const UNTIDY = /^\s|\s$|\s\s|[\t\n\r\f\v\u00A0\u2000-\u200F\u202A-\u202E\u2060-\u2069\u3000\uFEFF]/;

function tidy(s) {
  if (typeof s !== 'string' || !UNTIDY.test(s)) return s;
  return s.replace(INVISIBLE, '').replace(SPACES, ' ').trim();
}

// A name additionally loses punctuation that cannot belong to it: a leading
// dash, dot or comma, and a trailing comma, semicolon, colon or dash. A
// trailing dot stays — "CO. LTD." is how the company is written.
function tidyName(s) {
  const t = tidy(s);
  if (typeof t !== 'string') return t;
  const u = t.replace(/^[\s\-–—.,;:]+/, '').replace(/[\s,;:\-–—]+$/, '');
  return u || t;
}

/*
 * The listing date as ISO yyyy-mm-dd, or unchanged when it is already ISO or
 * cannot be read. A slash date is day-first from the UK (OFSI's format) and
 * month-first from the U.S. sources, and a value that only reads one way is
 * read that way whatever the source.
 */
function isoDate(raw, authority) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return s;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) return iso[1];
  const m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (!m) return s;
  let [a, b] = [Number(m[1]), Number(m[2])];
  let day, month;
  if (a > 12 && b <= 12) { day = a; month = b; }
  else if (b > 12 && a <= 12) { day = b; month = a; }
  else if (authority === 'UK' || authority === 'EU' || authority === 'UN') { day = a; month = b; }
  else { day = b; month = a; }
  if (!day || !month || month > 12 || day > 31) return s;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/*
 * OFSI "Other Information" → labelled fields.
 *
 * Only labels on this list are split out. The free text also contains
 * parentheses followed by colons that are not fields — "(2022): “being
 * political and military leaders…" quotes a regulation — and treating every
 * "(…):" as a field would cut real prose into nonsense attributes.
 *
 * Each entry: [label as OFSI writes it, display group, identifier type or
 * null]. The label is kept verbatim; lib/vocab gives it a kind.
 */
const UK_FIELDS = [
  ['UK Sanctions List Ref', 'Program', null],
  ['UK Statement of Reasons', 'Program', null],
  ['UN Ref', 'Program', null],
  ['Gender', 'Identity', null],
  ['Type of entity', 'Other', null],
  ['Parent company', 'Other', null],
  ['Subsidiaries', 'Other', null],
  ['Business Reg No', 'Documents', 'Business Registration Number'],
  ['Trade register number', 'Documents', 'Trade Register Number'],
  ['Phone number', 'Digital & Contact', null],
  ['Tel', 'Digital & Contact', null],
  ['Fax', 'Digital & Contact', null],
  ['Website', 'Digital & Contact', null],
  ['Email address', 'Digital & Contact', 'Email'],
  ['IMO number', 'Vessel / Aircraft', 'IMO'],
  ['Current owners', 'Vessel / Aircraft', null],
  ['Flag of ship', 'Vessel / Aircraft', null],
  ['Previous flags', 'Vessel / Aircraft', null],
  ['Type of ship', 'Vessel / Aircraft', null],
  ['Tonnage of ship', 'Vessel / Aircraft', null],
  ['Length of ship', 'Vessel / Aircraft', null],
  ['Year built', 'Vessel / Aircraft', null],
];
const UK_FIELD_BY_KEY = new Map(UK_FIELDS.map((f) => [f[0].toLowerCase(), f]));
const UK_LABEL = new RegExp(`\\((${UK_FIELDS.map((f) => f[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\)\\s*:`, 'gi');
// A UN reference: a two-letter regime, a type letter, a dot and a number —
// QDi.241, IRe.078, KPi.033, CDe.001. OFSI sometimes upper-cases the type
// letter ("IRI.038"), so case is not part of the pattern.
const UN_REF = /^([A-Za-z]{3}\.\s?\d{1,4})\b\.?\s*/;
// Reference-like values lose the sentence-ending dot OFSI leaves on them.
const TRIM_DOT = new Set(['uk sanctions list ref', 'business reg no', 'trade register number', 'imo number']);

function splitUkOtherInformation(text) {
  const s = String(text || '');
  const marks = [];
  UK_LABEL.lastIndex = 0;
  let m;
  while ((m = UK_LABEL.exec(s))) marks.push({ at: m.index, end: m.index + m[0].length, key: m[1].toLowerCase() });
  if (!marks.length) return null;
  const fields = [];
  const rest = [s.slice(0, marks[0].at)];
  marks.forEach((mk, i) => {
    let value = tidy(s.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : s.length));
    if (mk.key === 'un ref') {
      // "QDi.241. Distinguishing marks include …" — the reference, then prose
      // that belongs to the record's remarks, not to the reference.
      const u = value.match(UN_REF);
      if (u) { rest.push(value.slice(u[0].length)); value = u[1]; }
    }
    if (TRIM_DOT.has(mk.key)) value = value.replace(/\.$/, '');
    if (value) fields.push({ field: UK_FIELD_BY_KEY.get(mk.key), value });
  });
  return { fields, rest: tidy(rest.join(' ')) };
}

function applyUkOtherInformation(e) {
  const parsed = splitUkOtherInformation(e.remarks);
  if (!parsed) return;
  for (const { field: [label, group, idType], value } of parsed.fields) {
    e.attributes.push({ group, label, value });
    if (idType) e.identifiers.push({ type: idType, value });
  }
  e.remarks = parsed.rest;
}

/*
 * Organisation words that settle a CSL "Listed party" as an entity. A legal
 * form, or a word no person is named. Two-letter forms (SA, AG, AO, CO) are
 * left out: they occur in personal names and transliterations.
 */
const ORG_WORDS = new RegExp('\\b(' + [
  'LTD', 'LIMITED', 'LLC', 'L\\.L\\.C', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'COMPANY', 'GMBH',
  'JSC', 'OJSC', 'PJSC', 'CJSC', 'OAO', 'ZAO', 'OOO', 'PAO', 'PLC', 'PTE', 'PVT', 'BHD', 'FZE', 'FZCO',
  'S\\.A', 'S\\.R\\.L', 'SRL', 'SPA', 'B\\.V', 'N\\.V', 'CO\\.', 'LLP', 'L\\.P',
  'TRADING', 'INDUSTRIES', 'INDUSTRY', 'INDUSTRIAL', 'ENTERPRISE', 'ENTERPRISES', 'GROUP', 'HOLDING', 'HOLDINGS',
  'INSTITUTE', 'UNIVERSITY', 'ACADEMY', 'LABORATORY', 'LABORATORIES', 'BUREAU', 'MINISTRY', 'DEPARTMENT',
  'AGENCY', 'CENTER', 'CENTRE', 'FACTORY', 'PLANT', 'BANK', 'ASSOCIATION', 'ORGANIZATION', 'ORGANISATION',
  'SHIPPING', 'TECHNOLOGY', 'TECHNOLOGIES', 'ELECTRONICS', 'ELECTRONIC', 'SYSTEMS', 'INTERNATIONAL',
  'AEROSPACE', 'AVIATION', 'AIRLINES', 'LOGISTICS', 'IMPORT', 'EXPORT', 'MANUFACTURING', 'ENGINEERING',
  'CORPORATE', 'BRANCH', 'OFFICE', 'COMMITTEE', 'COUNCIL', 'FOUNDATION', 'UNION', 'REGIMENT', 'BRIGADE',
  'DIVISION', 'DIRECTORATE', 'ADMINISTRATION', 'AUTHORITY', 'SERVICES', 'SOLUTIONS', 'SUPPLY', 'SUPPLIES',
].join('|') + ')(?=$|[^A-Z0-9])', 'i');

function inferListedPartyType(e) {
  if (e.type !== 'Listed party') return;
  const names = [e.name, ...(e.names || []).map((n) => n.name)];
  if (names.some((n) => ORG_WORDS.test(String(n || '')))) e.type = 'Entity';
}

/*
 * "(1) MM611523 (2) EE947317 (3) P421967" — several numbers in one field
 * (OFSI does this for passports, national IDs, emails and registration
 * numbers: ~250 identifiers). Stored whole, none of them matched: a query is
 * compared with the complete value, and "MM611523" is not "(1) MM611523 (2)…".
 * Each becomes its own identifier. A "Label: value" inside a part ("BvD ID:
 * IR30193GN") moves the label into the type, so the value is the number alone.
 */
function splitNumbered(value) {
  const s = String(value || '');
  if (!/^\s*\(1\)/.test(s)) return null;
  const parts = s.split(/\(\d{1,2}\)/).map((p) => p.trim().replace(/[;,.]$/, '').trim()).filter(Boolean);
  return parts.length ? parts : null;
}
function splitIdentifiers(list) {
  if (!list || !list.some((i) => splitNumbered(i.value))) return list;
  const out = [];
  for (const i of list) {
    const parts = splitNumbered(i.value);
    if (!parts) { out.push(i); continue; }
    for (const part of parts) {
      const m = part.match(/^([A-Za-z][A-Za-z .]{0,24}?)\s*(?::|\s-)\s*(\S.*)$/);
      const id = m ? { type: `${i.type} (${m[1].trim()})`, value: m[2] } : { type: i.type, value: part };
      if (i.status) id.status = i.status;
      out.push(id);
    }
  }
  return out;
}

/*
 * The script a name is actually written in. Feeds label every alias "Latin"
 * by default — 6,069 Cyrillic, Arabic and Chinese names carried that label —
 * and the record card shows it next to the name.
 */
const SCRIPTS = [
  ['Cyrillic', /[\u0400-\u04FF]/], ['Arabic', /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/],
  ['Hebrew', /[\u0590-\u05FF]/], ['Greek', /[\u0370-\u03FF]/], ['Georgian', /[\u10A0-\u10FF]/],
  ['Armenian', /[\u0530-\u058F]/], ['Thai', /[\u0E00-\u0E7F]/], ['Hangul', /[\uAC00-\uD7AF\u1100-\u11FF]/],
  ['Japanese', /[\u3040-\u30FF]/], ['Chinese', /[\u4E00-\u9FFF\u3400-\u4DBF]/],
];
function scriptOf(s) {
  for (const [name, re] of SCRIPTS) if (re.test(s)) return name;
  return '';
}

/*
 * A BIS Denied Persons List order with an end date in the past.
 *
 * The CSL keeps publishing denial orders after they lapse — 1,152 of the 1,596
 * DPL entries ended between 1992 and last month — and every one of them read
 * as a live denial of export privileges, the same as one issued yesterday.
 * They are kept (a lapsed denial is still history a reviewer may want), but
 * marked: the sanctions type says the order has expired and when, the record
 * carries the status, and search ranks them below live restrictions.
 */
function lapsedDenial(e, today) {
  if (e.authority !== 'BIS' || !/Denied Persons/i.test((e.lists || [e.list]).join(' '))) return '';
  const end = (e.attributes || []).find((a) => a.label === 'End date');
  const d = end && /^\d{4}-\d{2}-\d{2}/.test(end.value) ? end.value.slice(0, 10) : '';
  return d && d < today ? d : '';
}

// The date a record's restriction lapsed, or '' while it is in force. Read by
// the server (ranking) and the record card; derived from published fields, so
// it needs nothing stored on the record.
function expiredOn(e) {
  const s = (e.attributes || []).find((a) => a.label === 'Denial order status');
  const m = s && String(s.value).match(/^Expired (\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// Values that stand for "nothing" in a country field.
const EMPTY_VALUE = /^(n\/?a|none|unknown|-+)$/i;

function dedupe(list, keyOf) {
  if (!list || list.length < 2) return list;
  const seen = new Set();
  let dup = false;
  for (const x of list) { const k = keyOf(x); if (seen.has(k)) { dup = true; break; } seen.add(k); }
  if (!dup) return list;   // the common case: leave the array alone
  seen.clear();
  return list.filter((x) => { const k = keyOf(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

const upper = (s) => String(s == null ? '' : s).toUpperCase();
const idValueKey = (v) => upper(v).replace(/[^A-Z0-9]/g, '');

function normalizeRecord(e, today = new Date().toISOString().slice(0, 10)) {
  // Dates.
  if (e.datePublished) {
    const d = isoDate(e.datePublished, e.authority);
    if (d !== e.datePublished) e.datePublished = d;
  }

  // UK free text → fields, before any dedupe so its output is deduped too.
  if (e.authority === 'UK' && e.remarks) applyUkOtherInformation(e);

  // Names. The primary name and names[] are kept in step.
  if (e.name) { const n = tidyName(e.name); if (n !== e.name) e.name = n; }
  if (e.title) { const t = tidy(e.title); if (t !== e.title) e.title = t; }
  if (e.remarks) { const r = tidy(e.remarks); if (r !== e.remarks) e.remarks = r; }
  if (Array.isArray(e.names) && e.names.length) {
    for (const n of e.names) {
      if (n.name) { const t = tidyName(n.name); if (t !== n.name) n.name = t; }
      if (n.native) { const t = tidy(n.native); if (t !== n.native) n.native = t; }
      if (n.name && (!n.script || n.script === 'Latin')) {
        const sc = scriptOf(n.name);
        if (sc) n.script = sc;
      }
    }
    const primary = e.names.find((n) => n.primary) || e.names[0];
    if (primary && primary.name && e.name !== primary.name && upper(e.name) === upper(primary.name)) e.name = primary.name;
    // An alias that repeats another name on the record exactly adds nothing to
    // the record and a duplicate row to every screen that lists aliases. The
    // primary always survives; where a repeat carried a native-script form the
    // survivor lacked, the form moves to the survivor rather than being lost.
    const seen = new Map();
    if (primary) seen.set(upper(primary.name), primary);
    const out = [];
    for (const n of e.names) {
      const k = upper(n.name);
      const first = seen.get(k);
      if (first && first !== n) { if (n.native && !first.native) first.native = n.native; continue; }
      seen.set(k, n);
      out.push(n);
    }
    if (out.length !== e.names.length) e.names = out;
  }

  // Addresses.
  if (Array.isArray(e.addresses) && e.addresses.length) {
    for (const a of e.addresses) {
      if (a.full) { const t = tidy(a.full); if (t !== a.full) a.full = t; }
      if (a.country) {
        const t = tidy(a.country);
        if (EMPTY_VALUE.test(t)) a.country = '';
        else if (t !== a.country) a.country = t;
      }
    }
    e.addresses = dedupe(e.addresses, (a) => `${upper(a.full).replace(/[^A-Z0-9]/g, '')}|${upper(a.country)}`);
  }

  // Attributes.
  if (Array.isArray(e.attributes) && e.attributes.length) {
    // A value that stands for "nothing" ("na", "n/a", "-") is dropped rather
    // than shown, counted and compared as if it said something.
    const blank = (v) => v === '' || v == null || EMPTY_VALUE.test(String(v));
    let empty = false;
    for (const a of e.attributes) {
      if (typeof a.value === 'string') { const t = tidy(a.value); if (t !== a.value) a.value = t; }
      if (blank(a.value)) empty = true;
    }
    if (empty) e.attributes = e.attributes.filter((a) => !blank(a.value));
    e.attributes = dedupe(e.attributes, (a) => `${upper(a.label)}|${upper(a.value)}`);
  }

  // Identifiers and identity documents.
  if (Array.isArray(e.identifiers) && e.identifiers.length) {
    for (const i of e.identifiers) {
      if (typeof i.value === 'string') { const t = tidy(i.value); if (t !== i.value) i.value = t; }
    }
    e.identifiers = dedupe(splitIdentifiers(e.identifiers).filter((i) => idValueKey(i.value)), (i) => `${upper(i.type)}|${idValueKey(i.value)}`);
  }
  if (Array.isArray(e.idDocuments) && e.idDocuments.length) {
    for (const d of e.idDocuments) {
      if (typeof d.number === 'string') { const t = tidy(d.number); if (t !== d.number) d.number = t; }
    }
    e.idDocuments = dedupe(e.idDocuments, (d) => `${upper(d.type)}|${idValueKey(d.number)}|${upper(d.issuingCountry)}`);
  }

  inferListedPartyType(e);

  const lapsed = lapsedDenial(e, today);
  if (lapsed && !expiredOn(e)) {
    e.attributes.push({ group: 'Program', label: 'Denial order status', value: `Expired ${lapsed}` });
    e.sanctionsTypes = (e.sanctionsTypes || []).map((t) => `${t} (expired ${lapsed})`);
  }
  return e;
}

module.exports = { normalizeRecord, tidy, tidyName, isoDate, splitUkOtherInformation, inferListedPartyType, splitIdentifiers, scriptOf, expiredOn, ORG_WORDS, UK_FIELDS };
