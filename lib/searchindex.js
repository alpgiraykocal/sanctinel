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

const { foldTranslit, idKey, tokens, searchableNames } = require('./matcher');

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
// A single edit cannot move a token's length further than this, so tokens
// outside the window cannot reach 0.95 and need not be scored.
const MAX_LEN_DELTA = 1;

/*
 * Share of the query's trigrams a candidate must carry. The FLOOR of 1 is what
 * short queries need — "Soe Win" has so few trigrams that a strong match can
 * legitimately overlap on only one — but dropping the RATIO as well was
 * unnecessary and expensive: at 0.20 a "Sberbank" search scored 2,026 entities
 * where 0.25 scores 666 for exactly the same hits. Ratio and floor are separate
 * knobs and only the floor was doing recall work.
 */
const GRAM_OVERLAP_RATIO = 0.25;
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

/*
 * Postings are stored CSR-style: one flat Int32Array of entity indices plus an
 * offset table, rather than a Map of per-key JavaScript arrays.
 *
 * Measured over the live 38k snapshot: 2.3M postings across 70k arrays cost
 * 36MB as arrays-of-arrays (16 bytes per posting once V8's per-array overhead
 * is counted) and 9MB flat. That 27MB is the difference between fitting in a
 * 512MB container and being OOM-killed mid-request, and the flat scan is also
 * faster — one sequential typed-array walk instead of chasing pointers.
 */
function toCsr(map, meta) {
  const slots = new Map();
  const offsets = new Int32Array(map.size + 1);
  let total = 0, i = 0;
  for (const [k, arr] of map) { slots.set(k, i); offsets[i] = total; total += arr.length; i++; }
  offsets[map.size] = total;
  const values = new Int32Array(total);
  const lens = meta ? new Uint8Array(total) : null;
  let p = 0;
  for (const arr of map.values()) {
    for (const v of arr) {
      if (lens) { values[p] = v & 0xffffff; lens[p] = v >>> 24; } else values[p] = v;
      p++;
    }
  }
  return { slots, offsets, values, lens };
}

// Call `fn(entityIndex, tokenLength)` for every posting under `key`.
function eachPosting(csr, key, fn) {
  const slot = csr.slots.get(key);
  if (slot === undefined) return;
  const end = csr.offsets[slot + 1];
  for (let i = csr.offsets[slot]; i < end; i++) fn(csr.values[i], csr.lens ? csr.lens[i] : 0);
}

function build(entities) {
  // Collected as arrays first, then flattened; the temporary maps are dropped
  // before returning so only the flat form is retained.
  let gram = new Map();   // trigram -> entity indices
  let idIdx = new Map();  // idKey -> entity indices
  let acr = new Map();    // acronym -> entity indices
  let bigram = new Map(); // bigram of a short token -> entity indices
  const push = (map, key, i) => { const a = map.get(key); if (a) a.push(i); else map.set(key, [i]); };

  entities.forEach((e, i) => {
    const grams = new Set();
    const acronyms = new Set();
    const bigrams = new Set();
    // Exactly the name surface matcher.matchName scores against — including the
    // native-script forms. Deriving it from the same helper is what keeps the
    // recall invariant above true; iterating e.names here instead silently
    // excluded every native-script name from the prefilter.
    const names = searchableNames(e);
    for (const nm of names) {
      for (const g of gramsOf(nm)) grams.add(g);
      const ac = acronymOf(nm);
      if (ac) acronyms.add(ac);
      // Each bigram posting carries the LENGTH of the token it came from,
      // packed into the value's high byte. The typos this lane exists to catch
      // are one or two edits, which cannot change a token's length by more than
      // that, so a length-incompatible token can be rejected without ever
      // touching the entity — which is where the lane's cost was.
      for (const t of tokens(nm)) {
        for (const b of bigramsOfShortToken(t)) bigrams.add(b + ' ' + t.length);
      }
    }
    for (const g of grams) push(gram, g, i);
    for (const ac of acronyms) push(acr, ac, i);
    for (const bl of bigrams) {
      const cut = bl.lastIndexOf(' ');
      push(bigram, bl.slice(0, cut), (Number(bl.slice(cut + 1)) << 24) | i);
    }
    for (const id of e.identifiers || []) {
      const k = idKey(id.value);
      if (k && k.length >= 4) push(idIdx, k, i);
    }
  });

  const index = {
    gram: toCsr(gram), idIdx: toCsr(idIdx), acr: toCsr(acr),
    bigram: toCsr(bigram, true), // carries token lengths
    n: entities.length,
  };
  gram = idIdx = acr = bigram = null;
  return index;
}

