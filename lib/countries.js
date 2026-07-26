'use strict';

/*
 * Country normalization for cross-authority aggregation.
 *
 * Each source writes jurisdictions its own way: OFAC "Korea, North", the EU
 * "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF", BIS bare ISO alpha-2 codes ("KP"),
 * UK OFSI multi-nationality strings like "(1) Russia. (2) Ukraine". Counting
 * those verbatim splits one country across four rows and understates every one
 * of them, so a statistic would contradict the underlying list.
 *
 * This is a DISPLAY-side normalization for aggregate counts only — the entity
 * records and anything screening touches keep the authority's own wording.
 */

const ISO2 = {
  AE: 'United Arab Emirates', AF: 'Afghanistan', AL: 'Albania', AM: 'Armenia', AR: 'Argentina',
  AT: 'Austria', AU: 'Australia', AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BD: 'Bangladesh',
  BE: 'Belgium', BG: 'Bulgaria', BH: 'Bahrain', BO: 'Bolivia', BR: 'Brazil', BS: 'Bahamas',
  BY: 'Belarus', BZ: 'Belize', CA: 'Canada', CD: 'DR Congo', CF: 'Central African Republic',
  CH: 'Switzerland', CI: "Côte d'Ivoire", CL: 'Chile', CM: 'Cameroon', CN: 'China', CO: 'Colombia',
  CR: 'Costa Rica', CU: 'Cuba', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark',
  DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', ER: 'Eritrea',
  ES: 'Spain', ET: 'Ethiopia', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GE: 'Georgia',
  GM: 'Gambia', GR: 'Greece', GT: 'Guatemala', HK: 'Hong Kong', HN: 'Honduras', HR: 'Croatia',
  HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IN: 'India', IQ: 'Iraq',
  IR: 'Iran', IT: 'Italy', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan',
  KH: 'Cambodia', KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait', KY: 'Cayman Islands',
  KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MD: 'Moldova',
  MG: 'Madagascar', MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MT: 'Malta', MU: 'Mauritius',
  MV: 'Maldives', MX: 'Mexico', MY: 'Malaysia', NA: 'Namibia', NG: 'Nigeria', NI: 'Nicaragua',
  NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PS: 'Palestinian Territories', PT: 'Portugal',
  PY: 'Paraguay', QA: 'Qatar', RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda',
  SA: 'Saudi Arabia', SC: 'Seychelles', SD: 'Sudan', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia',
  SK: 'Slovakia', SN: 'Senegal', SO: 'Somalia', SS: 'South Sudan', SY: 'Syria', TH: 'Thailand',
  TJ: 'Tajikistan', TN: 'Tunisia', TR: 'Turkey', TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine',
  UG: 'Uganda', UK: 'United Kingdom', US: 'United States', UZ: 'Uzbekistan', VE: 'Venezuela',
  VG: 'British Virgin Islands', VN: 'Vietnam', YE: 'Yemen', ZA: 'South Africa', ZW: 'Zimbabwe',
};

// Long-form and legacy names → the label used in aggregates. Keys are uppercase.
const ALIASES = {
  'RUSSIAN FEDERATION': 'Russia',
  'IRAN (ISLAMIC REPUBLIC OF)': 'Iran',
  'ISLAMIC REPUBLIC OF IRAN': 'Iran',
  'SYRIAN ARAB REPUBLIC': 'Syria',
  'DPRK': 'North Korea',
  'NORTH KOREA': 'North Korea',
  'KOREA, NORTH': 'North Korea',
  "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF": 'North Korea',
  "DEMOCRATIC PEOPLE'S REPUBLIC OF KOREA": 'North Korea',
  'KOREA, SOUTH': 'South Korea',
  'KOREA, REPUBLIC OF': 'South Korea',
  'REPUBLIC OF KOREA': 'South Korea',
  'BURMA': 'Myanmar',
  'MYANMAR': 'Myanmar',
  'VIET NAM': 'Vietnam',
  'MOLDOVA, REPUBLIC OF': 'Moldova',
  'TANZANIA, UNITED REPUBLIC OF': 'Tanzania',
  'BOSNIA AND HERZEGOWINA': 'Bosnia and Herzegovina',
  'CZECH REPUBLIC': 'Czechia',
  'VIRGIN ISLANDS (BRITISH)': 'British Virgin Islands',
  "COTE D'IVOIRE": "Côte d'Ivoire",
  'UNITED STATES OF AMERICA': 'United States',
  'CONGO, DEMOCRATIC REPUBLIC OF': 'DR Congo',
  'CONGO, DEMOCRATIC REPUBLIC OF THE': 'DR Congo',
  'CONGO (DEMOCRATIC REPUBLIC)': 'DR Congo',
  'DEMOCRATIC REPUBLIC OF THE CONGO': 'DR Congo',
  "CONGO, PEOPLE'S REPUBLIC OF": 'Congo',
  'PALESTINIAN TERRITORY': 'Palestinian Territories',
  'PALESTINIAN TERRITORY, OCCUPIED': 'Palestinian Territories',
  "LAO PEOPLE'S DEMOCRATIC REPUBLIC": 'Laos',
  'VENEZUELA, BOLIVARIAN REPUBLIC OF': 'Venezuela',
  'BOLIVIA, PLURINATIONAL STATE OF': 'Bolivia',
  'TAIWAN, PROVINCE OF CHINA': 'Taiwan',
  'TURKIYE': 'Turkey',
  'TÜRKIYE': 'Turkey',
  'UAE': 'United Arab Emirates',
  'MACAO': 'Macau',
  'HOLY SEE (VATICAN CITY STATE)': 'Vatican City',
};

const SMALL = new Set(['of', 'and', 'the', 'de', 'del', 'la', 'el', 'da', 'do']);

function titleCase(s) {
  return s.toLowerCase().split(/(\s+|-)/).map((w, i) => {
    if (/^(\s+|-)$/.test(w) || !w) return w;
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

// One raw value → canonical label, or '' when it carries no jurisdiction
// (placeholders, stray numeric ids from a malformed source row).
function canonicalCountry(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  if (!s) return '';
  if (s === 'na' || /^n\/a$/i.test(s) || /^(unknown|none|-+)$/i.test(s)) return '';
  if (/^\d+$/.test(s)) return '';
  // Drop a trailing gloss like "(was Zaire)", but never a whole-value parenthetical.
  const glossed = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const upper = s.toUpperCase();
  if (ALIASES[upper]) return ALIASES[upper];
  if (glossed && ALIASES[glossed.toUpperCase()]) return ALIASES[glossed.toUpperCase()];
  if (glossed && glossed.length > 2) s = glossed;
  if (/^[A-Za-z]{2}$/.test(s) && ISO2[s.toUpperCase()]) return ISO2[s.toUpperCase()];
  if (s === s.toUpperCase() && s.length > 3) return titleCase(s);
  return s;
}

// One raw field → every jurisdiction it names. Handles the UK OFSI
// "(1) Russia. (2) Ukraine" multi-nationality form and ';'-joined values.
function parseCountries(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  const parts = /^\(\d+\)/.test(s) ? s.split(/\(\d+\)/) : s.split(';');
  const out = [];
  for (const p of parts) {
    const c = canonicalCountry(p);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

module.exports = { canonicalCountry, parseCountries };
