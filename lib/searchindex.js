'use strict';

/*
 * Character-bigram inverted index + exact identifier index for candidate
 * prefiltering. Instead of scoring the query against all ~20k entities, we
 * score only entities that share enough character bigrams with the query
 * (typically a few hundred), cutting search latency an order of magnitude.
 *
 * Recall-safe by design: high-similarity matches share almost all their
 * bigrams, and we index BOTH the normalized and transliteration-folded forms of
 * every name (primary + aliases) so phonetic/romanization variants co-locate.
 * The overlap floor is deliberately low (30%) so nothing above the noise
 * threshold is dropped. Very short queries (< 2 bigrams) bypass the index and
 * fall back to a full scan.
 */

const { normalize, foldTranslit, idKey } = require('./matcher');

// Trigrams are far more selective than bigrams, so candidate pools stay small
// while near-identical (high-score) names still share almost all of them.
function trigrams(s) {
  const g = [];
  if (s.length < 3) { if (s.length >= 2) g.push(s); return g; }
  for (let i = 0; i < s.length - 2; i++) g.push(s.slice(i, i + 3));
  return g;
}

function gramSet(query) {
  const n = normalize(query).replace(/\s+/g, '');
  const set = new Set();
  for (const g of trigrams(n)) set.add(g);
  for (const g of trigrams(foldTranslit(n))) set.add('~' + g); // namespaced folded grams
  return set;
}

function gramsOf(name) { return gramSet(name); }

function build(entities) {
  const gram = new Map();  // bigram -> array of entity indices
  const idIdx = new Map(); // idKey -> array of entity indices
  entities.forEach((e, i) => {
    const grams = new Set();
    const names = (e.names && e.names.length) ? e.names : [{ name: e.name }];
    for (const nm of names) for (const g of gramsOf(nm.name || '')) grams.add(g);
    for (const g of grams) { let a = gram.get(g); if (!a) { a = []; gram.set(g, a); } a.push(i); }
    for (const id of e.identifiers || []) {
      const k = idKey(id.value);
      if (k && k.length >= 4) { let a = idIdx.get(k); if (!a) { a = []; idIdx.set(k, a); } a.push(i); }
    }
  });
  return { gram, idIdx, n: entities.length };
}

// Return the array of entity indices to score, or null to signal "full scan".
function candidates(index, query) {
  const n = normalize(query).replace(/\s+/g, '');
  if (n.length < 3) return null; // too short for trigrams → full scan
  const qg = gramSet(query);
  if (!qg.size) return null;

  const counts = new Int16Array(index.n);
  const touched = [];
  for (const g of qg) {
    const a = index.gram.get(g);
    if (!a) continue;
    for (const i of a) { if (counts[i] === 0) touched.push(i); counts[i]++; }
  }
  // Share at least ~25% of query trigrams (min 2), plus any exact identifier hit.
  const minShared = Math.max(2, Math.floor(qg.size * 0.25));
  const out = [];
  const inOut = new Uint8Array(index.n);
  for (const i of touched) if (counts[i] >= minShared) { out.push(i); inOut[i] = 1; }

  // Exact identifier hits (share no name grams with an id number query).
  const idk = idKey(query);
  if (idk && idk.length >= 4) {
    const a = index.idIdx.get(idk);
    if (a) for (const i of a) if (!inOut[i]) { out.push(i); inOut[i] = 1; }
  }
  return out;
}

module.exports = { build, candidates };
