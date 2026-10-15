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
const { countryCodes, expandCode, countryCodeInText } = require('./countries');
const { attributeKind, isRefuted } = require('./vocab');
const { parseDateValue, intervalCoversYear } = require('./dates');
/*
 * Arabic name particles and honorifics, on top of the generated data.
 *
 * rigour's tables are built for organisation names, so they strip the article
 * AL but not its other romanization EL, and know ABDUL but not ABD / ABDEL /
 * ABDOUL. The same person was therefore a different set of tokens depending on
 * which authority wrote the name: "EL-FREIJ" scored 0.885 against "AL-FREIJ",
 * "Abd al-Ghafur" did not meet "Abdul Ghafur". And the religious honorifics
 * that precede a name the way "Mr" does — Haji, Sheikh, Mullah, Maulavi — were
 * not titles, so "Haji Khaled Nasri" carried one unmatched token against the
 * listed "Khaled Nasri" and fell below the line. Measured with
 * scripts/eval-matching.js; these close each of those misses.
 */
const STRIP = new Set([...MATCH.strip, 'EL']);
const CANON = Object.assign({}, MATCH.canon || {}, { ABD: 'abdul', ABDEL: 'abdul', ABDOUL: 'abdul', ABDOL: 'abdul', ABDUL: 'abdul' });
// rigour folds every spelling of PUTIN into a Ukrainian insult. Harmless to the
// arithmetic, but the canonical token is what a match explanation shows, and a
// compliance tool cannot print that next to a screening result.
for (const k of Object.keys(CANON)) if (CANON[k] === 'khuylo') delete CANON[k];
const HONORIFICS = ['HAJI', 'HAJJI', 'HADJI', 'ALHAJI', 'ALHAJ', 'SHEIKH', 'SHEIK', 'SHAIKH', 'SHAYKH', 'SHEIKHA',
  'MULLAH', 'MULLA', 'MAULANA', 'MAULAVI', 'MAWLAWI', 'MAWLAVI', 'MOLVI', 'QARI'].map((t) => [t]);
const TITLES = (MATCH.titles || []).concat(HONORIFICS).sort((a, b) => b.length - a.length); // longest first
const RANKS = ['GENERAL', 'COLONEL', 'MAJOR GENERAL', 'BRIGADIER GENERAL', 'LIEUTENANT GENERAL', 'LIEUTENANT COLONEL',
  'BRIGADIER', 'ADMIRAL', 'VICE ADMIRAL', 'REAR ADMIRAL', 'CAPTAIN', 'COMMANDER', 'GEN', 'COL', 'BRIG', 'ADM']
  .map((t) => t.split(' '));
const PERSON_TITLES = TITLES.concat(RANKS).sort((a, b) => b.length - a.length);

/*
 * A person's name is not read like a company's.
 *
 * STRIP is rigour's list of organisation descriptors and legal forms in every
 * language, and many of its short entries are also among the most common
 * syllables of Asian and Arabic personal names: SA, MA, YU, HAN, SOE, ONG, IM,
 * DO, SHA, NA, TA. Applied to an individual's name, "Soe Win" became the single
 * token WIN — and a one-word query that hits a word of a longer name exactly is
 * the surname rule (0.96), so a search for Soe Win alerted on every listed
 * "… Win". 4.4% of the individuals' names lost a token this way.
 *
 * So individuals are read with their own, much shorter, list: name particles
 * that carry no identity (al-, el-, de, da, la, …) and lone initials, which the
 * organisation list strips too. Every other word of a person's name stays a
 * word. lib/searchindex and the corpus IDF tokenize each record the way it is
 * scored (nameKinds), and score queries both ways.
 */
