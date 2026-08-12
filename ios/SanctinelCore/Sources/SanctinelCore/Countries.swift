import Foundation

/*
 * Country normalization for cross-authority aggregation — a port of
 * lib/countries.js.
 *
 * Each source writes jurisdictions its own way: OFAC "Korea, North", the EU
 * "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF", BIS bare ISO alpha-2 codes, UK OFSI
 * multi-nationality strings like "(1) Russia. (2) Ukraine". Counting those
 * verbatim splits one country across four rows and understates every one of
 * them, so a statistic would contradict the underlying list.
 *
 * Entity records keep the authority's own wording — nothing here rewrites the
 * published data. What this exposes is a canonical LABEL for aggregate counts
 * and a canonical ISO-3166 CODE for comparison, and the code is what screening
 * uses: the country modifier compared raw strings, so "North Korea" against a
 * party published as "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" shared no token
 * and the corroborating identifier was scored as a contradicting one.
 *
 * The tables below are generated from lib/countries.js rather than retyped.
 */
public enum Countries {

    static let iso2: [String: String] = [
        "AD": "Andorra",
        "AE": "United Arab Emirates",
        "AF": "Afghanistan",
        "AG": "Antigua and Barbuda",
        "AI": "Anguilla",
        "AL": "Albania",
        "AM": "Armenia",
        "AO": "Angola",
        "AR": "Argentina",
        "AS": "American Samoa",
        "AT": "Austria",
        "AU": "Australia",
        "AW": "Aruba",
        "AX": "Åland Islands",
        "AZ": "Azerbaijan",
        "BA": "Bosnia and Herzegovina",
        "BB": "Barbados",
        "BD": "Bangladesh",
        "BE": "Belgium",
        "BF": "Burkina Faso",
        "BG": "Bulgaria",
        "BH": "Bahrain",
        "BI": "Burundi",
        "BJ": "Benin",
        "BL": "Saint Barthélemy",
        "BM": "Bermuda",
        "BN": "Brunei",
        "BO": "Bolivia",
        "BQ": "Caribbean Netherlands",
        "BR": "Brazil",
        "BS": "Bahamas",
        "BT": "Bhutan",
        "BW": "Botswana",
        "BY": "Belarus",
        "BZ": "Belize",
        "CA": "Canada",
        "CC": "Cocos (Keeling) Islands",
        "CD": "DR Congo",
        "CF": "Central African Republic",
        "CG": "Congo",
        "CH": "Switzerland",
        "CI": "Côte d'Ivoire",
        "CK": "Cook Islands",
        "CL": "Chile",
        "CM": "Cameroon",
        "CN": "China",
        "CO": "Colombia",
        "CR": "Costa Rica",
        "CU": "Cuba",
        "CV": "Cape Verde",
        "CW": "Curaçao",
        "CX": "Christmas Island",
        "CY": "Cyprus",
        "CZ": "Czechia",
        "DE": "Germany",
        "DJ": "Djibouti",
        "DK": "Denmark",
        "DM": "Dominica",
        "DO": "Dominican Republic",
        "DZ": "Algeria",
        "EC": "Ecuador",
        "EE": "Estonia",
        "EG": "Egypt",
        "EH": "Western Sahara",
        "ER": "Eritrea",
        "ES": "Spain",
        "ET": "Ethiopia",
        "FI": "Finland",
        "FJ": "Fiji",
        "FK": "Falkland Islands",
        "FM": "Micronesia",
        "FO": "Faroe Islands",
        "FR": "France",
        "GA": "Gabon",
        "GB": "United Kingdom",
        "GD": "Grenada",
        "GE": "Georgia",
        "GF": "French Guiana",
        "GG": "Guernsey",
        "GH": "Ghana",
        "GI": "Gibraltar",
        "GL": "Greenland",
        "GM": "Gambia",
        "GN": "Guinea",
        "GP": "Guadeloupe",
        "GQ": "Equatorial Guinea",
        "GR": "Greece",
        "GS": "South Georgia and South Sandwich Islands",
        "GT": "Guatemala",
        "GU": "Guam",
        "GW": "Guinea-Bissau",
        "GY": "Guyana",
        "HK": "Hong Kong",
        "HN": "Honduras",
        "HR": "Croatia",
        "HT": "Haiti",
        "HU": "Hungary",
        "ID": "Indonesia",
        "IE": "Ireland",
        "IL": "Israel",
        "IM": "Isle of Man",
        "IN": "India",
        "IO": "British Indian Ocean Territory",
        "IQ": "Iraq",
        "IR": "Iran",
        "IS": "Iceland",
        "IT": "Italy",
        "JE": "Jersey",
        "JM": "Jamaica",
        "JO": "Jordan",
        "JP": "Japan",
        "KE": "Kenya",
        "KG": "Kyrgyzstan",
        "KH": "Cambodia",
        "KI": "Kiribati",
        "KM": "Comoros",
        "KN": "Saint Kitts and Nevis",
        "KP": "North Korea",
        "KR": "South Korea",
        "KW": "Kuwait",
        "KY": "Cayman Islands",
        "KZ": "Kazakhstan",
        "LA": "Laos",
        "LB": "Lebanon",
        "LC": "Saint Lucia",
        "LI": "Liechtenstein",
        "LK": "Sri Lanka",
        "LR": "Liberia",
        "LS": "Lesotho",
        "LT": "Lithuania",
        "LU": "Luxembourg",
        "LV": "Latvia",
        "LY": "Libya",
        "MA": "Morocco",
        "MC": "Monaco",
        "MD": "Moldova",
        "ME": "Montenegro",
        "MF": "Saint Martin",
        "MG": "Madagascar",
        "MH": "Marshall Islands",
        "MK": "North Macedonia",
        "ML": "Mali",
        "MM": "Myanmar",
        "MN": "Mongolia",
        "MO": "Macau",
        "MP": "Northern Mariana Islands",
        "MQ": "Martinique",
        "MR": "Mauritania",
        "MS": "Montserrat",
        "MT": "Malta",
        "MU": "Mauritius",
        "MV": "Maldives",
        "MW": "Malawi",
        "MX": "Mexico",
        "MY": "Malaysia",
        "MZ": "Mozambique",
        "NA": "Namibia",
        "NC": "New Caledonia",
        "NE": "Niger",
        "NF": "Norfolk Island",
        "NG": "Nigeria",
        "NI": "Nicaragua",
        "NL": "Netherlands",
        "NO": "Norway",
        "NP": "Nepal",
        "NR": "Nauru",
        "NU": "Niue",
        "NZ": "New Zealand",
        "OM": "Oman",
        "PA": "Panama",
        "PE": "Peru",
        "PF": "French Polynesia",
        "PG": "Papua New Guinea",
        "PH": "Philippines",
        "PK": "Pakistan",
        "PL": "Poland",
        "PM": "Saint Pierre and Miquelon",
        "PN": "Pitcairn Islands",
        "PR": "Puerto Rico",
        "PS": "Palestinian Territories",
        "PT": "Portugal",
        "PW": "Palau",
        "PY": "Paraguay",
        "QA": "Qatar",
        "RE": "Réunion",
        "RO": "Romania",
        "RS": "Serbia",
        "RU": "Russia",
        "RW": "Rwanda",
        "SA": "Saudi Arabia",
        "SB": "Solomon Islands",
        "SC": "Seychelles",
        "SD": "Sudan",
        "SE": "Sweden",
        "SG": "Singapore",
        "SH": "Saint Helena",
        "SI": "Slovenia",
        "SJ": "Svalbard and Jan Mayen",
        "SK": "Slovakia",
        "SL": "Sierra Leone",
        "SM": "San Marino",
        "SN": "Senegal",
        "SO": "Somalia",
        "SR": "Suriname",
        "SS": "South Sudan",
        "ST": "São Tomé and Príncipe",
        "SV": "El Salvador",
        "SX": "Sint Maarten",
        "SY": "Syria",
        "SZ": "Eswatini",
        "TC": "Turks and Caicos Islands",
        "TD": "Chad",
        "TF": "French Southern Territories",
        "TG": "Togo",
        "TH": "Thailand",
        "TJ": "Tajikistan",
        "TK": "Tokelau",
        "TL": "Timor-Leste",
        "TM": "Turkmenistan",
        "TN": "Tunisia",
        "TO": "Tonga",
        "TR": "Turkey",
        "TT": "Trinidad and Tobago",
        "TV": "Tuvalu",
        "TW": "Taiwan",
        "TZ": "Tanzania",
        "UA": "Ukraine",
        "UG": "Uganda",
        "UK": "United Kingdom",
        "US": "United States",
        "UY": "Uruguay",
        "UZ": "Uzbekistan",
        "VA": "Vatican City",
        "VC": "Saint Vincent and Grenadines",
        "VE": "Venezuela",
        "VG": "British Virgin Islands",
        "VI": "U.S. Virgin Islands",
        "VN": "Vietnam",
        "VU": "Vanuatu",
        "WF": "Wallis and Futuna",
        "WS": "Samoa",
        "XK": "Kosovo",
        "YE": "Yemen",
        "YT": "Mayotte",
        "ZA": "South Africa",
        "ZM": "Zambia",
        "ZW": "Zimbabwe",
    ]

