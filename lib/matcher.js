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

// NFD splits a Hangul syllable into jamo (로 → ㄹ+ㅗ) and those code points sit
// outside the syllable block the keep-class allows, so a decomposed Korean name
// was being deleted entirely. Recomposing with NFC puts the syllables back;
// Latin is unaffected (É → E either way), and kana keep their dakuten because
// U+3099/309A fall outside the combining range stripped here.
function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

// Fold Cyrillic letters that are visually identical to Latin ones to their Latin
// twin, defeating homoglyph evasion (e.g. "сompany" with a Cyrillic С).
// Applied ONLY to mixed-script tokens — see normalizeToken.
const HOMOGLYPHS = { 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's' };
function foldHomoglyphs(s) {
  return s.replace(/[АВЕКМНОРСТУХІЈЅавекмнорстухіјѕ]/g, (c) => HOMOGLYPHS[c] || c);
}

/*
 * Transliteration to Latin, per script.
 *
 * These exist because the ASCII fold below deletes anything outside [A-Z0-9],
 * and deleting a script is not a neutral act in screening: it silently turns a
 * designated party's own-script name into either nothing or — worse, once the
 * homoglyph fold has run over it — a short garbage string that collides with
 * other garbage. Real observed failure: ГУСЕВ folded to "YCEB", and "Сбербанк"
 * scored a perfect 1.00 against "Альфа-Банк" because both collapsed to noise.
 *
 * Cyrillic follows BGN/PCGN, which is what OFAC, the EU and the UK use when
 * they romanize Russian and Ukrainian names, so the transliterated form lands
 * on the same spelling as the list's own Latin entry (ГУСЕВ → GUSEV).
 */
const CYRILLIC_MAP = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z',
  И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R',
  С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS', Ч: 'CH', Ш: 'SH',
  Щ: 'SHCH', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'YU', Я: 'YA',
  // Ukrainian / Belarusian
  Ґ: 'G', Є: 'YE', І: 'I', Ї: 'YI', Ў: 'W',
  // Serbian / Macedonian
  Ђ: 'DJ', Ј: 'J', Љ: 'LJ', Њ: 'NJ', Ћ: 'C', Џ: 'DZ', Ѓ: 'G', Ќ: 'K', Ѕ: 'DZ',
};

const GREEK_MAP = {
  Α: 'A', Β: 'V', Γ: 'G', Δ: 'D', Ε: 'E', Ζ: 'Z', Η: 'I', Θ: 'TH', Ι: 'I',
  Κ: 'K', Λ: 'L', Μ: 'M', Ν: 'N', Ξ: 'X', Ο: 'O', Π: 'P', Ρ: 'R', Σ: 'S',
  Τ: 'T', Υ: 'Y', Φ: 'F', Χ: 'CH', Ψ: 'PS', Ω: 'O', Ϊ: 'I', Ϋ: 'Y', Σ: 'S',
};

/*
 * Arabic is consonantal — short vowels are diacritics that lists routinely omit,
 * so the romanized form is skeletal (مصرف → MSRF, not MASRAF). That is fine
 * here: foldTranslit already collapses vowels on both sides before comparison,
 * so the skeleton meets the list's own Latin spelling in the middle.
 */
const ARABIC_MAP = {
  ا: 'A', أ: 'A', إ: 'I', آ: 'A', ٱ: 'A', ب: 'B', ت: 'T', ث: 'TH', ج: 'J',
  ح: 'H', خ: 'KH', د: 'D', ذ: 'DH', ر: 'R', ز: 'Z', س: 'S', ش: 'SH', ص: 'S',
  ض: 'D', ط: 'T', ظ: 'Z', ع: '', غ: 'GH', ف: 'F', ق: 'Q', ك: 'K', ل: 'L',
  م: 'M', ن: 'N', ه: 'H', ة: 'H', و: 'W', ؤ: 'W', ي: 'Y', ى: 'A', ئ: 'Y',
  ء: '', پ: 'P', چ: 'CH', ژ: 'ZH', گ: 'G', ک: 'K', ی: 'Y',
};

/*
 * Hebrew, like Arabic, writes consonants and leaves the vowel points off in
 * practice, so this is a skeleton romanization that foldTranslit then meets
 * halfway (מאיר → MAYR, which collapses onto MEIR). Final-form letters map to
 * the same sound as their medial form.
 */
