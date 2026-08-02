'use strict';

/*
 * Cross-authority entity resolution: which listings are the same real party.
 *
 * Four authorities designate the same people and companies independently, and
 * until now the tool treated every listing as a separate party. A search for
 * one sanctioned shipowner returns four rows — OFAC, EU, UN, UK — with four
 * names ("TSANG, Yung Yuan", "Yun Yuan Tsang", "TSANG YUNG YUAN"), and nothing
 * says they are one person. That costs twice:
 *
 *   the reviewer counts four parties and works four times, and
 *   the evidence never meets — the EU record carries a date of birth OFAC does
 *   not publish, OFAC carries ownership edges the EU does not, and neither is
 *   visible from the other.
 *
 * WHAT THIS DOES NOT DO: merge. Records stay exactly as their authority
 * published them, because the prohibitions differ by regime and a merged record
 * would have to pick one. This produces a grouping and the evidence for it, so
 * the UI can say "also listed by the EU and the UK" and let the reviewer look.
 *
 * PRECISION OVER RECALL, deliberately. A wrong link tells someone that two
 * different people are one person, on a screen they use to decide whether to
 * block a payment. So the rules below are conservative, every link records what
 * justified it, and a link that rests on a name alone is not made at all.
 */

const { normalize, idf } = require('./matcher');
const { attributeKind, identifierKind } = require('./vocab');
const { parseDateValue } = require('./dates');
const { countryCodes, expandCode } = require('./countries');

/*
 * Identifier kinds precise enough to assert identity on their own.
 *
 * A passport or a company registration number identifies one party by
 * construction. Deliberately excluded: email and phone (shared by a front
 * office), call sign (reassigned between vessels), and anything the vocabulary
 * could not type at all.
 */
const IDENTIFYING_KINDS = new Set([
  'passport', 'national_id', 'tax_id', 'registration', 'imo', 'mmsi',
  'lei', 'isin', 'duns', 'crypto', 'vessel_registration', 'aircraft_msn',
]);

// Short values collide by accident; a real document number is longer than this.
const MIN_IDENTIFIER_LENGTH = 6;

/*
 * How many parties may share one identifier value before it stops identifying.
 *
 * A real document number belongs to one party, and the most it can legitimately
 * appear is once per authority. Above that it is not a document number at all:
 * six different EU-listed Russian banks share `registration:770401001`, which is
 * a KPP — a tax-office registration reason code, issued per office, not per
 * company. Before this cap that one value chained Uralsib, Fora-Bank, Derzhava,
 * BBR, DOM.RF and Rosselkhozbank into a single fifteen-member "party".
 */
const MAX_RECORDS_PER_IDENTIFIER = 4;

/*
 * Legal forms, stripped before comparing names for IDENTITY.
 *
 * Deliberately not the search tokenizer's strip list. That list has 1,758
 * entries and exists to maximise recall — it removes COMMERCIAL, CREDIT and
 * DEVELOPMENT among others, which is right for finding a party and wrong for
 * asserting that two listings ARE the same party: it collapses "Koryo
 * Commercial Bank", "Koryo Credit Development Bank" and "Koryo Bank" onto one
 * key, and those are three different banks that the DPRK sanctions lists name
 * separately.
 *
 * What is left here is only the wrapper a company's name is registered in, so
 * "JSC Russian Agricultural Bank" still meets "JOINT STOCK COMPANY RUSSIAN
 * AGRICULTURAL BANK" while the Koryo three stay apart.
 */
const LEGAL_FORMS = new Set([
  'JSC', 'JSCO', 'PJSC', 'OJSC', 'CJSC', 'OAO', 'PAO', 'AO', 'OOO', 'ZAO',
  'LLC', 'LLP', 'LP', 'LTD', 'LIMITED', 'PLC', 'INC', 'INCORPORATED',
  'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES', 'GMBH', 'MBH', 'AG',
  'SA', 'SAS', 'SARL', 'SRL', 'SPA', 'BV', 'NV', 'AB', 'OY', 'OYJ', 'KFT',
  'DOO', 'DD', 'EOOD', 'OOD', 'SDN', 'BHD', 'PTE', 'PTY', 'TBK',
  'JOINT', 'STOCK', 'PUBLIC', 'OPEN', 'CLOSED', 'PRIVATE',
  'THE', 'OF', 'AND',
]);

