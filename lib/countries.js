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
 * Entity records keep the authority's own wording — nothing here rewrites the
 * published data. What the module exposes is a canonical LABEL for aggregate
 * counts and a canonical ISO-3166 CODE for comparison, and the code is what
 * screening uses: the country modifier in lib/matcher compared raw strings, so
 * a user typing "North Korea" against a party OFAC publishes as "KOREA,
 * DEMOCRATIC PEOPLE'S REPUBLIC OF" shared no token with it and the corroborating
 * identifier was scored as a CONTRADICTING one. Comparing codes puts the four
 * spellings of one jurisdiction back together.
 */

const ISO2 = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AR: 'Argentina',
  AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba', AX: 'Åland Islands',
  AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BB: 'Barbados', BD: 'Bangladesh', BE: 'Belgium',
  BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain', BI: 'Burundi', BJ: 'Benin',
  BL: 'Saint Barthélemy', BM: 'Bermuda', BN: 'Brunei', BO: 'Bolivia', BQ: 'Caribbean Netherlands',
  BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan', BW: 'Botswana', BY: 'Belarus', BZ: 'Belize',
  CA: 'Canada', CC: 'Cocos (Keeling) Islands', CD: 'DR Congo', CF: 'Central African Republic',
  CG: 'Congo', CH: 'Switzerland', CI: "Côte d'Ivoire", CK: 'Cook Islands', CL: 'Chile',
  CM: 'Cameroon', CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CV: 'Cape Verde',
  CW: 'Curaçao', CX: 'Christmas Island', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany',
  DJ: 'Djibouti', DK: 'Denmark', DM: 'Dominica', DO: 'Dominican Republic', DZ: 'Algeria',
  EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', EH: 'Western Sahara', ER: 'Eritrea', ES: 'Spain',
  ET: 'Ethiopia', FI: 'Finland', FJ: 'Fiji', FK: 'Falkland Islands', FM: 'Micronesia',
  FO: 'Faroe Islands', FR: 'France', GA: 'Gabon', GB: 'United Kingdom', GD: 'Grenada',
  GE: 'Georgia', GF: 'French Guiana', GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar',
  GL: 'Greenland', GM: 'Gambia', GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea',
  GR: 'Greece', GS: 'South Georgia and South Sandwich Islands', GT: 'Guatemala', GU: 'Guam',
  GW: 'Guinea-Bissau', GY: 'Guyana', HK: 'Hong Kong', HN: 'Honduras', HR: 'Croatia', HT: 'Haiti',
  HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IM: 'Isle of Man', IN: 'India',
  IO: 'British Indian Ocean Territory', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland', IT: 'Italy',
  JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan',
  KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros', KN: 'Saint Kitts and Nevis', KP: 'North Korea',
  KR: 'South Korea', KW: 'Kuwait', KY: 'Cayman Islands', KZ: 'Kazakhstan', LA: 'Laos',
  LB: 'Lebanon', LC: 'Saint Lucia', LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia',
  LS: 'Lesotho', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya', MA: 'Morocco',
  MC: 'Monaco', MD: 'Moldova', ME: 'Montenegro', MF: 'Saint Martin', MG: 'Madagascar',
  MH: 'Marshall Islands', MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia',
  MO: 'Macau', MP: 'Northern Mariana Islands', MQ: 'Martinique', MR: 'Mauritania',
  MS: 'Montserrat', MT: 'Malta', MU: 'Mauritius', MV: 'Maldives', MW: 'Malawi', MX: 'Mexico',
  MY: 'Malaysia', MZ: 'Mozambique', NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger',
  NF: 'Norfolk Island', NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway',
  NP: 'Nepal', NR: 'Nauru', NU: 'Niue', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PF: 'French Polynesia', PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland',
  PM: 'Saint Pierre and Miquelon', PN: 'Pitcairn Islands', PR: 'Puerto Rico',
  PS: 'Palestinian Territories', PT: 'Portugal', PW: 'Palau', PY: 'Paraguay', QA: 'Qatar',
  RE: 'Réunion', RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia',
  SB: 'Solomon Islands', SC: 'Seychelles', SD: 'Sudan', SE: 'Sweden', SG: 'Singapore',
  SH: 'Saint Helena', SI: 'Slovenia', SJ: 'Svalbard and Jan Mayen', SK: 'Slovakia',
  SL: 'Sierra Leone', SM: 'San Marino', SN: 'Senegal', SO: 'Somalia', SR: 'Suriname',
  SS: 'South Sudan', ST: 'São Tomé and Príncipe', SV: 'El Salvador', SX: 'Sint Maarten',
  SY: 'Syria', SZ: 'Eswatini', TC: 'Turks and Caicos Islands', TD: 'Chad',
  TF: 'French Southern Territories', TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan', TK: 'Tokelau',
  TL: 'Timor-Leste', TM: 'Turkmenistan', TN: 'Tunisia', TO: 'Tonga', TR: 'Turkey',
  TT: 'Trinidad and Tobago', TV: 'Tuvalu', TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine',
  UG: 'Uganda', UK: 'United Kingdom', US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan',
  VA: 'Vatican City', VC: 'Saint Vincent and Grenadines', VE: 'Venezuela',
  VG: 'British Virgin Islands', VI: 'U.S. Virgin Islands', VN: 'Vietnam', VU: 'Vanuatu',
  WF: 'Wallis and Futuna', WS: 'Samoa', XK: 'Kosovo', YE: 'Yemen', YT: 'Mayotte',
  ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe',
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
  // Wordings the four feeds actually publish, found by running countryCodes
  // over the whole snapshot and reading what failed to resolve.
  'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND': 'United Kingdom',
  'GREAT BRITAIN': 'United Kingdom',
  'VIRGIN ISLANDS, BRITISH': 'British Virgin Islands',
  'VIRGIN ISLANDS, U.S.': 'U.S. Virgin Islands',
  'PALESTINIAN': 'Palestinian Territories',
  'OCCUPIED PALESTINIAN TERRITORIES': 'Palestinian Territories',
  'OCCUPIED PALESTINIAN TERRITORY': 'Palestinian Territories',
  'PALESTINE': 'Palestinian Territories',
  'PALESTINE, STATE OF': 'Palestinian Territories',
  'THE GAMBIA': 'Gambia',
  'GAMBIA, THE': 'Gambia',
  'NORTH MACEDONIA, THE REPUBLIC OF': 'North Macedonia',
  'MACEDONIA, THE FORMER YUGOSLAV REPUBLIC OF': 'North Macedonia',
  'COTE D IVOIRE': "Côte d'Ivoire",
  'IVORY COAST': "Côte d'Ivoire",
  'HONG KONG SAR': 'Hong Kong',
  'CHINA, HONG KONG SPECIAL ADMINISTRATIVE REGION': 'Hong Kong',
  'HONG KONG SPECIAL ADMINISTRATIVE REGION': 'Hong Kong',
  'MACAU SAR': 'Macau',
  'CHINA, MACAO SPECIAL ADMINISTRATIVE REGION': 'Macau',
  'KOSOVO, REPUBLIC OF': 'Kosovo',
  'REPUBLIC OF KOSOVO': 'Kosovo',
  'CAPE VERDE': 'Cape Verde',
  'CABO VERDE': 'Cape Verde',
  'SWAZILAND': 'Eswatini',
  'EAST TIMOR': 'Timor-Leste',
  'BRUNEI DARUSSALAM': 'Brunei',
  'MICRONESIA, FEDERATED STATES OF': 'Micronesia',
  'SYRIA, ARAB REPUBLIC OF': 'Syria',
  'SAINT VINCENT AND THE GRENADINES': 'Saint Vincent and Grenadines',
  'CENTRAL AFRICAN REPUBLIC (THE)': 'Central African Republic',
  'NETHERLANDS, THE': 'Netherlands',
  'PHILIPPINES, THE': 'Philippines',
  'UNITED REPUBLIC OF TANZANIA': 'Tanzania',
  'GUINEA BISSAU': 'Guinea-Bissau',
  'MAN, ISLE OF': 'Isle of Man',
  'CONGO, REPUBLIC OF THE': 'Congo',
  'REPUBLIC OF THE CONGO': 'Congo',
  'BAHAMAS, THE': 'Bahamas',
  'STATE OF PALESTINE': 'Palestinian Territories',
  'WEST BANK': 'Palestinian Territories',
  'GAZA': 'Palestinian Territories',
  'GAZA STRIP': 'Palestinian Territories',
  'BRITAIN': 'United Kingdom',
  // Adjectival forms: sources write the nationality field either way, and
  // "Russian" naming Russia is not a different jurisdiction.
  'RUSSIAN': 'Russia',
  'IRANIAN': 'Iran',
  'SYRIAN': 'Syria',
  'IRAQI': 'Iraq',
  'UKRAINIAN': 'Ukraine',
  'BELARUSIAN': 'Belarus',
  'CHINESE': 'China',
  'TURKISH': 'Turkey',
  'LEBANESE': 'Lebanon',
  'AFGHAN': 'Afghanistan',
  'PAKISTANI': 'Pakistan',
  'VENEZUELAN': 'Venezuela',
  'CUBAN': 'Cuba',
  'LIBYAN': 'Libya',
  'YEMENI': 'Yemen',
  'SUDANESE': 'Sudan',
  'SOMALI': 'Somalia',
  'BURMESE': 'Myanmar',
  'NORTH KOREAN': 'North Korea',
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

