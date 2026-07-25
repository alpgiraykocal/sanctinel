'use strict';

/*
 * OFAC screening layer: name matching + non-name identifier matching.
 *
 * Compliance note: naive exact string matching is NOT adequate. This module
 * (a) normalizes before scoring, (b) matches on primary names AND every alias,
 * (c) classifies match strength so weak single-token hits (the "Ali"/"Mohammed"
 * problem) are separable, and (d) screens non-name identifiers — passport,
 * national/tax IDs, IMO/MMSI, call signs, digital-currency addresses — for
 * exact hits, per OFAC screening guidance (screen the full identifier surface,
 * not just names).
 *
 * Record shape (produced by lib/ingest.js):
 *   { id, list, type, name, names:[{name,type,primary,lowQuality}],
 *     identifiers:[{type,value}], ... }
 */

// Multilingual matching reference compiled from OpenSanctions rigour data
// (data/matching.json): org/legal-form descriptors to strip, domain-token
// canonicalization, personal titles, and confusable character pairs.
const MATCH = (() => {
  try { return require('../data/matching.json'); }
  catch { return { strip: [], canon: {}, titles: [], confusables: [] }; }
})();
const STRIP = new Set(MATCH.strip);
const CANON = MATCH.canon || {};
const TITLES = (MATCH.titles || []).slice().sort((a, b) => b.length - a.length); // longest first
const CONFUSABLE = new Set((MATCH.confusables || []).map(([a, b]) => a + b).concat((MATCH.confusables || []).map(([a, b]) => b + a)));

const WEAK_SINGLE_TOKENS = new Set([
  'ALI', 'MOHAMMED', 'MOHAMMAD', 'MUHAMMAD', 'AHMED', 'AHMAD', 'ABDUL',
  'ABDULLAH', 'HASSAN', 'HUSSEIN', 'HUSAIN', 'IBRAHIM', 'KHAN', 'SAID',
  'SAYED', 'AL', 'BIN', 'IBN', 'BINT', 'ABU', 'UM', 'EL', 'THE', 'AND', 'OF',
]);

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Fold Cyrillic letters that are visually identical to Latin ones to their Latin
// twin, defeating homoglyph evasion (e.g. "сompany" with a Cyrillic С). Applied
// before ASCII folding so the disguised Latin word is recovered.
const HOMOGLYPHS = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's' };
function foldHomoglyphs(s) {
  return s.replace(/[АВЕКМНОРСТУХІЈЅавекмнорстухіјѕ]/g, (c) => HOMOGLYPHS[c] || c);
}