/*
 * The name key two listings must share to be considered the same party.
 *
 * Sorted, so word order does not matter — "BANK URALSIB PJSC" and "PUBLIC JOINT
 * STOCK COMPANY BANK URALSIB" are the same registration written two ways.
 * Duplicates are kept: "FORA BANK ... BANK" is not the same shape as "FORA
 * BANK".
 */
/*
 * Tokens of a name that are distinctive enough to corroborate an identifier.
 *
 * "BANK" is not one of them. Rarity is taken from the corpus IDF the scorer
 * already maintains, so the bar moves with the data instead of being a list
 * somebody has to remember to update.
 */
const MIN_DISTINCTIVE_IDF = 6.5;   // roughly: the token appears on <150 of 32k records

function distinctiveTokens(raw) {
  const out = new Set();
  for (const t of normalize(raw).split(' ')) {
    if (t.length < 4 || LEGAL_FORMS.has(t)) continue;
    if (idf(t) >= MIN_DISTINCTIVE_IDF) out.add(t);
  }
  return out;
}

function identityName(raw) {
  const parts = normalize(raw).split(' ').filter((t) => t && !LEGAL_FORMS.has(t));
  if (parts.length < 2) return '';
  return parts.sort().join(' ');
}

const idValue = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

function identifyingKeys(record) {
  const out = [];
  for (const id of record.identifiers || []) {
    const kind = identifierKind(id.type);
    if (!IDENTIFYING_KINDS.has(kind)) continue;
    const value = idValue(id.value);
    if (value.length < MIN_IDENTIFIER_LENGTH) continue;
    out.push(`${kind}:${value}`);
  }
  return out;
}

/*
 * Birth years a record states, as [from, to] pairs.
 *
 * YEARS, not days. Comparing at day precision made the four authorities
 * disagree with each other constantly — OFAC gives a day, the UN gives a year,
 * and where both give a day they sometimes differ by one — and treating that as
 * evidence of two different people would have split apart parties that every
 * other field says are the same. A year apart is a real disagreement; a day
 * apart inside one year is two clerks reading the same passport.
 */
function birthYearRanges(record) {
  const out = [];
  for (const a of record.attributes || []) {
    if (attributeKind(a.label) !== 'dob') continue;
    const parsed = parseDateValue(a.value);
    if (parsed) out.push([Number(parsed.from.slice(0, 4)), Number(parsed.to.slice(0, 4))]);
  }
  return out;
}

function countryCodeSet(record) {
  const out = new Set();
  const add = (raw) => { for (const c of countryCodes(raw)) for (const x of expandCode(c)) out.add(x); };
  for (const a of record.attributes || []) {
    const kind = attributeKind(a.label);
    if (kind === 'nationality' || kind === 'citizenship') add(a.value);
  }
  for (const ad of record.addresses || []) if (ad.country) add(ad.country);
  return out;
}

const yearsOverlap = (a, b) => a.some(([x1, x2]) => b.some(([y1, y2]) => x1 <= y2 && y1 <= x2));
const shareAny = (a, b) => { for (const v of a) if (b.has(v)) return true; return false; };

/*
 * Do two listings from different authorities describe the same party?
 *
 * Returns the basis, or '' for no link. Order of the tests is the order of
 * their strength, and the name tests are gated differently by party type:
 *
 *   a company name is close to an identifier — "KOREA MYONGDOK SHIPPING" in the
 *   DPRK is one company, and four authorities naming it are naming that one;
 *   a personal name is not — "AUNG AUNG" of Myanmar is a great many people, so
 *   for individuals a matching name needs a birth year behind it.
 */
