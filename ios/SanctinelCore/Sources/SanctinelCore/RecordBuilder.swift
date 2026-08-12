import Foundation

/*
 * Builds the scorer's view of a record from a raw snapshot entity.
 *
 * The two derived fields — birthYears and countryTokens — reproduce what
 * applyModifiers recomputes per candidate in the JS. They are pure functions of
 * the attributes and addresses, so hoisting them out of the hot loop cannot
 * change a score, and the conformance test derives them through this same code
 * rather than taking them pre-baked from the fixture.
 */
public enum RecordBuilder {

    public static func make(from entity: [String: Any], pool: TokenPool) -> ScreeningRecord {
        let id = string(entity["id"])
        let displayName = string(entity["name"])

        var names: [ScreeningName] = []
        if let raw = entity["names"] as? [[String: Any]], !raw.isEmpty {
            names.reserveCapacity(raw.count)
            for n in raw {
                names.append(ScreeningName(
                    name: string(n["name"]),
                    type: string(n["type"]),
                    primary: n["primary"] as? Bool ?? false,
                    lowQuality: n["lowQuality"] as? Bool ?? false,
                    pool: pool
                ))
            }
        } else {
            // The JS falls back to a single primary entry built from `name`.
            names = [ScreeningName(name: displayName, type: "Primary", primary: true,
                                   lowQuality: false, pool: pool)]
        }

        var identifiers: [ScreeningIdentifier] = []
        if let raw = entity["identifiers"] as? [[String: Any]] {
            identifiers.reserveCapacity(raw.count)
            for i in raw {
                identifiers.append(ScreeningIdentifier(type: string(i["type"]), value: string(i["value"])))
            }
        }

        let attributes = entity["attributes"] as? [[String: Any]] ?? []
        let addresses = entity["addresses"] as? [[String: Any]] ?? []

        return ScreeningRecord(
            id: id,
            name: displayName,
            authority: string(entity["authority"]),
            list: string(entity["list"]),
            type: string(entity["type"]),
            title: string(entity["title"]),
            programs: entity["programs"] as? [String] ?? [],
            datePublished: string(entity["datePublished"]),
            names: names,
            identifiers: identifiers,
            birthIntervals: birthIntervals(attributes),
            countryTokens: countryTokens(attributes: attributes, addresses: addresses),
            countryCodes: countryCodes(attributes: attributes, addresses: addresses),
            relationships: relationships(entity["relationships"] as? [[String: Any]] ?? [])
        )
    }

    static func relationships(_ raw: [[String: Any]]) -> [RecordRelationship] {
        raw.map {
            RecordRelationship(type: string($0["type"]),
                               relatedName: string($0["relatedName"]),
                               relatedId: string($0["relatedId"]))
        }
    }

    // MARK: - Derivations

    /// Inclusive intervals from every attribute of canonical kind `dob`.
    ///
    /// By kind, not by an `/birth|born|dob/i` label test — that test also matched
    /// "Place of Birth" and would read a year out of a birthplace. Intervals
    /// rather than years because the lists publish ranges: against "1975 to 1979"
    /// a year list holds only the endpoints, so 1977 read as a contradiction.
    static func birthIntervals(_ attributes: [[String: Any]]) -> [DateInterval] {
        var out: [DateInterval] = []
        for a in attributes {
            let kind = string(a["kind"]).isEmpty ? Vocab.attributeKind(string(a["label"])) : string(a["kind"])
            guard kind == "dob" else { continue }
            if let parsed = Dates.parseValue(string(a["value"])) { out.append(parsed) }
        }
        return out
    }

    /// `\b(19|20)\d\d\b` — a century-anchored year not glued to other digits.
    static func fourDigitYears(_ value: String) -> [String] {
        let chars = Array(value.utf8)
        var out: [String] = []
        var i = 0
        func isDigit(_ b: UInt8) -> Bool { b >= 48 && b <= 57 }
        // A word boundary here means "not preceded/followed by another digit or
        // letter", which for these values reduces to the digit test.
        func isWordByte(_ b: UInt8) -> Bool {
            isDigit(b) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95
        }
        while i + 3 < chars.count {
            let c0 = chars[i], c1 = chars[i + 1]
            let leadsCentury = (c0 == 49 && c1 == 57) || (c0 == 50 && c1 == 48)   // 19 or 20
            if leadsCentury, isDigit(chars[i + 2]), isDigit(chars[i + 3]) {
                let beforeOK = i == 0 || !isWordByte(chars[i - 1])
                let afterOK = i + 4 >= chars.count || !isWordByte(chars[i + 4])
                if beforeOK && afterOK {
                    out.append(String(decoding: chars[i..<(i + 4)], as: UTF8.self))
                    i += 4
                    continue
                }
            }
            i += 1
        }
        return out
    }

    /// Uppercase A-Z word tokens of every listed country, nationality and
    /// citizenship — the haystack the country modifier matches against.
    static func countryTokens(attributes: [[String: Any]], addresses: [[String: Any]]) -> [String] {
        var parts: [String] = []
        for a in addresses {
            let country = string(a["country"])
            parts.append(country.isEmpty ? string(a["full"]) : country)
        }
        for a in attributes {
            let label = string(a["label"]).lowercased()
            if label.contains("nationalit") || label.contains("citizen") {
                parts.append(string(a["value"]))
            }
        }
        let hay = parts.joined(separator: " ").uppercased()
        var out: [String] = []
        var current = [UInt8]()
        for byte in hay.utf8 {
            if byte >= 65 && byte <= 90 {
                current.append(byte)
            } else if !current.isEmpty {
                out.append(String(decoding: current, as: UTF8.self))
                current.removeAll(keepingCapacity: true)
            }
        }
        if !current.isEmpty { out.append(String(decoding: current, as: UTF8.self)) }
        return out
    }

    /// ISO-3166 codes of every listed country, nationality and citizenship,
    /// each expanded to include its sovereign parent — the surface the country
    /// modifier compares before falling back to `countryTokens`.
    ///
    /// The address line is read only where the publisher left `country` empty;
    /// thousands of addresses put the jurisdiction in the line instead
    /// ("Located in Syria"), and the string comparison this precedes did see them.
    static func countryCodes(attributes: [[String: Any]], addresses: [[String: Any]]) -> [String] {
        var out: [String] = []
        func add(_ code: String) {
            guard !code.isEmpty else { return }
            for c in Countries.expand(code) where !out.contains(c) { out.append(c) }
        }
        for a in addresses {
            let country = string(a["country"])
            if country.isEmpty { add(Countries.codeInText(string(a["full"]))) }
            else { for c in Countries.codes(country) { add(c) } }
        }
        for a in attributes {
            let kind = string(a["kind"]).isEmpty ? Vocab.attributeKind(string(a["label"])) : string(a["kind"])
            guard kind == "nationality" || kind == "citizenship" else { continue }
            for c in Countries.codes(string(a["value"])) { add(c) }
        }
        return out
    }

    /// Snapshot ids arrive as numbers for OFAC and strings elsewhere.
    static func string(_ value: Any?) -> String {
        switch value {
        case let s as String: return s
        case let i as Int: return String(i)
        case let d as Double: return d == d.rounded() ? String(Int(d)) : String(d)
        case let b as Bool: return b ? "true" : "false"
        case let n as NSNumber: return n.stringValue
        default: return ""
        }
    }
}
