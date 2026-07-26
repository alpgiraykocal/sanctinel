'use strict';

/*
 * Character-trigram inverted index + exact identifier and acronym indexes, used
 * to prefilter candidates. Instead of scoring the query against all ~38k
 * entities (~2s), we score only entities that share enough trigrams with the
 * query (typically a few hundred), cutting search latency an order of magnitude.
 *
 * RECALL INVARIANT. Every scoring channel in lib/matcher that can reach the
 * 0.95 default threshold must be reproducible from this index, or the fast path
 * would silently return fewer hits than a full scan — a false negative, the
 * worst failure mode in screening. The three channels that do not follow from
 * raw character overlap are indexed explicitly:
 *   - transliteration variants → trigrams of the FOLDED form are indexed too,
 *     and matcher.tokenSim only applies the translit boost when the folded
 *     forms actually share a trigram (matcher.sharesFoldedGram);
 *   - acronyms/initialisms ("CCC" ↔ China Communications Construction Company,
 *     scores 0.97) share no trigrams with the name at all → a separate acronym
 *     index, consulted for short single-token queries;
 *   - exact identifier hits → the identifier index.
 * Metaphone tops out at 0.92, below the default floor, so a single-token
 * phonetic-only hit cannot clear it; in multi-token queries the other tokens
 * put the entity in the pool anyway.
 *
 * Anything below 0.95 (an analyst deliberately widening the net) full-scans in
 * server.js instead, so this invariant only has to hold at the default.
 * scripts/verify-recall.js checks fast-path == full-scan over a random sample.
 */

const { foldTranslit, idKey, tokens } = require('./matcher');

// Trigrams are far more selective than bigrams, so candidate pools stay small
// while near-identical (high-score) names still share almost all of them.
function trigrams(s) {
  const g = [];
  if (s.length < 3) { if (s.length >= 2) g.push(s); return g; }
  for (let i = 0; i < s.length - 2; i++) g.push(s.slice(i, i + 3));
  return g;
}

// Grams are built from the SCORER's tokens, not the raw name: tokens() drops
// legal-form and org descriptors (COMPANY, GROUP, INTERNATIONAL, OOO …), which
// contribute nothing to the score. Indexing them anyway inflated the query's
// gram count and with it the overlap floor, so "SA FALCON INTERNATIONAL GROUP"
// demanded far more overlap than the one token — FALCON — that actually scores.
function gramSet(value) {
  const n = tokens(value).join('');
  const set = new Set();
  for (const g of trigrams(n)) set.add(g);
  for (const g of trigrams(foldTranslit(n))) set.add('~' + g); // namespaced folded grams
  return set;
}

function gramsOf(name) { return gramSet(name); }

// Bigrams of SHORT tokens, kept in their own index. On a short token a single
// transposition destroys every trigram — GHSAIR vs GHASIR share none — yet
// Jaro-Winkler scores it 0.96 and Dice scores KMK ↔ MKM a full 1.0. Bigrams
// survive both (GH, IR / KM, MK), so short tokens get a second, coarser lane.
// Two shared bigrams are required before a candidate is admitted, or common
// pairs like "AL" would pull in half the list.
const SHORT_TOKEN_MAX = 7;
const MIN_SHARED_BIGRAMS = 2;
function bigramsOfShortToken(tok) {
  if (tok.length < 3 || tok.length > SHORT_TOKEN_MAX) return [];
  const out = [];
  for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
  return out;
}

// Initials of a name's significant tokens — the key matcher.acronymScore
// compares a short single-token query against. Built from the same tokens() the
// scorer uses, so org descriptors are stripped identically.
function acronymOf(name) {
  const t = tokens(name || '');
  if (t.length < 2 || t.length > 6) return '';
  const ac = t.map((x) => x[0]).join('');
  return ac.length >= 2 && ac.length <= 6 ? ac : '';
}

function build(entities) {
  const gram = new Map();  // trigram -> array of entity indices
  const idIdx = new Map(); // idKey -> array of entity indices
  const acr = new Map();   // acronym -> array of entity indices
  const bigram = new Map(); // bigram of a short token -> indices
  entities.forEach((e, i) => {
    const grams = new Set();
    const acronyms = new Set();
    const bigrams = new Set();
    const names = (e.names && e.names.length) ? e.names : [{ name: e.name }];
    for (const nm of names) {
      for (const g of gramsOf(nm.name || '')) grams.add(g);
      const ac = acronymOf(nm.name || '');
      if (ac) acronyms.add(ac);
      for (const t of tokens(nm.name || '')) for (const b of bigramsOfShortToken(t)) bigrams.add(b);
    }
    for (const g of grams) { let a = gram.get(g); if (!a) { a = []; gram.set(g, a); } a.push(i); }
    for (const ac of acronyms) { let a = acr.get(ac); if (!a) { a = []; acr.set(ac, a); } a.push(i); }
    for (const b of bigrams) { let a = bigram.get(b); if (!a) { a = []; bigram.set(b, a); } a.push(i); }
    for (const id of e.identifiers || []) {
      const k = idKey(id.value);
      if (k && k.length >= 4) { let a = idIdx.get(k); if (!a) { a = []; idIdx.set(k, a); } a.push(i); }
    }
  });
  return { gram, idIdx, acr, bigram, n: entities.length };
}

// Return the array of entity indices to score, or null to signal "full scan".
function candidates(index, query) {
  // Same string gramSet indexes on, so the guard and the grams can't disagree.
  const n = tokens(query).join('');
  if (n.length < 3) return null; // too short for trigrams → full scan
  const qg = gramSet(query);
  if (!qg.size) return null;

  const counts = new Int32Array(index.n);
  const touched = [];
  for (const g of qg) {
    const a = index.gram.get(g);
    if (!a) continue;
    for (const i of a) { if (counts[i] === 0) touched.push(i); counts[i]++; }
  }
  // Share at least ~20% of the query's trigrams, plus the exact identifier and
  // acronym hits below, which share no name trigrams with the query at all.
  // The floor is 1, not 2: a short query ("Soe Win") has so few trigrams that a
  // strong token match can legitimately overlap on only one of them, and a
  // floor of 2 dropped those hits outright.
  const minShared = Math.max(1, Math.floor(qg.size * 0.2));
  const out = [];
  const inOut = new Uint8Array(index.n);
  for (const i of touched) if (counts[i] >= minShared) { out.push(i); inOut[i] = 1; }

  const add = (list) => { if (list) for (const i of list) if (!inOut[i]) { out.push(i); inOut[i] = 1; } };

  // Exact identifier hits (an id-number query shares no name grams).
  const idk = idKey(query);
  if (idk && idk.length >= 4) add(index.idIdx.get(idk));

  // Acronym hits: "CCC" ↔ China Communications Construction Company scores 0.97
  // on a full scan but shares no trigram with the name it stands for.
  const qt = tokens(query);
  if (qt.length === 1 && qt[0].length >= 2 && qt[0].length <= 6) add(index.acr.get(qt[0])); // matcher.acronymScore preconditions

  // Short-token bigram lane (see bigramsOfShortToken).
  for (const t of qt) {
    const bg = bigramsOfShortToken(t);
    if (!bg.length) continue;
    const hits = new Map();
    for (const b of bg) {
      const list = index.bigram.get(b);
      if (!list) continue;
      for (const i of list) { if (!inOut[i]) hits.set(i, (hits.get(i) || 0) + 1); }
    }
    for (const [i, c] of hits) if (c >= MIN_SHARED_BIGRAMS) { out.push(i); inOut[i] = 1; }
  }

  return out;
}

module.exports = { build, candidates };