function linkBasis(a, b, ctx) {
  /*
   * A shared identifier is only believed when the two names also share
   * something distinctive.
   *
   * Every false merge this module produced came from a shared value that is not
   * a document number: Russian KPP codes (`registration:772501001`, issued per
   * tax office rather than per company) chained four unrelated banks together,
   * and a low-entropy national ID chained two different people. The cardinality
   * cap does not catch those — a KPP shared by exactly four listed companies
   * looks like one passport shared by four authorities.
   *
   * What separates the two is the name. Four authorities listing one person
   * write "TSANG, Yung Yuan", "Yun Yuan Tsang" and "TSANG YUNG YUAN" — they
   * share TSANG and YUAN. Renova Group and Bank Zenit share nothing but their
   * tax office. Common words do not count: rarity comes from the corpus IDF, so
   * BANK cannot corroborate anything.
   */
  const keysA = ctx.keys.get(a.id), keysB = ctx.keys.get(b.id);
  for (const k of keysA) {
    if (!keysB.has(k)) continue;
    if (ctx.name.get(a.id) && ctx.name.get(a.id) === ctx.name.get(b.id)) return 'identifier';
    if (shareAny(ctx.distinctive.get(a.id), ctx.distinctive.get(b.id))) return 'identifier';
    break;
  }

  const nameA = ctx.name.get(a.id), nameB = ctx.name.get(b.id);
  if (!nameA || nameA !== nameB) return '';

  const yearsA = ctx.years.get(a.id), yearsB = ctx.years.get(b.id);
  const bothDated = yearsA.length && yearsB.length;
  if (bothDated) return yearsOverlap(yearsA, yearsB) ? 'name+dob' : '';
  // Stated birth years that disagree are a reason NOT to link, and the check
  // above is where that happens: two dated records that do not overlap fall
  // straight out, however identical their names.

  const isPerson = (r) => /individual|person/i.test(r.type || '');
  if (isPerson(a) || isPerson(b)) return '';

  const cA = ctx.countries.get(a.id), cB = ctx.countries.get(b.id);
  if (cA.size && cB.size && shareAny(cA, cB)) return 'name+country';
  return '';
}

const CONFIDENCE = { identifier: 'high', 'name+dob': 'high', 'name+country': 'medium' };

/*
 * Build the clustering for a snapshot.
 *
 * Union-find over the links. Everything is keyed by record id in plain Maps
 * rather than written onto the records themselves — annotating entity objects
 * cost 114MB the last time it was tried, and this has to be affordable on the
 * same 512MB instance the screening runs on.
 */