const PERSON_STRIP = new Set(['AL', 'EL', 'DE', 'DA', 'DI', 'DEL', 'DELLA', 'DELA', 'DER', 'DES', 'DOS', 'DAS', 'LA', 'LAS', 'LOS', 'Y',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
const ORG_READING = [false], PERSON_READING = [true], BOTH_READINGS = [false, true];
// Which reading(s) a record's names take. A record of unknown kind — BIS and
// other CSL lists publish "Listed party" — is read both ways.
function nameKinds(record) {
  const t = String((record && record.type) || '');
  if (/individual|person/i.test(t)) return PERSON_READING;
  if (/entity|vessel|aircraft|organi[sz]ation|company/i.test(t)) return ORG_READING;
  return BOTH_READINGS;
}
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
function stripTitles(arr, person = false) {
  for (const t of person ? PERSON_TITLES : TITLES) {
    if (arr.length > t.length && t.every((w, i) => arr[i] === w)) return arr.slice(t.length);
  }
  return arr;
}

function tokens(raw, person = false) {
  const all = stripTitles(normalize(raw).split(' ').filter(Boolean), person);
  const drop = person ? PERSON_STRIP : STRIP;
  const kept = all.filter((t) => !drop.has(t)).map((t) => (CANON[t] ? CANON[t].toUpperCase() : t));
  return kept.length ? kept : all; // never strip a name down to nothing
}

/*
 * Descriptor words are stripped only when spelled exactly, so a typo in one —
 * "Tradng" for TRADING, "Limted" for LIMITED — stayed in the query as a token
 * nothing could match, and dragged an otherwise exact name from 1.00 to 0.78,
 * under the default threshold. A false negative from a typo in the least
 * important word of the query.
 *
 * Fixed on the QUERY side only, and as an extra variant rather than a
 * replacement: a query token one edit away from a descriptor yields a second
 * token list without it, every record is scored against both, and the higher
 * score wins. No score can go down, and list names are untouched — stripping
 * "near-descriptors" from published names would delete real name tokens.
 * lib/searchindex takes the union of both variants' candidates, which keeps
 * the recall invariant.
 */
const STRIP_BY_LEN = new Map();
for (const w of STRIP) {
  if (w.length < 5) continue;
  if (!STRIP_BY_LEN.has(w.length)) STRIP_BY_LEN.set(w.length, []);
  STRIP_BY_LEN.get(w.length).push(w);
}
const _nearDesc = new Map();
function nearDescriptor(t) {
  if (t.length < 5 || STRIP.has(t)) return false;
  /*
   * A token the listed names themselves use is a name, however close it is to
   * a descriptor: USAMA, ANSAR, ZVEZDA, RUSSIA are each one edit from one, and
   * dropping them from "Usama bin Ladin" or "Ansar al-Islam" would leave a
   * query that matches half a family or half a programme. Only a token no
   * listed name contains — "TRADNG" — is read as a typo. Measured over every
   * listed name used as a query: 2.6% triggered the variant without this
   * check, nearly all of them on real name tokens.
   */
  if (CORPUS_N && CORPUS_DF.get(t)) return false;
  let hit = _nearDesc.get(t);
  if (hit !== undefined) return hit;
  hit = false;
  for (let len = t.length - 1; len <= t.length + 1 && !hit; len++) {
    for (const w of STRIP_BY_LEN.get(len) || []) {
      if (w[0] === t[0] && damerau(t, w) <= 1) { hit = true; break; }
    }
  }
  if (_nearDesc.size > 20000) _nearDesc.clear();
  _nearDesc.set(t, hit);
  return hit;
}

/*
 * The same problem one step later: a typo in a word that CANON rewrites.
 * "TEHCNOLOGY" stays a token of its own while every listed TECHNOLOGY has
 * become TECH, and "Plent" stays while PLANT has become FACTORY — so a
 * one-letter slip in a word canonicalization exists to neutralise cost a whole
 * token (ANWEN TEHCNOLOGY scored 0.92 against ANWEN TECHNOLOGY). A query token
 * that no listed name contains and that is one edit from a CANON key, same
 * first letter, is read as that key. Query side only and as an extra variant,
 * like nearDescriptor: no score can go down.
 */
const CANON_BY_LEN = new Map();
for (const k of Object.keys(CANON)) {
  if (k.length < 5 || !/^[A-Z]+$/.test(k)) continue;
  if (!CANON_BY_LEN.has(k.length)) CANON_BY_LEN.set(k.length, []);
  CANON_BY_LEN.get(k.length).push(k);
}
const _nearCanon = new Map();
function nearCanon(t) {
  if (t.length < 5 || CANON[t] || STRIP.has(t) || (CORPUS_N && CORPUS_DF.get(t))) return null;
  let hit = _nearCanon.get(t);
  if (hit !== undefined) return hit;
  hit = null;
  for (let len = t.length - 1; len <= t.length + 1 && !hit; len++) {
    for (const k of CANON_BY_LEN.get(len) || []) {
      if (k[0] === t[0] && damerau(t, k) <= 1) { hit = CANON[k].toUpperCase(); break; }
    }
  }
  if (_nearCanon.size > 20000) _nearCanon.clear();
  _nearCanon.set(t, hit);
  return hit;
}

// The token lists a query is scored as: always tokens(query), plus the same
// with near-CANON typos read as the canonical word, and (organisation reading
// only) without near-descriptor typos, when either differs and leaves something.
const _qvCache = new Map();
function queryVariants(raw, person = false) {
  const text = String(raw == null ? '' : raw);
  const key = (person ? 'P' : 'O') + text;
  let v = _qvCache.get(key);
  if (v) return v;
  const full = tokens(text, person);
  const fixed = full.map((t) => nearCanon(t) || t);
  const canonFixed = fixed.some((t, i) => t !== full[i]);
  const lean = person ? fixed : fixed.filter((t) => !nearDescriptor(t));
  v = [full];
  if (canonFixed) v.push(fixed);
  if (lean.length && lean.length < fixed.length) v.push(lean);
  if (_qvCache.size > 500) _qvCache.delete(_qvCache.keys().next().value);
  _qvCache.set(key, v);
  return v;
}

// Alphanumeric-only key for identifier comparison (case/space/punct-insensitive).
function idKey(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Match flags for jaroWinkler, reused across calls: it runs millions of times
// per busy minute, and two fresh arrays per call were a steady stream of garbage.
let JW_A = new Uint8Array(64), JW_B = new Uint8Array(64);
function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  if (JW_A.length < a.length) JW_A = new Uint8Array(a.length * 2);
  if (JW_B.length < b.length) JW_B = new Uint8Array(b.length * 2);
  const aMatch = JW_A.fill(0, 0, a.length), bMatch = JW_B.fill(0, 0, b.length);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = 1; bMatch[j] = 1; matches++; break;
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
function sortedBigramsRaw(s) {
  const g = [];
  for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
  return g.sort();
}
const sortedBigrams = memoizePerToken(sortedBigramsRaw);

// Sørensen–Dice bigram coefficient — robust to insertions/reordering of chars.
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  return diceOf(sortedBigrams(a), sortedBigrams(b));
}
function diceOf(A, B) {
  let i = 0, j = 0, inter = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { inter++; i++; j++; }       // multiset intersection
    else if (A[i] < B[j]) i++;
    else j++;
  }
  return (2 * inter) / (A.length + B.length);
}

function paddedTrigramsRaw(s) {
  const p = '  ' + s + '  ';
  const g = new Set();
  for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3));
  return g;
}
const paddedTrigrams = memoizePerToken(paddedTrigramsRaw);