// Return the array of entity indices to score, or null to signal "full scan".
function candidates(index, query) {
  // Same string gramSet indexes on, so the guard and the grams can't disagree.
  const n = tokens(query).join('');
  if (n.length < 3) return null; // too short for trigrams → full scan
  const qg = gramSet(query);
  if (!qg.size) return null;

  const counts = scratch(index.n, 'counts');
  const touched = [];
  for (const g of qg) {
    eachPosting(index.gram, g, (i) => { if (counts[i] === 0) touched.push(i); counts[i]++; });
  }
  // Share at least ~20% of the query's trigrams, plus the exact identifier and
  // acronym hits below, which share no name trigrams with the query at all.
  // The floor is 1, not 2: a short query ("Soe Win") has so few trigrams that a
  // strong token match can legitimately overlap on only one of them, and a
  // floor of 2 dropped those hits outright.
  const minShared = Math.max(1, Math.floor(qg.size * GRAM_OVERLAP_RATIO));
  const out = [];
  const inOut = scratch(index.n, 'inOut');
  for (const i of touched) if (counts[i] >= minShared) { out.push(i); inOut[i] = 1; }

  const add = (csr, key) => eachPosting(csr, key, (i) => { if (!inOut[i]) { out.push(i); inOut[i] = 1; } });

  // Exact identifier hits (an id-number query shares no name grams).
  const idk = idKey(query);
  if (idk && idk.length >= 4) add(index.idIdx, idk);

  // Acronym hits: "CCC" ↔ China Communications Construction Company scores 0.97
  // on a full scan but shares no trigram with the name it stands for.
  const qt = tokens(query);
  if (qt.length === 1 && qt[0].length >= 2 && qt[0].length <= 6) add(index.acr, qt[0]); // matcher.acronymScore preconditions

  // Short-token bigram lane (see bigramsOfShortToken). Counted in a reused
  // typed array rather than a per-query Map: the common bigrams have very long
  // posting lists, and a Map insert per posting was the lane's real cost.
  const bigramCounts = scratch(index.n, 'bigrams');
  for (const t of qt) {
    const bg = bigramsOfShortToken(t);
    if (bg.length < MIN_SHARED_BIGRAMS) continue;
    const seen = [];
    for (const b of bg) {
      eachPosting(index.bigram, b, (i, len) => {
        if (inOut[i] || Math.abs(len - t.length) > MAX_LEN_DELTA) return;
        if (bigramCounts[i] === 0) seen.push(i);
        bigramCounts[i]++;
      });
    }
    for (const i of seen) {
      if (bigramCounts[i] >= MIN_SHARED_BIGRAMS && !inOut[i]) { out.push(i); inOut[i] = 1; }
      bigramCounts[i] = 0;
    }
  }

  return out;
}

/*
 * Reusable per-index scratch buffers. Three Int32Array(38066) allocations per
 * query is 450KB of short-lived garbage on the hottest path; candidates() is
 * synchronous and single-threaded, so the buffers can be cleared and reused.
 */
const scratchpads = new Map();
function scratch(n, name) {
  let byName = scratchpads.get(n);
  if (!byName) { byName = new Map(); scratchpads.set(n, byName); }
  let buf = byName.get(name);
  if (!buf) { buf = new Int32Array(n); byName.set(name, buf); }
  else buf.fill(0);
  return buf;
}

module.exports = { build, candidates };