    static let aliases: [String: String] = [
        "RUSSIAN FEDERATION": "Russia",
        "IRAN (ISLAMIC REPUBLIC OF)": "Iran",
        "ISLAMIC REPUBLIC OF IRAN": "Iran",
        "SYRIAN ARAB REPUBLIC": "Syria",
        "DPRK": "North Korea",
        "NORTH KOREA": "North Korea",
        "KOREA, NORTH": "North Korea",
        "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF": "North Korea",
        "DEMOCRATIC PEOPLE'S REPUBLIC OF KOREA": "North Korea",
        "KOREA, SOUTH": "South Korea",
        "KOREA, REPUBLIC OF": "South Korea",
        "REPUBLIC OF KOREA": "South Korea",
        "BURMA": "Myanmar",
        "MYANMAR": "Myanmar",
        "VIET NAM": "Vietnam",
        "MOLDOVA, REPUBLIC OF": "Moldova",
        "TANZANIA, UNITED REPUBLIC OF": "Tanzania",
        "BOSNIA AND HERZEGOWINA": "Bosnia and Herzegovina",
        "CZECH REPUBLIC": "Czechia",
        "VIRGIN ISLANDS (BRITISH)": "British Virgin Islands",
        "COTE D'IVOIRE": "Côte d'Ivoire",
        "UNITED STATES OF AMERICA": "United States",
        "CONGO, DEMOCRATIC REPUBLIC OF": "DR Congo",
        "CONGO, DEMOCRATIC REPUBLIC OF THE": "DR Congo",
        "CONGO (DEMOCRATIC REPUBLIC)": "DR Congo",
        "DEMOCRATIC REPUBLIC OF THE CONGO": "DR Congo",
        "CONGO, PEOPLE'S REPUBLIC OF": "Congo",
        "PALESTINIAN TERRITORY": "Palestinian Territories",
        "PALESTINIAN TERRITORY, OCCUPIED": "Palestinian Territories",
        "LAO PEOPLE'S DEMOCRATIC REPUBLIC": "Laos",
        "VENEZUELA, BOLIVARIAN REPUBLIC OF": "Venezuela",
        "BOLIVIA, PLURINATIONAL STATE OF": "Bolivia",
        "TAIWAN, PROVINCE OF CHINA": "Taiwan",
        "TURKIYE": "Turkey",
        "TÜRKIYE": "Turkey",
        "UAE": "United Arab Emirates",
        "MACAO": "Macau",
        "HOLY SEE (VATICAN CITY STATE)": "Vatican City",
        "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND": "United Kingdom",
        "GREAT BRITAIN": "United Kingdom",
        "VIRGIN ISLANDS, BRITISH": "British Virgin Islands",
        "VIRGIN ISLANDS, U.S.": "U.S. Virgin Islands",
        "PALESTINIAN": "Palestinian Territories",
        "OCCUPIED PALESTINIAN TERRITORIES": "Palestinian Territories",
        "OCCUPIED PALESTINIAN TERRITORY": "Palestinian Territories",
        "PALESTINE": "Palestinian Territories",
        "PALESTINE, STATE OF": "Palestinian Territories",
        "THE GAMBIA": "Gambia",
        "GAMBIA, THE": "Gambia",
        "NORTH MACEDONIA, THE REPUBLIC OF": "North Macedonia",
        "MACEDONIA, THE FORMER YUGOSLAV REPUBLIC OF": "North Macedonia",
        "COTE D IVOIRE": "Côte d'Ivoire",
        "IVORY COAST": "Côte d'Ivoire",
        "HONG KONG SAR": "Hong Kong",
        "CHINA, HONG KONG SPECIAL ADMINISTRATIVE REGION": "Hong Kong",
        "HONG KONG SPECIAL ADMINISTRATIVE REGION": "Hong Kong",
        "MACAU SAR": "Macau",
        "CHINA, MACAO SPECIAL ADMINISTRATIVE REGION": "Macau",
        "KOSOVO, REPUBLIC OF": "Kosovo",
        "REPUBLIC OF KOSOVO": "Kosovo",
        "CAPE VERDE": "Cape Verde",
        "CABO VERDE": "Cape Verde",
        "SWAZILAND": "Eswatini",
        "EAST TIMOR": "Timor-Leste",
        "BRUNEI DARUSSALAM": "Brunei",
        "MICRONESIA, FEDERATED STATES OF": "Micronesia",
        "SYRIA, ARAB REPUBLIC OF": "Syria",
        "SAINT VINCENT AND THE GRENADINES": "Saint Vincent and Grenadines",
        "CENTRAL AFRICAN REPUBLIC (THE)": "Central African Republic",
        "NETHERLANDS, THE": "Netherlands",
        "PHILIPPINES, THE": "Philippines",
        "UNITED REPUBLIC OF TANZANIA": "Tanzania",
        "GUINEA BISSAU": "Guinea-Bissau",
        "MAN, ISLE OF": "Isle of Man",
        "CONGO, REPUBLIC OF THE": "Congo",
        "REPUBLIC OF THE CONGO": "Congo",
        "BAHAMAS, THE": "Bahamas",
        "STATE OF PALESTINE": "Palestinian Territories",
        "WEST BANK": "Palestinian Territories",
        "GAZA": "Palestinian Territories",
        "GAZA STRIP": "Palestinian Territories",
        "BRITAIN": "United Kingdom",
        "RUSSIAN": "Russia",
        "IRANIAN": "Iran",
        "SYRIAN": "Syria",
        "IRAQI": "Iraq",
        "UKRAINIAN": "Ukraine",
        "BELARUSIAN": "Belarus",
        "CHINESE": "China",
        "TURKISH": "Turkey",
        "LEBANESE": "Lebanon",
        "AFGHAN": "Afghanistan",
        "PAKISTANI": "Pakistan",
        "VENEZUELAN": "Venezuela",
        "CUBAN": "Cuba",
        "LIBYAN": "Libya",
        "YEMENI": "Yemen",
        "SUDANESE": "Sudan",
        "SOMALI": "Somalia",
        "BURMESE": "Myanmar",
        "NORTH KOREAN": "North Korea",
    ]