// Trigram Jaccard (padded) — complements bigram Dice; stronger on longer strings.
function jaccard3(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  return jaccardOf(paddedTrigrams(a), paddedTrigrams(b));
}
function jaccardOf(A, B) {
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0; for (const g of small) if (large.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function foldTranslitRaw(t) {
  // Ч as German (TSCH), French (TCH) and Swedish (TJ) write it, which the EU
  // publishes alongside the English CH (SETJIN / SECHIN); Swedish SJ for Ш;
  // DZH and DJ for the J of Dzhabir / Djamal / Jabir.
  let s = t
    .replace(/TSCH/g, 'C').replace(/TCH/g, 'C').replace(/TJ/g, 'C').replace(/SJ/g, 'S')
    .replace(/DZH/g, 'J').replace(/DJ/g, 'J')
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


/*
 * Per-RECORD derivations, cached with a ceiling.
 *
 * An unbounded WeakMap is right for the ~4,000 candidates a normal query
 * scores, and wrong for a below-threshold query, which scores all 38,000: the
 * cache then holds a derivation for every record in the list and never gives it
 * back. Three of these together added 46MB of permanently retained heap after a
 * single full scan, which on a 512MB instance is the difference between serving
 * and being OOM-killed.
 *
 * So the same trade the per-token memoization above makes — a cap, flushed
 * wholesale rather than pretending to be an LRU. The WeakMap is replaced rather
 * than cleared so a snapshot refresh cannot leave the previous generation of
 * records pinned by their own cache.
 */
const RECORD_CACHE_CAP = 12000;
function boundedRecordCache() {
  let map = new WeakMap();
  let size = 0;
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      if (++size > RECORD_CACHE_CAP) { map = new WeakMap(); size = 1; }
      map.set(k, v);
      return v;
    },
  };
}

// ---- corpus term weighting (IDF) ----
// Rare tokens (a distinctive surname) carry far more identifying signal than
// common ones (COMPANY, TRADING, MOHAMMED, AL). Weighting token matches by
// inverse document frequency across the whole list is the standard professional
// way to raise precision without a hand-maintained stopword list.
let CORPUS_N = 0;
const CORPUS_DF = new Map();
function setCorpus(dfMap, n) {
  CORPUS_DF.clear(); if (dfMap) for (const [k, v] of dfMap) CORPUS_DF.set(k, v); CORPUS_N = n || 0;
  // What counts as a typo depends on the corpus (nearDescriptor).
  _nearDesc.clear(); _nearCanon.clear(); _qvCache.clear();
}
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
  if (s < 0.95) {
    /*
     * One slip of the keyboard. Jaro-Winkler punishes a swapped pair or a
     * wrong letter in a short token far harder than a reader would: MOHNEN
     * for MOHSEN is 0.94, ZHNAG for ZHANG 0.93, NEAV for NEVA 0.93 — each
     * enough to sink an otherwise exact two-word name under the default line.
     * A single substitution, insertion or deletion past the first letter of a
     * token of six or more is a typo, scored 0.95. An adjacent swap is the
     * most common typo of all and is unambiguous from four letters, but those
     * short swaps share no trigram, so lib/searchindex could not reproduce a
     * one-token hit on them: they get 0.94, which lifts a multi-word name over
     * the line (its other words put it in the candidate pool) and cannot carry
     * a one-word query over it alone.
     */
    if (a[0] === b[0] && Math.abs(la - lb) <= 1) {
      const minL = la < lb ? la : lb;
      if (minL >= 4 && la === lb && isAdjacentSwap(a, b)) s = Math.max(s, minL >= 6 ? 0.95 : 0.94);
      else if (minL >= 6 && damerau(a, b) <= 1) s = 0.95;
    }
    /*
     * The article written onto the word: ALSHAWAKH for AL-SHAWAKH, ELFITOURI
     * for EL-FITOURI. The detached article is stripped as a token, the attached
     * one was not, so the same surname compared as two different words.
     */
    const ra = articleRest(a), rb = articleRest(b);
    if (ra || rb) { const r = tokenSim(ra || a, rb || b); if (r * 0.98 > s) s = r * 0.98; }
  }
  return s;
}