const HEBREW_MAP = {
  א: '', ב: 'V', ג: 'G', ד: 'D', ה: 'H', ו: 'V', ז: 'Z', ח: 'CH', ט: 'T',
  י: 'Y', כ: 'K', ך: 'K', ל: 'L', מ: 'M', ם: 'M', נ: 'N', ן: 'N', ס: 'S',
  ע: '', פ: 'P', ף: 'F', צ: 'TS', ץ: 'TS', ק: 'K', ר: 'R', ש: 'SH', ת: 'T',
};

function mapChars(s, table) {
  let out = '';
  for (const ch of s) out += (table[ch] !== undefined ? table[ch] : ch);
  return out;
}

const RE_LATIN = /[A-Za-z]/;
const RE_CYRILLIC = /[Ѐ-ӿ]/;
const RE_GREEK = /[Ͱ-Ͽ]/;
// Arabic block + Arabic Supplement + presentation forms, minus the harakat
// (short-vowel marks) which are stripped rather than mapped.
const RE_ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const RE_HARAKAT = /[ً-ٰٟۖ-ۭ]/g;
// Hebrew block + alphabetic presentation forms; niqqud (vowel points) are
// stripped rather than mapped, exactly as the harakat are for Arabic.
const RE_HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
const RE_NIQQUD = /[\u0591-\u05C7]/g;
// Han, kana and hangul: no romanization without a pronunciation dictionary, so
// these characters are KEPT and matched as characters (see the CJK note in
// normalize). Deleting them was why a Chinese-name query returned nothing.
const RE_CJK = /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/;
const CJK_CLASS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u309F\\u30A0-\\u30FF\\uAC00-\\uD7AF';
const RE_KEEP = new RegExp(`[^A-Z0-9${CJK_CLASS}]+`, 'g');
// Split where Latin/digits meet CJK, so "ABC中国" is two tokens not one.
const RE_CJK_BOUNDARY = new RegExp(`([${CJK_CLASS}])(?=[A-Z0-9])|([A-Z0-9])(?=[${CJK_CLASS}])`, 'g');

/*
 * Per-TOKEN script handling. The unit matters: doing this per string would mean
 * a name like "OOO Сбербанк" — Latin legal form, Cyrillic name — counts as
 * mixed-script and gets homoglyph-folded into garbage.
 *
 *   mixed Latin+Cyrillic in ONE token → homoglyph evasion ("сompany"), so fold
 *   wholly non-Latin token                → a real name in its own script, so transliterate
 *
 * Known limit: a Latin word disguised with an ALL-Cyrillic homoglyph run reads
 * as a genuine Cyrillic token and gets transliterated instead of recovered.
 * That is the deliberate trade — real Cyrillic names outnumber that case by
 * orders of magnitude, and foldTranslit's vowel collapse still blurs the two
 * forms together, whereas the old unconditional fold broke every Cyrillic name
 * in the list.
 */
function normalizeToken(tok) {
  // NFKC first, so compatibility spellings reach the maps below in their base
  // form: Arabic presentation forms (ﺻ → ص) otherwise miss every map entry and
  // get deleted, and it also folds full-width Latin and ligatures for free.
  tok = tok.normalize('NFKC');
  const hasCyr = RE_CYRILLIC.test(tok);
  if (hasCyr) tok = RE_LATIN.test(tok) ? foldHomoglyphs(tok) : mapChars(tok.toUpperCase(), CYRILLIC_MAP);
  // Greek accents ride on the vowels themselves (ά, ή, ώ), so they must come off
  // BEFORE the map or the accented vowel misses its entry and is dropped
  // outright. Cyrillic is the opposite — Ё and Й are their own entries and have
  // to be mapped before any decomposition splits them.
  if (RE_GREEK.test(tok)) tok = mapChars(stripDiacritics(tok).toUpperCase(), GREEK_MAP);
  if (RE_ARABIC.test(tok)) tok = mapChars(tok.replace(RE_HARAKAT, ''), ARABIC_MAP);
  if (RE_HEBREW.test(tok)) tok = mapChars(tok.replace(RE_NIQQUD, ''), HEBREW_MAP);
  return tok;
}

const RE_NON_ASCII = /[^\x00-\x7F]/;

