import Foundation

/*
 * The scorer's view of a listed party.
 *
 * Only what screening needs is held in memory; the full record (addresses, ID
 * documents, remarks, every attribute) lives on disk and is read when the user
 * opens one. The two derived fields exist because `applyModifiers` recomputes
 * them per candidate in the JS, and doing that for 4,000 candidates a keystroke
 * is wasted work — they are pure functions of the attributes, so precomputing
 * them cannot change a score.
 */
public struct ScreeningName: Sendable {
    public let name: String
    public let type: String
    public let primary: Bool
    public let lowQuality: Bool
    public let tokens: [Token]

    public init(name: String, type: String, primary: Bool, lowQuality: Bool, pool: TokenPool) {
        self.name = name
        self.type = type.isEmpty ? "A.K.A." : type
        self.primary = primary
        self.lowQuality = lowQuality
        self.tokens = pool.tokens(name)
    }

    /// Rehydrating from the on-disk archive, where the tokens were computed at
    /// import time and the type has already been defaulted.
    init(name: String, type: String, primary: Bool, lowQuality: Bool, tokens: [Token]) {
        self.name = name
        self.type = type
        self.primary = primary
        self.lowQuality = lowQuality
        self.tokens = tokens
    }
}

public struct ScreeningIdentifier: Sendable {
    public let type: String
    public let value: String
    public let key: String

    public init(type: String, value: String) {
        self.type = type
        self.value = value
        self.key = idKey(value)
    }

    /// Rehydrating from the archive; the key was derived at import time.
    init(type: String, value: String, key: String) {
        self.type = type
        self.value = value
        self.key = key
    }
}

public struct RecordRelationship: Sendable, Hashable {
    public let type: String
    public let relatedName: String
    public let relatedId: String

    public init(type: String, relatedName: String, relatedId: String) {
        self.type = type
        self.relatedName = relatedName
        self.relatedId = relatedId
    }
}

public struct ScreeningRecord: Sendable {
    public let id: String
    public let name: String
    public let authority: String
    public let list: String
    public let type: String
    public let title: String
    public let programs: [String]
    public let datePublished: String
    public let names: [ScreeningName]
    public let identifiers: [ScreeningIdentifier]
    /// Inclusive intervals parsed from every attribute of kind `dob`. Intervals
    /// rather than years because the lists publish ranges, and a year inside a
    /// stated range used to score as a contradiction.
    public let birthIntervals: [DateInterval]
    /// Uppercase A-Z tokens of every listed country, nationality and citizenship.
    /// Only the fallback surface now — `countryCodes` is what the modifier reads
    /// first, and this is consulted when neither side resolves to a code.
    public let countryTokens: [String]
    /// ISO-3166 codes of every listed country, nationality and citizenship,
    /// expanded through the sovereign map. What the country modifier compares.
    public let countryCodes: [String]
    /// Listed relationships, kept resident because the ownership graph is built
    /// from them at query time and the whole snapshot carries only ~9k edges.
    public let relationships: [RecordRelationship]

    public var hasRelationships: Bool { !relationships.isEmpty }

    public init(id: String, name: String, authority: String, list: String, type: String,
                title: String = "", programs: [String], datePublished: String, names: [ScreeningName],
                identifiers: [ScreeningIdentifier], birthIntervals: [DateInterval],
                countryTokens: [String], countryCodes: [String],
                relationships: [RecordRelationship]) {
        self.id = id
        self.name = name
        self.authority = authority
        self.list = list
        self.type = type
        self.title = title
        self.programs = programs
        self.datePublished = datePublished
        self.names = names
        self.identifiers = identifiers
        self.birthIntervals = birthIntervals
        self.countryTokens = countryTokens
        self.countryCodes = countryCodes
        self.relationships = relationships
    }
}

public struct MatchResult: Sendable, Hashable {
    public let score: Double
    public let matchType: String
    public let matchedName: String
    public let matchedField: String
    public let explain: String
    public let corroborated: Bool
    public let conflict: Bool

    public init(score: Double, matchType: String, matchedName: String, matchedField: String,
                explain: String, corroborated: Bool, conflict: Bool) {
        self.score = score
        self.matchType = matchType
        self.matchedName = matchedName
        self.matchedField = matchedField
        self.explain = explain
        self.corroborated = corroborated
        self.conflict = conflict
    }
}

/// Secondary identifiers an analyst supplies alongside the name.
public struct Modifiers: Sendable, Equatable {
    public var yob: String
    public var country: String

    public init(yob: String = "", country: String = "") {
        self.yob = yob
        self.country = country
    }

    public var isEmpty: Bool { yob.isEmpty && country.isEmpty }
}