function isAdjacentSwap(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

// "ALSHAWAKH" → "SHAWAKH": the rest of a token that begins with an attached
// Arabic article, when enough is left to be a name; '' otherwise.
function articleRest(t) {
  return t.length >= 6 && (t[0] === 'A' || t[0] === 'E') && t[1] === 'L' && !/[AEIOU]/.test(t[2]) ? t.slice(2) : '';
}

/*
 * Pair memo for the two scoring kernels that dominate a search.
 *
 * Both are pure functions of their two strings. A query screens ~3,000
 * candidate names, and their tokens repeat relentlessly — MUHAMMAD, ALI, BANK,
 * TRADING — so the same (query token, candidate token) pair used to be scored
 * hundreds of times per search; profiling put 80% of search CPU there. Keyed
 * query-side first, so a search's few query tokens each own one inner map and
 * a lookup is two Map hits with no string concatenation. Flushed wholesale past
 * the cap, like memoizePerToken: bounded memory without pretending to be an LRU.
 * The result is the value the kernel would have returned, so scores are
 * bit-for-bit unchanged.
 */
const PAIR_CAP = 150000;
function memoizePair(fn) {
  let rows = new Map(), size = 0;
  return (a, b) => {
    let row = rows.get(a);
    if (row === undefined) { row = new Map(); rows.set(a, row); }
    let v = row.get(b);
    if (v === undefined) {
      v = fn(a, b);
      if (++size > PAIR_CAP) { rows = new Map([[a, row = new Map()]]); size = 1; }
      row.set(b, v);
    }
    return v;
  };
}
const tokenSimPair = memoizePair(tokenSim);
/*
 * The whole-string channel compares the query joined into one string with a
 * candidate name joined the same way. The query side repeats on every call and
 * goes through the per-token memos; the candidate side almost never repeats, so
 * its grams are built directly — routing whole names through memoizePerToken
 * flushed the per-token caches every few searches and filled them with strings
 * nothing would ask for again. Same arithmetic as dice/jaccard3, edge cases
 * included.
 */
const wholeSim = memoizePair((q, c) => {
  const jw = jaroWinkler(q, c);
  if (q === c) return Math.max(jw, 1, 1);
  if (q.length < 2 || c.length < 2) return Math.max(jw, 0, 0);
  return Math.max(jw, diceOf(sortedBigrams(q), sortedBigramsRaw(c)), jaccardOf(paddedTrigrams(q), paddedTrigramsRaw(c)));
});

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
  const tokenAvg = tokenAvgScore(qTokens, cTokens);
  return wholeBlend(tokenAvg, qTokens, cTokens);
}

