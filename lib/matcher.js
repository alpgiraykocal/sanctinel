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

const CORP_SUFFIXES = new Set([
  'LLC', 'INC', 'LTD', 'LIMITED', 'CO', 'CORP', 'CORPORATION', 'COMPANY',
  'SA', 'SAS', 'AG', 'GMBH', 'LLP', 'PLC', 'PVT', 'BV', 'NV', 'JSC', 'OJSC',
  'OAO', 'OOO', 'PJSC', 'PAO', 'AO', 'ZAO', 'SPA', 'SRL', 'SL', 'KG', 'AB', 'AS',
  'PT', 'PTE', 'SDN', 'BHD', 'DMCC', 'FZE', 'FZCO', 'GROUP', 'HOLDING',
  'HOLDINGS', 'TRADING', 'INTERNATIONAL', 'INTL',
]);

const WEAK_SINGLE_TOKENS = new Set([
  'ALI', 'MOHAMMED', 'MOHAMMAD', 'MUHAMMAD', 'AHMED', 'AHMAD', 'ABDUL',
  'ABDULLAH', 'HASSAN', 'HUSSEIN', 'HUSAIN', 'IBRAHIM', 'KHAN', 'SAID',
  'SAYED', 'AL', 'BIN', 'IBN', 'BINT', 'ABU', 'UM', 'EL', 'THE', 'AND', 'OF',
]);

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalize(raw) {
  if (!raw) return '';
  let s = stripDiacritics(String(raw)).toUpperCase();
  s = s.replace(/[^A-Z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function tokens(raw) {
  return normalize(raw).split(' ').filter((t) => t && !CORP_SUFFIXES.has(t));
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

// Soundex phonetic key — collapses spelling variants that sound alike
// (Mohammed/Muhammad, Smith/Smyth, Catherine/Katherine).
function soundex(s) {
  s = s.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const code = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = s[0];
  let prev = code[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = code[s[i]] || 0;
    if (c !== 0 && c !== prev) out += c;
    if (s[i] !== 'H' && s[i] !== 'W') prev = c;
  }
  return (out + '000').slice(0, 4);
}

// Levenshtein edit distance (iterative, O(a*b) with a single row).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
const editSim = (a, b) => (a.length || b.length ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1);

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

// Transliteration folding: canonicalize common romanization variants so that
// e.g. Kadyrov/Kadirov, Yousef/Yusuf, Phillip/Filip converge. Used only as an
// extra positive channel (never lowers a score).
function foldTranslit(t) {
  let s = t
    .replace(/SCH/g, 'S').replace(/PH/g, 'F').replace(/GH/g, 'G').replace(/KH/g, 'K')
    .replace(/TH/g, 'T').replace(/CK/g, 'K').replace(/CH/g, 'C').replace(/SH/g, 'S')
    .replace(/WR/g, 'R').replace(/QU/g, 'K').replace(/X/g, 'KS');
  s = s.replace(/(.)\1+/g, '$1');       // collapse doubled letters
  s = s.replace(/[HW]/g, '');           // drop weak/silent letters
  s = s.replace(/[EIYJ]/g, 'I').replace(/[OU]/g, 'U'); // vowel + y/j classes
  return s.replace(/[^A-Z0-9]/g, '');
}

// Multi-algorithm token similarity: Jaro-Winkler ∪ edit ∪ Dice ∪ phonetic ∪
// transliteration ∪ initial/abbreviation. Phonetic/translit boosts are gated on
// a base Jaro-Winkler so lossy folds can't match unrelated tokens.
function tokenSim(a, b) {
  if (a === b) return 1;
  // initial vs full name (J ↔ John)
  if ((a.length === 1 && b[0] === a) || (b.length === 1 && a[0] === b)) return 0.88;
  const jw = jaroWinkler(a, b);
  if (jw < 0.4 && Math.abs(a.length - b.length) > 3) return jw; // cheap reject
  let s = Math.max(jw, editSim(a, b), dice(a, b));
  // Phonetic/translit are BOOSTS gated on real string similarity — a loose gate
  // lets unrelated short tokens (XQZWV~XPO share a Soundex bucket at jw .56)
  // masquerade as strong matches.
  if (jw >= 0.7 && a.length >= 4 && b.length >= 4 && soundex(a) === soundex(b)) s = Math.max(s, 0.9);
  if (jw >= 0.6) s = Math.max(s, Math.min(0.95, jaroWinkler(foldTranslit(a), foldTranslit(b))));
  return s;
}

// Order-independent token-set score with greedy 1:1 assignment (no token reused)
// plus a whole-string channel. Coverage is over the QUERY tokens (subset queries
// like "ivanov" still match a full name), per screening's recall priority.
function tokenSetScore(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  const pairs = [];
  for (let i = 0; i < qTokens.length; i++)
    for (let j = 0; j < cTokens.length; j++)
      pairs.push([tokenSim(qTokens[i], cTokens[j]), i, j]);
  pairs.sort((x, y) => y[0] - x[0]);
  const qu = new Set(), cuSet = new Set();
  let sum = 0, matched = 0;
  const need = Math.min(qTokens.length, cTokens.length);
  for (const [sc, i, j] of pairs) {
    if (qu.has(i) || cuSet.has(j)) continue;
    qu.add(i); cuSet.add(j); sum += sc;
    if (++matched === need) break;
  }
  const tokenAvg = sum / qTokens.length;
  const qJoin = qTokens.join(''), cJoin = cTokens.join('');
  const whole = Math.max(jaroWinkler(qJoin, cJoin), dice(qJoin, cJoin));
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
    if (k === qk) return { score: 1, matchType: 'identifier', matchedName: id.value, matchedField: id.type };
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

module.exports = { normalize, tokens, idKey, jaroWinkler, soundex, editSim, dice, tokenSim, screenEntity, matchName, matchIdentifier };