function normalize(raw) {
  if (!raw) return '';
  let s = String(raw);
  // Fast path: pure ASCII needs none of the script machinery, and it is the
  // overwhelming majority of both queries and list names.
  if (RE_NON_ASCII.test(s)) {
    s = s.split(/(\s+)/).map((part) => (/\s/.test(part) ? part : normalizeToken(part))).join('');
  }
  s = stripDiacritics(s).toUpperCase();
  s = s.replace(RE_KEEP, ' ').replace(RE_CJK_BOUNDARY, '$1$2 ');
  return s.replace(/\s+/g, ' ').trim();
}

// Does this string carry a script we transliterate or match as characters?
// Used to decide whether a stored native-script name adds anything.
function hasNonLatinScript(s) {
  return !!s && (RE_CYRILLIC.test(s) || RE_GREEK.test(s) || RE_ARABIC.test(s) || RE_HEBREW.test(s) || RE_CJK.test(s));
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
function metaphoneRaw(str) {
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
//
// Three rolling rows rather than a full (al+1)×(bl+1) matrix. This is the most
// expensive primitive in the scorer — 13x the cost of Jaro-Winkler, and it runs
// for most of the ~170k token pairs a multi-word query generates — and almost
// all of that cost was allocating and garbage-collecting a fresh array-of-arrays
// per call. The transposition rule needs row i-2, hence three rows and not two.
const DAM_ROWS = [null, null, null]; // reused buffers, grown on demand
function damRow(k, size) {
  let r = DAM_ROWS[k];
  if (!r || r.length < size) { r = new Float64Array(size); DAM_ROWS[k] = r; }
  return r;
}

function damerau(a, b) {
  const al = a.length, bl = b.length;
  if (!al) return bl; if (!bl) return al;
  const w = bl + 1;
  let prev2 = damRow(0, w), prev = damRow(1, w), cur = damRow(2, w);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    const ca = a[i - 1];
    for (let j = 1; j <= bl; j++) {
      // Confusable substitutions (0↔O, 1↔L, C↔K, homoglyph digits) cost less
      // than a full substitution — a disguised character is nearly a match.
      const cb = b[j - 1];
      const cost = ca === cb ? 0 : (CONFUSABLE.has(ca + cb) ? 0.5 : 1);
      let v = prev[j] + 1;
      const ins = cur[j - 1] + 1; if (ins < v) v = ins;
      const sub = prev[j - 1] + cost; if (sub < v) v = sub;
      if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) {
        const tr = prev2[j - 2] + 1; if (tr < v) v = tr;
      }
      cur[j] = v;
    }
    const spare = prev2; prev2 = prev; prev = cur; cur = spare;
  }
  return prev[bl];
}
const editSim = (a, b) => (a.length || b.length ? 1 - damerau(a, b) / Math.max(a.length, b.length) : 1);

/*
 * Per-token derivations are memoized on the token string.
 *
 * The same tokens recur relentlessly across 38k records — BANK, TRADING, IVANOV,
 * the query's own tokens against every candidate — and profiling put a quarter
 * of all search time in rebuilding these from scratch on every comparison: the
 * padded trigram set for Jaccard alone was the single hottest frame. The caches
 * are flushed wholesale when they exceed the cap, which keeps the memory bounded
 * without pretending to be an LRU.
 */
const MEMO_CAP = 40000;
function memoizePerToken(fn) {
  const cache = new Map();
  return (s) => {
    let v = cache.get(s);
    if (v === undefined) {
      v = fn(s);
      if (cache.size >= MEMO_CAP) cache.clear();
      cache.set(s, v);
    }
    return v;
  };
}

// Bigrams, sorted, so Dice can intersect two cached arrays by merge instead of
// building a counting Map on every call.
const sortedBigrams = memoizePerToken((s) => {
  const g = [];
  for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
  return g.sort();
});

// Sørensen–Dice bigram coefficient — robust to insertions/reordering of chars.
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = sortedBigrams(a), B = sortedBigrams(b);
  let i = 0, j = 0, inter = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { inter++; i++; j++; }       // multiset intersection
    else if (A[i] < B[j]) i++;
    else j++;
  }
  return (2 * inter) / (A.length + B.length);
}

const paddedTrigrams = memoizePerToken((s) => {
  const p = '  ' + s + '  ';
  const g = new Set();
  for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3));
  return g;
});