// The whole-string channel can only lift the token average to the midpoint
// between it and 1, so this bounds tokenSetScore from above without computing
// the whole-string similarity — which is the expensive half (see bestNameFor).
function wholeBlend(tokenAvg, qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  const whole = wholeSim(qTokens.join(''), cTokens.join(''));
  return Math.max(tokenAvg, 0.5 * tokenAvg + 0.5 * whole);
}

function tokenAvgScore(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  const Q = Math.min(qTokens.length, TS_MAX), C = Math.min(cTokens.length, TS_MAX);
  for (let i = 0; i < Q; i++) {
    for (let j = 0; j < C; j++) tsSim[i * TS_MAX + j] = tokenSimPair(qTokens[i], cTokens[j]);
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
  return wtot ? wsum / wtot : 0;
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
function explainMatch(qTokens, cTokens) {
  const q = qTokens, c = cTokens;
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
const _tokCacheP = new WeakMap();
function nameTokens(o, person = false) {
  const cache = person ? _tokCacheP : _tokCache;
  let t = cache.get(o);
  if (!t) { t = tokens(o.name || '', person); cache.set(o, t); }
  return t;
}
function idKeyCached(o) { let k = _idkCache.get(o); if (k === undefined) { k = idKey(o.value); _idkCache.set(o, k); } return k; }

// Candidate names as {name, primary, type, lowQuality, _o} where _o is the
// stable source object (or null for legacy string aliases → no token caching).
// Memoized per record: this list is rebuilt for every entity scored on every
// query, and it is the same list every time.
const _candCache = boundedRecordCache();
function candidateNames(record) {
  const hit = _candCache.get(record);
  if (hit) return hit;
  return _candCache.set(record, buildCandidateNames(record));
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
    if (k === qk) {
      // A document the source itself marks invalid, expired, revoked or false
      // still belongs to the listed party — it is often exactly the one they
      // travel on — so it still matches, but the verdict says what it is.
      const caveat = id.status ? ` (document ${id.status} per the source)` : '';
      return { score: 1, matchType: 'identifier', matchedName: id.value, matchedField: id.type, explain: `exact ${id.type} identifier match${caveat}` };
    }
  }
  return null;
}

/*
 * Every jurisdiction this record names, as ISO-3166 codes.
 *
 * Fed by address.country, the nationality/citizenship attributes, and — only
 * where the publisher left `country` empty — the jurisdiction named in the
 * address line itself. That last one is not optional: 3,582 addresses in the
 * snapshot say "Located in Syria" with no country field, and the string
 * comparison this replaces did read them.
 *
 * Cached on the record object, which lives as long as the snapshot: the codes
 * are a pure function of published fields and this runs once per candidate per
 * query otherwise.
 */
const _ccCache = boundedRecordCache();
function recordCountryCodes(record) {
  let set = _ccCache.get(record);
  if (set) return set;
  set = new Set();
  const addCode = (c) => { if (c) for (const x of expandCode(c)) set.add(x); };
  const add = (raw) => { for (const c of countryCodes(raw)) addCode(c); };
  for (const a of record.addresses || []) {
    if (a.country) add(a.country);
    else addCode(countryCodeInText(a.full));
  }
  for (const a of record.attributes || []) {
    if (isRefuted(a)) continue;
    const kind = kindOf(a);
    if (kind === 'nationality' || kind === 'citizenship') add(a.value);
  }
  return _ccCache.set(record, set);
}

/*
 * The canonical kind of an attribute, from the snapshot if lib/ingest annotated
 * it and derived on the spot if not.
 *
 * The fallback is what lets this module stay usable on a bare record — the
 * conformance fixtures ship `{label, value}` pairs precisely so the Swift port
 * has to derive the kind through its own code rather than being handed the
 * answer.
 */
function kindOf(attr) {
  return attr.kind || attributeKind(attr.label);
}

/*
 * Every birth date this record states, as inclusive intervals.
 *
 * Replaces pulling `\b(19|20)\d\d\b` out of the raw string and testing the
 * user's year for membership in that list. On a stated range — OFAC publishes
 * 179 of them, "1975 to 1979" — the years list held only the two endpoints, so
 * a subject born in 1977, inside the range the list itself gives, was scored as
 * CONTRADICTING the hit and penalized for it.
 *
 * Also narrower than the old `/birth|born|dob/i` label test, which matched
 * "Place of Birth" as well and would read a year out of a birthplace.
 */
const _dobCache = boundedRecordCache();
function recordBirthIntervals(record) {
  let out = _dobCache.get(record);
  if (out) return out;
  out = [];
  for (const a of record.attributes || []) {
    if (kindOf(a) !== 'dob' || isRefuted(a)) continue;
    const interval = a.date || parseDateValue(a.value);
    if (interval) out.push(interval);
  }
  return _dobCache.set(record, out);
}

// Secondary-identifier corroboration. Provided year-of-birth / country either
// confirm a fuzzy name hit (small boost) or contradict it (small penalty) — the
// standard "use secondary identifiers as score modifiers" screening control.
function applyModifiers(score, record, mods) {
  if (!mods || (!mods.yob && !mods.country)) return { score, corroborated: false, conflict: false };
  let out = score, corroborated = false, conflict = false;
  if (mods.yob) {
    const intervals = recordBirthIntervals(record);
    if (intervals.length) {
      // Any-of: several stated birth dates are alternatives the publisher could
      // not decide between, not a set the subject must satisfy all of.
      if (intervals.some((iv) => intervalCoversYear(iv, mods.yob))) { out = Math.min(1, out + 0.05); corroborated = true; }
      else { out -= 0.06; conflict = true; }
    }
  }
  if (mods.country) {
    /*
     * Code comparison first. "North Korea", "Korea, North", "DPRK" and
     * "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" are one jurisdiction written four
     * ways across four authorities, and the string comparison below scored the
     * first against the last as a CONFLICT — a corroborating identifier taken as
     * a contradicting one, on the party type that most often carries several
     * spellings at once.
     *
     * Any-of, not all-of: a party with addresses in three countries is
     * corroborated by naming one of them, which is also what the string path
     * did (its haystack pooled every address together).
     */
    const qCodes = countryCodes(mods.country).flatMap(expandCode);
    const rCodes = recordCountryCodes(record);
    if (qCodes.length && rCodes.size) {
      if (qCodes.some((c) => rCodes.has(c))) { out = Math.min(1, out + 0.04); corroborated = true; }
      else { out -= 0.04; conflict = true; }
      return { score: Math.max(0, out), corroborated, conflict };
    }
    // Neither side resolved to a known jurisdiction — a region, a disputed
    // territory, a source's placeholder. Fall back to the string comparison
    // rather than silently declining to check.
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
// The most applyModifiers can add: +0.05 for a corroborating year of birth and
// +0.04 for a corroborating country. A name whose best possible score is below
// the floor by more than this cannot be lifted over it.
const MAX_MOD_LIFT = 0.09;

function matchName(query, record, floor, mods) {
  let best = null;
  const cut = Number.isFinite(floor)
    ? floor - (mods && (mods.yob || mods.country) ? MAX_MOD_LIFT : 0) - 1e-9 : -Infinity;
  for (const person of nameKinds(record)) {
    for (const qTokens of queryVariants(query, person)) {
      const b = bestNameFor(qTokens, record, cut, person);
      if (b && (!best || b.score > best.score)) best = b;
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
    explain: best.isExact ? 'exact name match' : explainMatch(best.qTokens, best.cTokens),
    corroborated: mod.corroborated,
    conflict: mod.conflict,
  };
}

/*
 * The best-scoring name on the record for one token list of the query.
 *
 * `cut` skips names that provably cannot matter: ones whose best possible score
 * is below the cut (they would end below the floor whatever the modifiers do)
 * or no better than the name already held (the strict > below would not take
 * them). The bound replaces the whole-string channel with its maximum, 1, and
 * every adjustment after it is monotone, so a skipped name is exactly one the
 * full computation would have discarded. Most candidates the index proposes are
 * like that, and the whole-string channel was half of all scoring time.
 */
function bestNameFor(qTokens, record, cut = -Infinity, person = false) {
  if (!qTokens.length) return null;
  const qNorm = qTokens.join(' ');
  let best = null;
  for (const cand of candidateNames(record)) {
    const cTokens = cand._o ? nameTokens(cand._o, person) : tokens(cand.name, person);
    if (!cTokens.length) continue;
    const cNorm = cTokens.join(' ');
    const isExact = cNorm === qNorm;
    let score, q = qTokens, c = cTokens;
    if (isExact) score = 1;
    else {
      let tokenAvg = tokenAvgScore(qTokens, cTokens);
      if (qTokens.length !== cTokens.length) {
        const sp = respace(qTokens, cTokens);
        if (sp) {
          const alt = SPACING_FACTOR * tokenAvgScore(sp[0], sp[1]);
          if (alt > tokenAvg) { tokenAvg = alt; q = sp[0]; c = sp[1]; }
        }
      }
      const acr = acronymScore(qTokens, cTokens);
      const bound = adjustNameScore(Math.max(0.5 * tokenAvg + 0.5, acr), q, c, false, cand);
      if (bound < cut || (best && bound <= best.score)) continue;
      score = Math.max(wholeBlend(tokenAvg, q, c), acr);
    }
    score = adjustNameScore(score, q, c, isExact, cand);
    if (!best || score > best.score) {
      best = { score, isExact, matchedName: cand.name, onAlias: !cand.primary, aliasType: cand.type, qTokens: q, cTokens: c };
    }
  }
  return best;
}

/*
 * Word spacing. Romanized names are written run together or apart with no
 * agreement between authorities — ABDULRAHMAN / ABDUL RAHMAN, ALEKSANDR typed
 * as ALEK SANDR, SHAHID ULLAH / SHAHIDULLAH — and the token pairing could only
 * set one word against one word: "ERMAKOV Alek sandr" scored 0.815 against
 * ERMAKOV ALEKSANDR. When the two sides have different word counts, adjacent
 * words on either side whose concatenation IS a word on the other side are
 * joined and the pair is scored again; the better score is kept, at 0.99 of
 * itself so a spacing difference never outranks the name as written. The
 * joined string is unchanged, so lib/searchindex (trigrams of the joined
 * tokens) proposes the record either way.
 */
const SPACING_FACTOR = 0.99;
function joinAdjacent(side, other) {
  let out = side;
  for (let i = 0; i + 1 < out.length; i++) {
    const x = out[i], y = out[i + 1], len = x.length + y.length;
    for (const o of other) {
      if (o.length === len && o.startsWith(x) && o.endsWith(y)) { out = out.slice(0, i).concat(o, out.slice(i + 2)); break; }
    }
  }
  return out;
}
function respace(qTokens, cTokens) {
  const q = joinAdjacent(qTokens, cTokens);
  const c = joinAdjacent(cTokens, q);
  return q === qTokens && c === cTokens ? null : [q, c];
}

// Every adjustment here is monotone in `score`, which bestNameFor relies on.
function adjustNameScore(score, qTokens, cTokens, isExact, cand) {
  if (qTokens.length === 1 && WEAK_SINGLE_TOKENS.has(qTokens[0]) && !isExact) score = Math.min(score, 0.75);
  // Single-token query against a multi-token name: an EXACT token hit (the
  // classic surname search, e.g. "abramovich") lands at 0.96 — above the
  // 0.95 default, below a full-name match for ranking. Fuzzy single-token
  // hits keep the 0.9 damping so partial noise stays below the line.
  if (qTokens.length === 1 && cTokens.length > 1 && !isExact) score = score >= 0.999 ? 0.96 : score * 0.9;
  if (cand.lowQuality) score *= 0.97; // OFAC low-quality alias: mild discount
  return score;
}

// Top-level: best of identifier and name match.
function screenEntity(query, record, floor, mods) {
  const idm = matchIdentifier(query, record);
  const nm = matchName(query, record, floor, mods);
  if (idm && (!nm || idm.score >= nm.score)) return idm;
  return nm;
}

module.exports = { normalize, tokens, nameKinds, queryVariants, nearDescriptor, idKey, foldTranslit, foldTranslitRaw, sharesFoldedGram, jaroWinkler, metaphone, damerau, editSim, dice, jaccard3, tokenSim, setCorpus, idf, screenEntity, matchName, matchIdentifier, searchableNames, hasNonLatinScript };