    private static let smallWords: Set<String> = ["of", "and", "the", "de", "del", "la", "el", "da", "do"]

    /// `s.toLowerCase().split(/(\s+|-)/)` keeps the separators, so they survive
    /// the join; only the first character of a non-small word is raised.
    static func titleCase(_ s: String) -> String {
        let lower = s.lowercased()
        var pieces: [String] = []
        var current = ""
        var separator = ""
        for ch in lower {
            let isSeparator = ch.isWhitespace || ch == "-"
            if isSeparator {
                if !current.isEmpty { pieces.append(current); current = "" }
                separator.append(ch)
                // A run of whitespace is one separator, but "-" is its own.
                if ch == "-" { pieces.append(separator); separator = "" }
            } else {
                if !separator.isEmpty { pieces.append(separator); separator = "" }
                current.append(ch)
            }
        }
        if !separator.isEmpty { pieces.append(separator) }
        if !current.isEmpty { pieces.append(current) }

        var out = ""
        for (i, piece) in pieces.enumerated() {
            let isSeparator = piece.allSatisfy { $0.isWhitespace || $0 == "-" } && !piece.isEmpty
            if isSeparator || piece.isEmpty { out += piece; continue }
            if i > 0, smallWords.contains(piece) { out += piece; continue }
            out += piece.prefix(1).uppercased() + piece.dropFirst()
        }
        return out
    }