/*
 * Canonical label → ISO-3166 alpha-2 code.
 *
 * Built by inverting ISO2 rather than typed out again, so a country cannot end
 * up with a label the table knows and a code it does not. First key wins where
 * two map to the same label (GB and UK both say "United Kingdom"), which is why
 * ISO2 lists GB first.
 */
const CODE_OF = (() => {
  const m = new Map();
  for (const [code, label] of Object.entries(ISO2)) if (!m.has(label)) m.set(label, code);
  return m;
})();

/*
 * Dependency / special administrative region → the sovereign state it sits under.
 *
 * A party registered in "China, Hong Kong Special Administrative Region" is not
 * a contradiction of a user who typed "China", and scoring it as one penalizes
 * the analyst for being less precise than the list. Codes are expanded through
 * this map on BOTH sides before comparison, so it reads the same either way
 * round — typing "Hong Kong" against a party the list places in China also
 * corroborates.
 *
 * The trade this makes: two territories of the same sovereign (Jersey and
 * Gibraltar) now corroborate each other through GB. That is deliberate. The
 * modifier is a ±0.04 nudge on a name score, and in screening the safe
 * direction for an ambiguous jurisdiction signal is not to penalize.
 */
const SOVEREIGN = {
  HK: 'CN', MO: 'CN',
  AI: 'GB', BM: 'GB', FK: 'GB', GG: 'GB', GI: 'GB', IM: 'GB', IO: 'GB', JE: 'GB',
  KY: 'GB', MS: 'GB', PN: 'GB', SH: 'GB', TC: 'GB', VG: 'GB', GS: 'GB',
  AS: 'US', GU: 'US', MP: 'US', PR: 'US', VI: 'US',
  BL: 'FR', GF: 'FR', GP: 'FR', MF: 'FR', MQ: 'FR', NC: 'FR', PF: 'FR', PM: 'FR',
  RE: 'FR', TF: 'FR', WF: 'FR', YT: 'FR',
  AW: 'NL', BQ: 'NL', CW: 'NL', SX: 'NL',
  FO: 'DK', GL: 'DK', AX: 'FI', SJ: 'NO',
  CC: 'AU', CX: 'AU', NF: 'AU', CK: 'NZ', NU: 'NZ', TK: 'NZ',
};