function normalize(raw) {
  if (!raw) return '';
  let s = stripDiacritics(foldHomoglyphs(String(raw))).toUpperCase();
  s = s.replace(/[^A-Z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Strip a single leading personal title (Mr, Dr, Prof Dr, …) if tokens remain.
function stripTitles(arr) {
  for (const t of TITLES) {
    if (arr.length > t.length && t.every((w, i) => arr[i] === w)) return arr.slice(t.length);
  }
  return arr;
}

function tokens(raw) {
  const all = stripTitles(normalize(raw).split(' ').filter(Boolean));
  const kept = all.filter((t) => !STRIP.has(t)).map((t) => (CANON[t] ? CANON[t].toUpperCase() : t));
  return kept.length ? kept : all; // never strip a name down to nothing
}

// Alphanumeric-only key for identifier comparison (case/space/punct-insensitive).
function idKey(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true; bMatch[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/* ---------- advanced similarity primitives ---------- */

// Metaphone-lite phonetic key. A step up from Soundex: it handles the digraphs
// and soft/hard consonants that dominate name variants (PH→F, CK→K, CH→X,
// SH→X, TH→0, soft C→S, soft G→J, silent GN/KN/PN/WR/PS, silent internal H),
// so Mohammed↔Muhammad, Smith↔Smyth, Philip↔Filip collapse while unrelated
// tokens stay distinct. Used only as a gated BOOST channel.
function metaphone(str) {
  str = String(str).toUpperCase().replace(/[^A-Z]/g, '');
  if (!str) return '';
  const len = str.length;
  const V = (c) => 'AEIOU'.includes(c);
  let i = 0, out = '';
  if (/^(GN|KN|PN|WR|PS)/.test(str)) i = 1;
  while (i < len && out.length < 6) {
    const c = str[i], n = str[i + 1] || '', p = str[i - 1] || '';
    if (c === p && c !== 'C') { i++; continue; } // skip doubled letters
    switch (c) {
      case 'A': case 'E': case 'I': case 'O': case 'U': if (i === 0) out += 'A'; i++; break;
      case 'B': out += 'P'; i++; break;
      case 'C':
        if (str.substr(i, 3) === 'CIA' || n === 'H') { out += 'X'; i += 2; }
        else if ('IEY'.includes(n)) { out += 'S'; i++; }
        else { out += 'K'; i++; } break;
      case 'D':
        if (n === 'G' && 'IEY'.includes(str[i + 2] || '')) { out += 'J'; i += 3; }
        else { out += 'T'; i++; } break;
      case 'F': out += 'F'; i++; break;
      case 'G':
        if (n === 'H') { out += V(str[i + 2] || '') ? 'K' : ''; i += 2; }
        else if (n === 'N') { i++; }
        else if ('IEY'.includes(n)) { out += 'J'; i++; }
        else { out += 'K'; i++; } break;
      case 'H': if (V(p) && V(n)) out += 'H'; i++; break;
      case 'J': out += 'J'; i++; break;
      case 'K': out += 'K'; i++; break;
      case 'L': out += 'L'; i++; break;
      case 'M': out += 'M'; i++; break;
      case 'N': out += 'N'; i++; break;
      case 'P': if (n === 'H') { out += 'F'; i += 2; } else { out += 'P'; i++; } break;
      case 'Q': out += 'K'; i++; break;
      case 'R': out += 'R'; i++; break;
      case 'S':
        if (str.substr(i, 3) === 'SCH') { out += 'X'; i += 3; }
        else if (n === 'H' || str.substr(i, 3) === 'SIO' || str.substr(i, 3) === 'SIA') { out += 'X'; i += 2; }
        else { out += 'S'; i++; } break;
      case 'T':
        if (n === 'H') { out += '0'; i += 2; }
        else if (str.substr(i, 3) === 'TIO' || str.substr(i, 3) === 'TIA') { out += 'X'; i += 3; }
        else { out += 'T'; i++; } break;
      case 'V': out += 'F'; i++; break;
      case 'W': case 'Y': if (V(n)) { if (i === 0) out += 'A'; } i++; break;
      case 'X': out += (i === 0 ? 'S' : 'KS'); i++; break;
      case 'Z': out += 'S'; i++; break;
      default: i++;
    }
  }
  return out;
}

// Damerau–Levenshtein: edit distance that also counts adjacent transpositions
// as a single edit ("Sms" typo for "Sms" → "Smsi"), the most common keyboard slip.
function damerau(a, b) {
  const al = a.length, bl = b.length;
  if (!al) return bl; if (!bl) return al;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) for (let j = 1; j <= bl; j++) {
    // Confusable substitutions (0↔O, 1↔L, C↔K, homoglyph digits) cost less than
    // a full substitution — a disguised character is nearly a match.
    const ca = a[i - 1], cb = b[j - 1];
    const cost = ca === cb ? 0 : (CONFUSABLE.has(ca + cb) ? 0.5 : 1);
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[al][bl];
}
const editSim = (a, b) => (a.length || b.length ? 1 - damerau(a, b) / Math.max(a.length, b.length) : 1);

// Sørensen–Dice bigram coefficient — robust to insertions/reordering of chars.
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const m = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  let inter = 0, total = a.length - 1 + b.length - 1;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const c = m.get(g); if (c > 0) { inter++; m.set(g, c - 1); } }
  return (2 * inter) / total;
}

// Trigram Jaccard (padded) — complements bigram Dice; stronger on longer strings.
function jaccard3(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const gram = (s) => { s = '  ' + s + '  '; const g = new Set(); for (let i = 0; i < s.length - 2; i++) g.add(s.slice(i, i + 3)); return g; };
  const A = gram(a), B = gram(b);
  let inter = 0; for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function foldTranslit(t) {
  let s = t
    .replace(/SCH/g, 'S').replace(/PH/g, 'F').replace(/GH/g, 'G').replace(/KH/g, 'K')
    .replace(/TH/g, 'T').replace(/CK/g, 'K').replace(/CH/g, 'C').replace(/SH/g, 'S')
    .replace(/WR/g, 'R').replace(/QU/g, 'K').replace(/X/g, 'KS');
  s = s.replace(/(.)\1+/g, '$1');
  s = s.replace(/[HW]/g, '');
  s = s.replace(/[EIYJ]/g, 'I').replace(/[OU]/g, 'U');
  return s.replace(/[^A-Z0-9]/g, '');
}

// ---- corpus term weighting (IDF) ----
// Rare tokens (a distinctive surname) carry far more identifying signal than
// common ones (COMPANY, TRADING, MOHAMMED, AL). Weighting token matches by
// inverse document frequency across the whole list is the standard professional
// way to raise precision without a hand-maintained stopword list.
let CORPUS_N = 0;
const CORPUS_DF = new Map();
function setCorpus(dfMap, n) { CORPUS_DF.clear(); if (dfMap) for (const [k, v] of dfMap) CORPUS_DF.set(k, v); CORPUS_N = n || 0; }
function idf(tok) {
  if (!CORPUS_N) return 1;
  const df = CORPUS_DF.get(tok) || 0;
  return Math.log((CORPUS_N + 1) / (df + 1)) + 1; // >= 1, higher for rarer tokens
}

// Multi-algorithm token similarity: Jaro-Winkler ∪ Damerau-edit ∪ Dice ∪ trigram
// ∪ Metaphone ∪ transliteration ∪ initial/abbreviation. Phonetic/translit boosts
// are gated on a base Jaro-Winkler so lossy keys can't match unrelated tokens.
function tokenSim(a, b) {
  if (a === b) return 1;
  if ((a.length === 1 && b[0] === a) || (b.length === 1 && a[0] === b)) return 0.88; // initial ↔ full
  const jw = jaroWinkler(a, b);
  // Fast path: clearly dissimilar tokens (the vast majority of pairs over 20k
  // entities) skip the O(n²) edit/trigram/phonetic channels — only a cheap Dice
  // can rescue a heavily reordered pair.
  if (jw < 0.5) { const dc = dice(a, b); return dc > jw ? dc : jw; }
  let s = Math.max(jw, editSim(a, b), dice(a, b), jaccard3(a, b));
  if (jw >= 0.62 && a.length >= 4 && b.length >= 4) { const ma = metaphone(a); if (ma && ma === metaphone(b)) s = Math.max(s, 0.92); }
  if (jw >= 0.6) s = Math.max(s, Math.min(0.95, jaroWinkler(foldTranslit(a), foldTranslit(b))));
  return s;
}

// IDF-weighted, order-independent token-set score with greedy 1:1 assignment
// (no token reused) plus a whole-string channel. Coverage is over the QUERY
// tokens, weighted so a match on a rare token counts more than on a common one.
function tokenSetScore(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  const pairs = [];
  for (let i = 0; i < qTokens.length; i++)
    for (let j = 0; j < cTokens.length; j++)
      pairs.push([tokenSim(qTokens[i], cTokens[j]), i, j]);
  pairs.sort((x, y) => y[0] - x[0]);
  const qu = new Set(), cuSet = new Set();
  const w = qTokens.map(idf);
  let wsum = 0, matched = 0;
  const need = Math.min(qTokens.length, cTokens.length);
  for (const [sc, i, j] of pairs) {
    if (qu.has(i) || cuSet.has(j)) continue;
    qu.add(i); cuSet.add(j); wsum += w[i] * sc;
    if (++matched === need) break;
  }
  const wtot = w.reduce((x, y) => x + y, 0);
  const tokenAvg = wtot ? wsum / wtot : 0;
  const qJoin = qTokens.join(''), cJoin = cTokens.join('');
  const whole = Math.max(jaroWinkler(qJoin, cJoin), dice(qJoin, cJoin), jaccard3(qJoin, cJoin));
  return Math.max(tokenAvg, 0.5 * tokenAvg + 0.5 * whole);
}

// Acronym / initialism: query "CML" ↔ initials of "Caspian Maritime Logistics".
function acronymScore(qTokens, cTokens) {
  if (qTokens.length !== 1 || cTokens.length < 2) return 0;
  const q = qTokens[0];
  if (q.length < 2 || q.length > 6) return 0;
  const initials = cTokens.map((t) => t[0]).join('');
  if (initials === q) return 0.97;
  if (initials.startsWith(q) || q.startsWith(initials)) return 0.9;
  return 0;
}

// Human-readable "why did this match" for the winning candidate name — computed
// once for the best hit, not in the hot scoring loop. Labels each matched token
// pair by the channel that explains it (exact / typo / phonetic / translit /
// initial / fuzzy), audit-grade transparency for an analyst reviewing the hit.
function explainMatch(query, candName) {
  const q = tokens(query), c = tokens(candName);
  if (!q.length || !c.length) return '';
  const used = new Set();
  const parts = [];
  for (const qt of q) {
    let best = null;
    for (let j = 0; j < c.length; j++) {
      if (used.has(j)) continue;
      const s = tokenSim(qt, c[j]);
      if (!best || s > best.s) best = { s, j, ct: c[j] };
    }
    if (!best || best.s < 0.5) { parts.push(`${qt} (no match)`); continue; }
    used.add(best.j);
    let how = 'fuzzy';
    if (qt === best.ct) how = 'exact';
    else if (qt.length === 1 || best.ct.length === 1) how = 'initial';
    else if (metaphone(qt) && metaphone(qt) === metaphone(best.ct)) how = 'phonetic';
    else if (foldTranslit(qt) === foldTranslit(best.ct)) how = 'transliteration';
    else if (editSim(qt, best.ct) >= 0.8) how = 'typo';
    parts.push(qt === best.ct ? `${qt} exact` : `${qt}↔${best.ct} ${how}`);
  }
  return parts.join(' · ');
}

function classifyName(score, isExactNorm, onAlias) {
  if (isExactNorm) return onAlias ? 'strong_alias' : 'exact';
  if (score >= 0.92) return onAlias ? 'strong_alias' : 'strong';
  if (score >= 0.86) return onAlias ? 'weak_alias' : 'fuzzy';
  return 'weak';
}

// Token/key caches keyed on the stable source objects (record.names[i],
// record.identifiers[i]) so we tokenize each name once, not on every search —
// materially cheaper under public load over ~20k entities.
const _tokCache = new WeakMap();
const _idkCache = new WeakMap();
function nameTokens(o) { let t = _tokCache.get(o); if (!t) { t = tokens(o.name || ''); _tokCache.set(o, t); } return t; }
function idKeyCached(o) { let k = _idkCache.get(o); if (k === undefined) { k = idKey(o.value); _idkCache.set(o, k); } return k; }

// Candidate names as {name, primary, type, lowQuality, _o} where _o is the
// stable source object (or null for legacy string aliases → no token caching).
function candidateNames(record) {
  const out = [];
  if (record.names && record.names.length) {
    for (const n of record.names) {
      if (typeof n === 'string') out.push({ name: n, primary: false, type: 'A.K.A.', _o: null });
      else out.push({ name: n.name, primary: !!n.primary, type: n.type || 'A.K.A.', lowQuality: !!n.lowQuality, _o: n });
    }
  } else {
    out.push({ name: record.name, primary: true, type: 'Primary', _o: null });
    for (const a of record.aliases || []) {
      const s = typeof a === 'string' ? a : a.name;
      out.push({ name: s, primary: false, type: 'A.K.A.', _o: null });
    }
  }
  return out;
}

// Exact-match screen over non-name identifiers.
function matchIdentifier(query, record) {
  const qk = idKey(query);
  if (qk.length < 4) return null; // too short to be a meaningful identifier
  for (const id of record.identifiers || []) {
    const k = (id && typeof id === 'object') ? idKeyCached(id) : idKey(id && id.value);
    if (k === qk) return { score: 1, matchType: 'identifier', matchedName: id.value, matchedField: id.type, explain: `exact ${id.type} identifier match` };
  }
  return null;
}

// Secondary-identifier corroboration. Provided year-of-birth / country either
// confirm a fuzzy name hit (small boost) or contradict it (small penalty) — the
// standard "use secondary identifiers as score modifiers" screening control.
function applyModifiers(score, record, mods) {
  if (!mods || (!mods.yob && !mods.country)) return { score, corroborated: false, conflict: false };
  let out = score, corroborated = false, conflict = false;
  if (mods.yob) {
    const years = (record.attributes || [])
      .filter((a) => /birth|born|dob/i.test(a.label))
      .flatMap((a) => (String(a.value).match(/\b(19|20)\d\d\b/g) || []));
    if (years.length) {
      if (years.includes(String(mods.yob))) { out = Math.min(1, out + 0.05); corroborated = true; }
      else { out -= 0.06; conflict = true; }
    }
  }
  if (mods.country) {
    const cc = String(mods.country).toUpperCase().replace(/[^A-Z]/g, ' ').trim();
    const hay = [
      ...(record.addresses || []).map((a) => a.country || a.full || ''),
      ...(record.attributes || []).filter((a) => /nationalit|citizen/i.test(a.label)).map((a) => a.value),
    ].join(' ').toUpperCase();
    // Token-level match, not substring — "US" must not match inside "RUSSIA".
    // Prefix tolerance (≥4 chars) still links Russia ↔ Russian Federation.
    const hayTokens = hay.split(/[^A-Z]+/).filter(Boolean);
    const ccTokens = cc.split(/\s+/).filter(Boolean);
    const tokenHit = (q) => hayTokens.some((t) =>
      t === q || (q.length >= 4 && t.startsWith(q)) || (t.length >= 4 && q.startsWith(t)));
    if (hayTokens.length && ccTokens.length) {
      if (ccTokens.every(tokenHit)) { out = Math.min(1, out + 0.04); corroborated = true; }
      else { out -= 0.04; conflict = true; }
    }
  }
  return { score: Math.max(0, out), corroborated, conflict };
}

// Best name score across primary + aliases.
function matchName(query, record, floor, mods) {
  const qTokens = tokens(query);
  if (!qTokens.length) return null;
  const qNorm = qTokens.join(' ');
  let best = null;
  for (const cand of candidateNames(record)) {
    const cTokens = cand._o ? nameTokens(cand._o) : tokens(cand.name);
    if (!cTokens.length) continue;
    const cNorm = cTokens.join(' ');
    const isExact = cNorm === qNorm;
    let score = isExact ? 1 : Math.max(tokenSetScore(qTokens, cTokens), acronymScore(qTokens, cTokens));
    if (qTokens.length === 1 && WEAK_SINGLE_TOKENS.has(qTokens[0]) && !isExact) score = Math.min(score, 0.75);
    if (qTokens.length === 1 && cTokens.length > 1 && !isExact) score *= 0.9;
    if (cand.lowQuality) score *= 0.97; // OFAC low-quality alias: mild discount
    if (!best || score > best.score) {
      best = { score, isExact, matchedName: cand.name, onAlias: !cand.primary, aliasType: cand.type };
    }
  }
  if (!best) return null;
  const mod = applyModifiers(best.score, record, mods);
  if (mod.score < floor) return null;
  return {
    score: Number(mod.score.toFixed(4)),
    matchType: classifyName(mod.score, best.isExact, best.onAlias),
    matchedName: best.matchedName,
    matchedField: best.onAlias ? `alias (${best.aliasType})` : 'primary name',
    explain: best.isExact ? 'exact name match' : explainMatch(query, best.matchedName),
    corroborated: mod.corroborated,
    conflict: mod.conflict,
  };
}

// Top-level: best of identifier and name match.
function screenEntity(query, record, floor, mods) {
  const idm = matchIdentifier(query, record);
  const nm = matchName(query, record, floor, mods);
  if (idm && (!nm || idm.score >= nm.score)) return idm;
  return nm;
}

module.exports = { normalize, tokens, idKey, foldTranslit, jaroWinkler, metaphone, damerau, editSim, dice, jaccard3, tokenSim, setCorpus, idf, screenEntity, matchName, matchIdentifier };