    /// One raw value to a canonical label, or "" when it carries no jurisdiction
    /// (placeholders, stray numeric ids from a malformed source row).
    public static func canonical(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if s.hasSuffix(".") { s = String(s.dropLast()) }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return "" }

        let lower = s.lowercased()
        if s == "na" || lower == "n/a" || lower == "unknown" || lower == "none" { return "" }
        if !s.isEmpty, s.allSatisfy({ $0 == "-" }) { return "" }
        if s.allSatisfy({ $0.isNumber && $0.isASCII }) { return "" }

        // Drop a trailing gloss like "(was Zaire)", never a whole-value parenthetical.
        let glossed = dropTrailingParenthetical(s)
        let upper = s.uppercased()
        if let hit = aliases[upper] { return hit }
        if !glossed.isEmpty, let hit = aliases[glossed.uppercased()] { return hit }
        if !glossed.isEmpty, glossed.count > 2 { s = glossed }

        if s.count == 2, s.allSatisfy({ $0.isLetter && $0.isASCII }), let hit = iso2[s.uppercased()] {
            return hit
        }
        if s == s.uppercased(), s.count > 3 { return titleCase(s) }
        return s
    }

    private static func dropTrailingParenthetical(_ s: String) -> String {
        guard s.hasSuffix(")"), let open = s.lastIndex(of: "(") else {
            return s.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // The regex is anchored at the end and cannot span another ")".
        let inner = s[s.index(after: open)..<s.index(before: s.endIndex)]
        if inner.contains(")") { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        return String(s[s.startIndex..<open]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One raw field to every jurisdiction it names. Handles the UK OFSI
    /// "(1) Russia. (2) Ukraine" multi-nationality form and ";"-joined values.
    public static func parse(_ raw: String) -> [String] {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return [] }
        let parts: [String] = startsWithIndexMarker(s) ? splitOnIndexMarkers(s) : s.components(separatedBy: ";")
        var out: [String] = []
        for p in parts {
            let c = canonical(p)
            if !c.isEmpty, !out.contains(c) { out.append(c) }
        }
        return out
    }

    /// `/^\(\d+\)/`
    private static func startsWithIndexMarker(_ s: String) -> Bool {
        let chars = Array(s)
        guard chars.count >= 3, chars[0] == "(" else { return false }
        var i = 1
        var digits = 0
        while i < chars.count, chars[i].isNumber { i += 1; digits += 1 }
        return digits > 0 && i < chars.count && chars[i] == ")"
    }

    /// `s.split(/\(\d+\)/)`
    private static func splitOnIndexMarkers(_ s: String) -> [String] {
        var out: [String] = []
        var current = ""
        let chars = Array(s)
        var i = 0
        while i < chars.count {
            if chars[i] == "(" {
                var j = i + 1
                var digits = 0
                while j < chars.count, chars[j].isNumber { j += 1; digits += 1 }
                if digits > 0, j < chars.count, chars[j] == ")" {
                    out.append(current)
                    current = ""
                    i = j + 1
                    continue
                }
            }
            current.append(chars[i])
            i += 1
        }
        out.append(current)
        return out
    }
    // MARK: - Codes

    /*
     * Dependency / special administrative region to the sovereign state it sits
     * under. A party registered in "China, Hong Kong Special Administrative
     * Region" is not a contradiction of a user who typed "China". Codes are
     * expanded through this on BOTH sides before comparison, so the check reads
     * the same either way round.
     */
    static let sovereign: [String: String] = [
        "HK": "CN",
        "MO": "CN",
        "AI": "GB",
        "BM": "GB",
        "FK": "GB",
        "GG": "GB",
        "GI": "GB",
        "IM": "GB",
        "IO": "GB",
        "JE": "GB",
        "KY": "GB",
        "MS": "GB",
        "PN": "GB",
        "SH": "GB",
        "TC": "GB",
        "VG": "GB",
        "GS": "GB",
        "AS": "US",
        "GU": "US",
        "MP": "US",
        "PR": "US",
        "VI": "US",
        "BL": "FR",
        "GF": "FR",
        "GP": "FR",
        "MF": "FR",
        "MQ": "FR",
        "NC": "FR",
        "PF": "FR",
        "PM": "FR",
        "RE": "FR",
        "TF": "FR",
        "WF": "FR",
        "YT": "FR",
        "AW": "NL",
        "BQ": "NL",
        "CW": "NL",
        "SX": "NL",
        "FO": "DK",
        "GL": "DK",
        "AX": "FI",
        "SJ": "NO",
        "CC": "AU",
        "CX": "AU",
        "NF": "AU",
        "CK": "NZ",
        "NU": "NZ",
        "TK": "NZ",
    ]

    /// Canonical label to ISO-3166 alpha-2, inverted from `iso2` rather than
    /// typed out again. First key wins where two map to one label (GB and UK
    /// both say "United Kingdom"), which is why the JS table lists GB first.
    static let codeOf: [String: String] = {
        var m = [String: String]()
        for key in iso2.keys.sorted() where m[iso2[key]!] == nil { m[iso2[key]!] = key }
        return m
    }()

    /// A code plus its sovereign parent. Never the other direction: expanding CN
    /// to every Chinese territory would make "Hong Kong" corroborate a mainland
    /// party, which is a claim the data does not make.
    public static func expand(_ code: String) -> [String] {
        guard let parent = sovereign[code] else { return [code] }
        return [code, parent]
    }

    /// One raw value to its ISO-3166 alpha-2 code, or "" when the value names no
    /// jurisdiction this table knows. Empty is meaningful: it tells the caller to
    /// fall back rather than to treat the value as a different country.
    public static func code(_ raw: String) -> String {
        codeOf[canonical(raw)] ?? ""
    }

    /// One raw field to every jurisdiction code it names, deduplicated.
    public static func codes(_ raw: String) -> [String] {
        var out: [String] = []
        for label in parse(raw) {
            guard let c = codeOf[label], !out.contains(c) else { continue }
            out.append(c)
        }
        return out
    }

    // MARK: - Free-text jurisdiction

    /// Every jurisdiction name this table knows, uppercased and stripped to
    /// letters, for reading a country out of a free-text address line. Needed
    /// because thousands of addresses carry an empty `country` and put the
    /// jurisdiction in the line itself ("Located in Syria").
    static let textLookup: [String: String] = {
        var m = [String: String]()
        func key(_ s: String) -> String {
            var out = ""
            var lastSpace = true
            for ch in s.uppercased() {
                if ch.isASCII && ch.isLetter { out.append(ch); lastSpace = false }
                else if !lastSpace { out.append(" "); lastSpace = true }
            }
            return out.trimmingCharacters(in: .whitespaces)
        }
        for c in iso2.keys.sorted() {
            let k = key(iso2[c]!)
            if !k.isEmpty, m[k] == nil { m[k] = c }
        }
        for alias in aliases.keys.sorted() {
            let k = key(alias)
            guard !k.isEmpty, let c = codeOf[aliases[alias]!], m[k] == nil else { continue }
            m[k] = c
        }
        return m
    }()

    static let textMaxWords = 7   // "United Kingdom of Great Britain and Northern Ireland"

    /*
     * The jurisdiction named in a free-text address line, or "".
     *
     * Takes the RIGHTMOST match, which is postal convention — "Atlanta, Georgia,
     * United States" is in the US, not in Georgia the country. Only ever
     * consulted when the structured `country` field is empty.
     */
    public static func codeInText(_ text: String) -> String {
        var words: [String] = []
        var current = ""
        for ch in text.uppercased() {
            if ch.isASCII && ch.isLetter { current.append(ch) }
            else if !current.isEmpty { words.append(current); current = "" }
        }
        if !current.isEmpty { words.append(current) }

        var found = ""
        var i = 0
        while i < words.count {
            var n = min(textMaxWords, words.count - i)
            while n >= 1 {
                if let c = textLookup[words[i..<(i + n)].joined(separator: " ")] {
                    found = c
                    i += n - 1
                    break
                }
                n -= 1
            }
            i += 1
        }
        return found
    }
}