// A code plus its sovereign parent, for comparison. Never the other direction:
// expanding CN to every Chinese territory would make "Hong Kong" corroborate a
// mainland party, which is a claim the data does not make.
function expandCode(code) {
  const parent = SOVEREIGN[code];
  return parent ? [code, parent] : [code];
}

// One raw value → its ISO-3166 alpha-2 code, or '' when the value names no
// jurisdiction this table knows. An empty result is meaningful: it tells the
// caller to fall back rather than to treat the value as a different country.
function countryCode(raw) {
  return CODE_OF.get(canonicalCountry(raw)) || '';
}

// One raw field → every jurisdiction code it names, deduplicated. Same
// multi-value handling as parseCountries (UK OFSI "(1) Russia. (2) Ukraine").
function countryCodes(raw) {
  const out = [];
  for (const label of parseCountries(raw)) {
    const code = CODE_OF.get(label);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/*
 * Every jurisdiction name this table knows, as an uppercase lookup, for reading
 * a country out of free text.
 *
 * Needed because 3,582 addresses in the snapshot carry an empty `country` and
 * put the jurisdiction in the address line instead ("Located in Syria"). Those
 * used to be screened — the old string comparison pooled `full` into its
 * haystack — so a code path that only read `country` would have quietly lost
 * them.
 */
const TEXT_LOOKUP = (() => {
  const m = new Map();
  const key = (s) => s.toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [code, label] of Object.entries(ISO2)) { const k = key(label); if (k && !m.has(k)) m.set(k, code); }
  for (const [alias, label] of Object.entries(ALIASES)) {
    const k = key(alias), code = CODE_OF.get(label);
    if (k && code && !m.has(k)) m.set(k, code);
  }
  return m;
})();
const TEXT_MAX_WORDS = 7; // "United Kingdom of Great Britain and Northern Ireland"

/*
 * The jurisdiction named in a free-text address line, or ''.
 *
 * Takes the RIGHTMOST match, which is postal convention — "Atlanta, Georgia,
 * United States" is in the US, not in Georgia the country. A line that ends at
 * the state ("Atlanta, Georgia") still reads as Georgia, and that is the known
 * cost of guessing at an address whose publisher left the country field blank.
 * Only ever consulted when the structured `country` field is empty.
 */
function countryCodeInText(text) {
  const words = String(text == null ? '' : text).toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(Boolean);
  let found = '';
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(TEXT_MAX_WORDS, words.length - i); n >= 1; n--) {
      const code = TEXT_LOOKUP.get(words.slice(i, i + n).join(' '));
      if (code) { found = code; i += n - 1; break; }
    }
  }
  return found;
}

module.exports = {
  canonicalCountry, parseCountries, countryCode, countryCodes, expandCode, countryCodeInText,
};