function build(entities) {
  const ctx = {
    keys: new Map(), name: new Map(), years: new Map(), countries: new Map(),
    distinctive: new Map(),
  };
  // Candidate buckets, so the comparison is never all-pairs over 32k records.
  const byKey = new Map();     // identifier key  -> record[]
  const byName = new Map();    // normalized name -> record[]

  for (const e of entities) {
    const keys = identifyingKeys(e);
    ctx.keys.set(e.id, new Set(keys));
    for (const k of keys) {
      const bucket = byKey.get(k);
      if (bucket) bucket.push(e); else byKey.set(k, [e]);
    }
    // Single-token names are not distinctive enough to bucket on: "BANK" would
    // pull together eighteen unrelated institutions. identityName returns ''
    // for anything that short.
    const name = identityName(e.name || '');
    ctx.name.set(e.id, name);
    if (name) {
      const bucket = byName.get(name);
      if (bucket) bucket.push(e); else byName.set(name, [e]);
    }
    ctx.distinctive.set(e.id, distinctiveTokens(e.name || ''));
    ctx.years.set(e.id, birthYearRanges(e));
    ctx.countries.set(e.id, countryCodeSet(e));
  }

  const parent = new Map();
  const basisOf = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const e of entities) parent.set(e.id, e.id);
  const union = (a, b, basis) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    parent.set(ra, rb);
    // The weakest basis in a cluster is what the cluster rests on, so a medium
    // link anywhere makes the whole group medium rather than letting one strong
    // pair speak for links it did not justify.
    const worst = (x, y) => (x === 'name+country' || y === 'name+country' ? 'name+country' : (x === 'name+dob' || y === 'name+dob' ? 'name+dob' : 'identifier'));
    basisOf.set(rb, basisOf.has(ra) ? worst(basisOf.get(ra), basis) : basis);
  };

  const consider = (bucket) => {
    if (bucket.length < 2 || bucket.length > 40) return; // a 40-way bucket is a data artefact, not a party
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const basis = linkBasis(bucket[i], bucket[j], ctx);
        if (basis) union(bucket[i].id, bucket[j].id, basis);
      }
    }
  };
  /*
   * Drop identifier values that too many parties share before any of them is
   * used to link. Done as a pass over the finished buckets rather than while
   * filling them, because a value's cardinality is only known once every record
   * has been seen.
   */
  for (const [key, bucket] of byKey) {
    if (bucket.length <= MAX_RECORDS_PER_IDENTIFIER) continue;
    for (const e of bucket) ctx.keys.get(e.id).delete(key);
    byKey.delete(key);
  }

  for (const bucket of byKey.values()) consider(bucket);
  for (const bucket of byName.values()) consider(bucket);

  // Materialize only the groups that actually have more than one member.
  const members = new Map();
  for (const e of entities) {
    const root = find(e.id);
    const list = members.get(root);
    if (list) list.push(e.id); else members.set(root, [e.id]);
  }
  const groups = new Map();   // root -> { ids, authorities, basis }
  const rootOf = new Map();   // record id -> root, only for grouped records
  for (const [root, ids] of members) {
    if (ids.length < 2) continue;
    groups.set(root, { ids, basis: basisOf.get(root) || 'identifier' });
    for (const id of ids) rootOf.set(id, root);
  }
  return { rootOf, groups, byId: new Map(entities.map((e) => [String(e.id), e])) };
}

let cacheFor = null, cacheValue = null;
function index(entities) {
  if (cacheFor !== entities) { cacheValue = build(entities); cacheFor = entities; }
  return cacheValue;
}

/*
 * The cross-authority view of one party, or null when nothing else in the
 * snapshot is the same party.
 *
 * `alsoListedBy` is the operative bit: it names the OTHER authorities holding a
 * listing for this party, which is what changes a reviewer's next step.
 */
function crossListing(entities, id) {
  const { rootOf, groups, byId } = index(entities);
  const key = String(id);
  const root = rootOf.get(key);
  if (!root) return null;
  const group = groups.get(root);

  const self = byId.get(key);
  const selfAuthority = self ? self.authority : '';
  const others = [];
  const authorities = new Set();
  for (const memberId of group.ids) {
    if (memberId === key) continue;
    const rec = byId.get(memberId);
    if (!rec) continue;
    authorities.add(rec.authority);
    others.push({ id: memberId, name: rec.name, authority: rec.authority, list: rec.list, type: rec.type });
  }
  if (!others.length) return null;

  const alsoListedBy = [...authorities].filter((a) => a !== selfAuthority).sort();
  return {
    clusterId: root,
    size: group.ids.length,
    basis: group.basis,
    confidence: CONFIDENCE[group.basis] || 'medium',
    alsoListedBy,
    others: others.sort((a, b) => String(a.authority).localeCompare(String(b.authority))),
    note: group.basis === 'identifier'
      ? 'Linked by a shared identity document or registration number.'
      : group.basis === 'name+dob'
        ? 'Linked by an identical name and an agreeing year of birth.'
        : 'Linked by an identical name and a shared jurisdiction. No document number or birth date confirms it — treat as a lead and check the listings against each other.',
  };
}

// Compact form for a search result row: who else lists this party.
function summary(entities, id) {
  const c = crossListing(entities, id);
  if (!c || !c.alsoListedBy.length) return null;
  return { clusterId: c.clusterId, alsoListedBy: c.alsoListedBy, confidence: c.confidence, basis: c.basis };
}

module.exports = { build, index, crossListing, summary, IDENTIFYING_KINDS };
