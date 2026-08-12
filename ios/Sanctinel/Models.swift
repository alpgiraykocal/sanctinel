import Foundation

// The full listed record, as stored on device.
//
// Search, statistics and the ownership graph all run through SanctinelCore; this
// type exists only to render the detail screen, which needs the parts of a
// record the scorer never looks at — addresses, identity documents, attributes,
// remarks. It is decoded from the record blob on demand.
//
// Every field falls back to a default when the key is missing OR carries an
// unexpected type. Synthesized Decodable would fail the whole record over one
// renamed key; a screening tool should instead lose one section and keep showing
// the hit. `LooseString` covers fields the sources type differently (publication
// ids are numbers for OFAC, strings elsewhere).

extension KeyedDecodingContainer {
    func get<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        // `try?` flattens the optional decodeIfPresent returns, so a missing key
        // and a key holding the wrong type both land on the fallback.
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }
}

/// A JSON scalar rendered as text, whether the server sent a string or a number.
struct LooseString: Decodable, Hashable {
    let value: String

    init(_ value: String) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let i = try? c.decode(Int.self) { value = String(i) }
        else if let d = try? c.decode(Double.self) { value = String(d) }
        else if let b = try? c.decode(Bool.self) { value = b ? "true" : "false" }
        else { value = "" }
    }
}

// MARK: - Full record

struct Entity: Decodable, Identifiable, Hashable {
    var id = ""
    var name = ""
    var authority = ""
    var list = ""
    var type = ""
    var title = ""
    var programs: [String] = []
    var sanctionsTypes: [String] = []
    var legalAuthorities: [String] = []
    var datePublished = ""
    var names: [NameRecord] = []
    var addresses: [Address] = []
    var idDocuments: [IDDocument] = []
    var relationships: [Relationship] = []
    var attributes: [Attribute] = []
    var identifiers: [Identifier] = []
    var remarks = ""

    // Match evidence — present on search hits only.
    var score: Double = 0
    var matchType = ""
    var matchedName = ""
    var matchedField = ""
    var explain = ""
    var corroborated = false
    var conflict = false

    init() {}

    enum CodingKeys: String, CodingKey {
        case id, name, authority, list, type, title, programs, sanctionsTypes
        case legalAuthorities, datePublished, names, addresses, idDocuments
        case relationships, attributes, identifiers, remarks
        case score, matchType, matchedName, matchedField, explain, corroborated, conflict
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, LooseString("")).value
        name = c.get(.name, "")
        authority = c.get(.authority, "")
        list = c.get(.list, "")
        type = c.get(.type, "")
        title = c.get(.title, "")
        programs = c.get(.programs, [])
        sanctionsTypes = c.get(.sanctionsTypes, [])
        legalAuthorities = c.get(.legalAuthorities, [])
        datePublished = c.get(.datePublished, "")
        names = c.get(.names, [])
        addresses = c.get(.addresses, [])
        idDocuments = c.get(.idDocuments, [])
        relationships = c.get(.relationships, [])
        attributes = c.get(.attributes, [])
        identifiers = c.get(.identifiers, [])
        remarks = c.get(.remarks, "")
        score = c.get(.score, 0)
        matchType = c.get(.matchType, "")
        matchedName = c.get(.matchedName, "")
        matchedField = c.get(.matchedField, "")
        explain = c.get(.explain, "")
        corroborated = c.get(.corroborated, false)
        conflict = c.get(.conflict, false)
    }

    struct NameRecord: Decodable, Hashable, Identifiable {
        var name = ""
        var type = ""
        var primary = false
        var lowQuality = false
        var script = ""
        var native = ""
        var parts: [String] = []
        var id: String { "\(name)|\(type)|\(native)" }

        enum CodingKeys: String, CodingKey { case name, type, primary, lowQuality, script, native, parts }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = c.get(.name, "")
            type = c.get(.type, "")
            primary = c.get(.primary, false)
            lowQuality = c.get(.lowQuality, false)
            script = c.get(.script, "")
            native = c.get(.native, "")
            parts = c.get(.parts, [])
        }
    }

    struct Address: Decodable, Hashable, Identifiable {
        var full = ""
        var country = ""
        var id: String { full.isEmpty ? country : full }

        enum CodingKeys: String, CodingKey { case full, country }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            full = c.get(.full, "")
            country = c.get(.country, "")
        }
    }

    struct IDDocument: Decodable, Hashable, Identifiable {
        var type = ""
        var number = ""
        var issuingCountry = ""
        var issueDate = ""
        var expirationDate = ""
        var id: String { "\(type)|\(number)" }

        enum CodingKeys: String, CodingKey { case type, number, issuingCountry, issueDate, expirationDate }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = c.get(.type, "")
            number = c.get(.number, LooseString("")).value
            issuingCountry = c.get(.issuingCountry, "")
            issueDate = c.get(.issueDate, "")
            expirationDate = c.get(.expirationDate, "")
        }
    }

    struct Relationship: Decodable, Hashable, Identifiable {
        var type = ""
        var relatedName = ""
        var relatedId = ""
        var id: String { "\(type)|\(relatedId)|\(relatedName)" }
        /// The 50 Percent Rule edges the server labels as ownership.
        var isOwnership: Bool { type.lowercased().contains("own") }

        enum CodingKeys: String, CodingKey { case type, relatedName, relatedId }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = c.get(.type, "")
            relatedName = c.get(.relatedName, "")
            relatedId = c.get(.relatedId, LooseString("")).value
        }
    }

    struct Attribute: Decodable, Hashable, Identifiable {
        var group = ""
        var label = ""
        var value = ""
        var id: String { "\(group)|\(label)|\(value)" }

        enum CodingKeys: String, CodingKey { case group, label, value }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            group = c.get(.group, "")
            label = c.get(.label, "")
            value = c.get(.value, LooseString("")).value
        }
    }

    struct Identifier: Decodable, Hashable, Identifiable {
        var type = ""
        var value = ""
        var id: String { "\(type)|\(value)" }

        enum CodingKeys: String, CodingKey { case type, value }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = c.get(.type, "")
            value = c.get(.value, LooseString("")).value
        }
    }

    /// Attributes in server order, grouped by their `group` label.
    var attributeGroups: [(group: String, items: [Attribute])] {
        var order: [String] = []
        var byGroup: [String: [Attribute]] = [:]
        for a in attributes {
            if byGroup[a.group] == nil { order.append(a.group) }
            byGroup[a.group, default: []].append(a)
        }
        return order.map { ($0, byGroup[$0] ?? []) }
    }

    var primaryCountry: String {
        if let c = addresses.first(where: { !$0.country.isEmpty })?.country { return c }
        if let n = attributes.first(where: { $0.label == "Nationality" || $0.label == "Citizenship" }) { return n.value }
        return ""
    }

    var aliases: [NameRecord] { names.filter { !$0.primary } }

    var ownershipLinks: [Relationship] { relationships.filter { $0.isOwnership } }
}

extension Entity {
    /// Records come off the on-device blob as dictionaries; round-tripping them
    /// through the decoder reuses the lenient decoding above rather than
    /// duplicating it for a second representation.
    init?(dictionary: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dictionary),
              let decoded = try? JSONDecoder().decode(Entity.self, from: data) else { return nil }
        self = decoded
    }
}
