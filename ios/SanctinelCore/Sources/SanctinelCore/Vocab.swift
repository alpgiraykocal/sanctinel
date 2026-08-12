import Foundation

/*
 * Canonical vocabulary for attribute labels and identifier types — a port of
 * lib/vocab.js.
 *
 * Four authorities describe the same field in their own words: 92 distinct
 * attribute labels and 131 identifier types across one snapshot, for maybe two
 * dozen real concepts. A birth date is `Birthdate` under OFAC and `Date of
 * Birth` everywhere else. Consumers used to pattern-match around that
 * (`/birth|born|dob/i` for the screening modifier, two literal string
 * comparisons for the statistics), and both are one upstream rewording away
 * from silently reading nothing.
 *
 * The authority's own label is never touched — it is what the record card shows
 * and what an analyst cites. The kind is what code compares.
 */
public enum Vocab {

    static let attributeKinds: [String: String] = [
        "date of birth": "dob",
        "birthdate": "dob",
        "place of birth": "pob",
        "nationality": "nationality",
        "nationality country": "nationality",
        "nationality of registration": "nationality",
        "citizenship": "citizenship",
        "citizenship country": "citizenship",
        "gender": "gender",
        "position": "position",
        "title": "position",
        "target type": "target_type",
        "organization established date": "established",
        "established date": "established",
        "organization type": "org_type",
        "secondary sanctions risk": "secondary_sanctions",
        "email address": "email",
        "email": "email",
        "phone number": "phone",
        "website": "website",
        "swift/bic": "swift",
        "isin": "isin",
        "equity ticker": "ticker",
        "issuer name": "issuer",
        "d-u-n-s number": "duns",
        "registration country": "registration_country",
        "un/locode": "locode",
        "micex code": "ticker",
        "bik (ru)": "bank_code",
        "eu reference": "source_reference",
        "un reference": "source_reference",
        "remark": "remark",
    ]

    /// Ordered substring rules for labels the table does not name outright.
    /// First match wins, mirroring the JS pattern list.
    static let attributePatterns: [(needles: [String], anchored: Bool, kind: String)] = [
        (["digital currency address"], true, "crypto"),
        (["vessel"], false, "vessel"),
        (["aircraft"], false, "aircraft"),
        (["executive order", "caatsa", "hkaa", "paipa", "peesa", "ifca",
          "additional sanctions information", "transactions prohibited"], false, "program_info"),
        (["effective date", "listing date", "purchase/sales for divestment date"], true, "program_date"),
        (["passport"], false, "passport"),
        (["national id"], false, "national_id"),
    ]

    public static let attributeDateKinds: Set<String> = ["dob", "established", "program_date"]

    /// Lowercased, with trailing punctuation and separator noise stripped, so
    /// "Organization Type:" and "Additional Sanctions Information -" reduce to
    /// their bare form.
    public static func normalizeLabel(_ label: String) -> String {
        var s = label.lowercased()
        while let last = s.last, last == " " || last == ":" || last == ";" || last == "."
            || last == "," || last == "-" || last == "–" || last == "—" {
            s.removeLast()
        }
        return s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// The concept an attribute label names, or "other" — an unrecognized label
    /// is a signal to look at the feed, and a made-up kind would hide it.
    public static func attributeKind(_ label: String) -> String {
        let l = normalizeLabel(label)
        if l.isEmpty { return "other" }
        if let hit = attributeKinds[l] { return hit }
        for rule in attributePatterns {
            for needle in rule.needles where rule.anchored ? l.hasPrefix(needle) : l.contains(needle) {
                return rule.kind
            }
        }
        return "other"
    }

    /*
     * Identifier type → kind. Coarse where the distinction carries no screening
     * consequence (every flavour of company register number is `registration`)
     * and precise where it does.
     *
     * Each type is tested both as published and with the dots closed up, because
     * half of them are dotted abbreviations — "D.N.I.", "C.U.R.P.", "R.F.C.".
     */
    static let identifierPatterns: [(needles: [String], kind: String)] = [
        (["passport"], "passport"),
        (["imo"], "imo"),
        (["mmsi"], "mmsi"),
        (["call sign"], "call_sign"),
        (["aircraft tail", "tail number"], "aircraft_tail"),
        (["msn", "manufacturer", "construction number"], "aircraft_msn"),
        (["vessel registration"], "vessel_registration"),
        (["crypto", "digital currency"], "crypto"),
        (["email", "e-mail"], "email"),
        (["phone", "telephone", "fax"], "phone"),
        (["swift", "bic"], "swift"),
        (["lei", "legal entity identifier"], "lei"),
        (["isin"], "isin"),
        (["d-u-n-s", "duns"], "duns"),
        (["tax", "vat", "rfc", "nit", "ruc", "tin", "rif", "fiscal code", "fein",
          "global intermediary identification"], "tax_id"),
        (["cedula", "curp", "cui", "dni", "nie", "ife", "ssn", "national id",
          "national identification", "national foreign id", "identity card", "personal id",
          "credencial electoral", "voter", "residency number", "birth certificate",
          "citizen", "numero de identidad", "cartilla", "servicio militar",
          "turkish identification"], "national_id"),
        (["registration", "registry", "commercial regist", "company number", "business number",
          "enterprise number", "entity code", "organization code", "branch unit",
          "certificate of incorporation", "registered charity", "folio mercantil", "matricula",
          "chamber of comm", "social credit", "gazette", "cr no", "cin",
          "legal entity number", "economic register"], "registration"),
        (["license", "licence", "permit"], "license"),
        (["identification number", "identification", "other identification"], "other_id"),
    ]

    // Short needles that must match a whole word, mirroring the `\b…\b` guards
    // in the JS patterns — otherwise "ci" fires inside "municipal".
    static let wholeWordNeedles: Set<String> = [
        "imo", "lei", "isin", "duns", "tax", "vat", "rfc", "nit", "ruc", "tin", "rif",
        "fein", "cedula", "ci", "curp", "cui", "dni", "nie", "ife", "ssn", "bic", "cin",
        "cr no",
    ]

    static func matches(_ haystack: String, _ needle: String) -> Bool {
        guard wholeWordNeedles.contains(needle) else { return haystack.contains(needle) }
        var words = haystack.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        if needle.contains(" ") { return haystack.contains(needle) }
        words = words.map { $0.lowercased() }
        return words.contains(needle)
    }

    public static func identifierKind(_ type: String) -> String {
        let t = normalizeLabel(type)
        if t.isEmpty { return "other_id" }
        let dotless = t.replacingOccurrences(of: ".", with: "")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        for rule in identifierPatterns {
            for needle in rule.needles where matches(t, needle) || matches(dotless, needle) {
                return rule.kind
            }
        }
        return "other_id"
    }
}