// Trigram Jaccard (padded) — complements bigram Dice; stronger on longer strings.
function jaccard3(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = paddedTrigrams(a), B = paddedTrigrams(b);
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0; for (const g of small) if (large.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function foldTranslitRaw(t) {
  let s = t
    .replace(/SCH/g, 'S').replace(/PH/g, 'F').replace(/GH/g, 'G').replace(/KH/g, 'K')
    .replace(/TH/g, 'T').replace(/CK/g, 'K').replace(/CH/g, 'C').replace(/SH/g, 'S')
    .replace(/WR/g, 'R').replace(/QU/g, 'K').replace(/X/g, 'KS');
  s = s.replace(/(.)\1+/g, '$1');
  s = s.replace(/[HW]/g, '');
  s = s.replace(/[EIYJ]/g, 'I').replace(/[OU]/g, 'U');
  // Vowel folding can CREATE new runs (YOUSEF → IUUSIF), so collapse again —
  // otherwise the same name romanized two ways folds to different keys and the
  // pair stops sharing the trigrams the candidate index is built on.
  s = s.replace(/(.)\1+/g, '$1');
  return s.replace(/[^A-Z0-9]/g, '');
}
// Eleven regex passes per call, on tokens that repeat constantly — memoize.
const foldTranslit = memoizePerToken(foldTranslitRaw);
const metaphone = memoizePerToken(metaphoneRaw);

// Do two folded forms share at least one trigram? The transliteration boost is
// gated on this because it is exactly the signal lib/searchindex uses to build
// the candidate pool: a boost that fires without shared folded trigrams would
// score a hit the prefilter can never surface, so the same query would return
// different results on the fast and full paths.
function sharesFoldedGram(a, b) {
  // Folds shorter than a trigram carry no evidence: transliteration folding
  // collapses "HAAA" to "A", which would then "match" every other token that
  // folds to a single letter. Require both sides to survive the fold.
  if (a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  for (let i = 0; i <= a.length - 3; i++) if (b.includes(a.slice(i, i + 3))) return true;
  return false;
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
  let s = jw;
  // Each channel is skipped when its own upper bound cannot beat what we
  // already have. Both bounds are exact, so the result is unchanged — this only
  // avoids running the expensive channels on pairs they cannot win.
  //   edit  ≤ 1 − |Δlen|/maxLen   (an edit distance is at least the length gap)
  //   dice  ≤ 2·min(nb)/(nbA+nbB) (the bigram multiset intersection is at most
  //                                the smaller multiset)
  const la = a.length, lb = b.length;
  const maxL = la > lb ? la : lb;
  if (1 - Math.abs(la - lb) / maxL > s) { const e = editSim(a, b); if (e > s) s = e; }
  const nbA = la - 1, nbB = lb - 1;
  if (nbA > 0 && nbB > 0 && (2 * Math.min(nbA, nbB)) / (nbA + nbB) > s) {
    const d = dice(a, b); if (d > s) s = d;
  }
  const j3 = jaccard3(a, b); if (j3 > s) s = j3;
  if (jw >= 0.62 && a.length >= 4 && b.length >= 4) { const ma = metaphone(a); if (ma && ma === metaphone(b)) s = Math.max(s, 0.92); }
  if (jw >= 0.6) {
    const fa = foldTranslit(a), fb = foldTranslit(b);
    // Shared-gram gate: without it the boost fires on pairs that merely share a
    // prefix (MAERSK↔MASHREK, HUAWEI↔HUWAYZEH), manufacturing hits exactly at
    // the 0.95 default threshold that the candidate index cannot reproduce.
    if (sharesFoldedGram(fa, fb)) s = Math.max(s, Math.min(0.95, jaroWinkler(fa, fb)));
  }
  return s;
}

// IDF-weighted, order-independent token-set score with greedy 1:1 assignment
// (no token reused) plus a whole-string channel. Coverage is over the QUERY
// tokens, weighted so a match on a rare token counts more than on a common one.
/*
 * Scratch buffers for the assignment below. This function runs once per
 * candidate NAME — tens of thousands of times per query — and the previous
 * shape allocated one small array per token pair and then sorted them. Over a
 * three-word query that is ~170k throwaway arrays per search, which on a
 * throttled container costs more than the similarity maths it was sorting.
 */
const TS_MAX = 64;
const tsSim = new Float64Array(TS_MAX * TS_MAX);
const tsQUsed = new Uint8Array(TS_MAX);
const tsCUsed = new Uint8Array(TS_MAX);

function tokenSetScore(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  const Q = Math.min(qTokens.length, TS_MAX), C = Math.min(cTokens.length, TS_MAX);
  for (let i = 0; i < Q; i++) {
    for (let j = 0; j < C; j++) tsSim[i * TS_MAX + j] = tokenSim(qTokens[i], cTokens[j]);
    tsQUsed[i] = 0;
  }
  for (let j = 0; j < C; j++) tsCUsed[j] = 0;

  const w = qTokens.map(idf);
  let wsum = 0, matched = 0;
  const need = Math.min(Q, C);
  // Greedy 1:1 assignment, highest similarity first — the same selection the
  // sort produced, including its tie-break: scanning in row-major order takes
  // the earliest (i, j) among equals, which is what a stable sort left first.
  while (matched < need) {
    let best = -1, bi = -1, bj = -1;
    for (let i = 0; i < Q; i++) {
      if (tsQUsed[i]) continue;
      const row = i * TS_MAX;
      for (let j = 0; j < C; j++) {
        if (tsCUsed[j]) continue;
        const v = tsSim[row + j];
        if (v > best) { best = v; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    tsQUsed[bi] = 1; tsCUsed[bj] = 1;
    wsum += w[bi] * best;
    matched++;
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
// Memoized per record: this list is rebuilt for every entity scored on every
// query, and it is the same list every time.
const _candCache = new WeakMap();
function candidateNames(record) {
  const hit = _candCache.get(record);
  if (hit) return hit;
  const out = buildCandidateNames(record);
  _candCache.set(record, out);
  return out;
}

/*
 * Every name string this record can be matched on.
 *
 * Includes names[].native — the own-script form OFAC and OFSI publish alongside
 * the romanized one (ГУСЕВ, ДЕНИС ИГОРЕВИЧ next to GUSEV, Denis Igorevich).
 * 9k of these ship in the snapshot and none of them used to be searchable: they
 * were parsed, stored, rendered on the record card, and then never handed to
 * either the scorer or the index. A user pasting a name in its own script got
 * nothing back.
 *
 * Native forms are marked as aliases rather than primaries so a hit on one is
 * classified as an alias hit, and `_o` points at the candidate itself so
 * nameTokens can cache on a stable object (candidateNames is memoized per
 * record, so these objects live as long as the snapshot does).
 */
function buildCandidateNames(record) {
  const out = [];
  const pushNative = (n) => {
    if (!n || !n.native || !hasNonLatinScript(n.native)) return;
    const c = { name: n.native, primary: false, type: `${n.type || 'A.K.A.'} (native script)`, lowQuality: !!n.lowQuality, _o: null };
    c._o = c;
    out.push(c);
  };
  if (record.names && record.names.length) {
    for (const n of record.names) {
      if (typeof n === 'string') out.push({ name: n, primary: false, type: 'A.K.A.', _o: null });
      else { out.push({ name: n.name, primary: !!n.primary, type: n.type || 'A.K.A.', lowQuality: !!n.lowQuality, _o: n }); pushNative(n); }
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

// The same name surface as a plain string list, for the index and the IDF
// corpus. Both MUST see exactly what the scorer sees, or the prefilter drops
// candidates the scorer would have matched (a silent false negative) and the
// corpus mis-weights tokens the scorer actually uses.
function searchableNames(record) {
  return candidateNames(record).map((c) => c.name).filter(Boolean);
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
    // Single-token query against a multi-token name: an EXACT token hit (the
    // classic surname search, e.g. "abramovich") lands at 0.96 — above the
    // 0.95 default, below a full-name match for ranking. Fuzzy single-token
    // hits keep the 0.9 damping so partial noise stays below the line.
    if (qTokens.length === 1 && cTokens.length > 1 && !isExact) score = score >= 0.999 ? 0.96 : score * 0.9;
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

module.exports = { normalize, tokens, idKey, foldTranslit, sharesFoldedGram, jaroWinkler, metaphone, damerau, editSim, dice, jaccard3, tokenSim, setCorpus, idf, screenEntity, matchName, matchIdentifier, searchableNames, hasNonLatinScript };
