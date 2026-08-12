import Foundation

/*
 * Normalization and tokenization — a 1:1 port of lib/matcher.js.
 *
 * The port is deliberately literal, including the parts that look odd: this
 * engine and the JavaScript one must return the SAME score for the same query,
 * or the phone clears a party the web flags. Tests/ConformanceTests.swift checks
 * that against fixtures generated from the JS implementation, so any "tidying"
 * here that changes a number will fail the build rather than ship a divergence.
 *
 * After `normalize` every string is ASCII (A-Z, 0-9, space), which is why tokens
 * are carried as [UInt8] and n-grams pack into fixed-width integers.
 */

// MARK: - Reference data (data/matching.json)

public struct MatchingData: Decodable, Sendable {
    public var strip: [String] = []
    public var canon: [String: String] = [:]
    public var titles: [[String]] = []
    public var confusables: [[String]] = []

    enum CodingKeys: String, CodingKey { case strip, canon, titles, confusables }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        strip = (try? c.decode([String].self, forKey: .strip)) ?? []
        canon = (try? c.decode([String: String].self, forKey: .canon)) ?? [:]
        titles = (try? c.decode([[String]].self, forKey: .titles)) ?? []
        confusables = (try? c.decode([[String]].self, forKey: .confusables)) ?? []
    }

    public init(strip: [String] = [], canon: [String: String] = [:],
                titles: [[String]] = [], confusables: [[String]] = []) {
        self.strip = strip; self.canon = canon; self.titles = titles; self.confusables = confusables
    }
}

/// Loaded once and treated as immutable for the process lifetime, mirroring the
/// `require('../data/matching.json')` the JS module does at import time.
public enum Matching {
    public private(set) static var strip: Set<String> = []
    public private(set) static var canon: [String: String] = [:]
    /// Longest first, so "PROF DR" is stripped before "DR".
    public private(set) static var titles: [[String]] = []
    /// Ordered pairs "AB" and "BA" for both directions, as the JS Set holds.
    public private(set) static var confusables: Set<UInt16> = []

    public static func load(_ data: MatchingData) {
        strip = Set(data.strip)
        canon = data.canon
        titles = data.titles.sorted { $0.count > $1.count }
        var pairs = Set<UInt16>()
        for pair in data.confusables where pair.count == 2 {
            guard let a = pair[0].utf8.first, let b = pair[1].utf8.first else { continue }
            pairs.insert(UInt16(a) << 8 | UInt16(b))
            pairs.insert(UInt16(b) << 8 | UInt16(a))
        }
        confusables = pairs
    }

    public static func load(contentsOf url: URL) throws {
        load(try JSONDecoder().decode(MatchingData.self, from: Data(contentsOf: url)))
    }

    /// The copy of data/matching.json shipped with the package, kept in lockstep
    /// with the JS reference by scripts/gen-conformance-fixtures.js.
    public static func loadBundled() {
        guard let url = Bundle.module.url(forResource: "matching", withExtension: "json") else {
            assertionFailure("matching.json missing from SanctinelCore resources")
            return
        }
        try? load(contentsOf: url)
    }

    public static var isLoaded: Bool { !strip.isEmpty }

    static func isConfusable(_ a: UInt8, _ b: UInt8) -> Bool {
        confusables.contains(UInt16(a) << 8 | UInt16(b))
    }
}

// MARK: - Normalization

/// Cyrillic letters that are visually identical to Latin ones, folded to their
/// Latin twin so a homoglyph disguise ("сompany" with a Cyrillic С) cannot slip
/// past the scorer. Applied before diacritic folding, as in the JS.
private let homoglyphs: [UnicodeScalar: UnicodeScalar] = [
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P",
    "С": "C", "Т": "T", "У": "Y", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p",
    "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
]

/// Folds per SCALAR, not per Character. The JS regex runs over UTF-16 code
/// units, so it reaches the Cyrillic letter inside a grapheme cluster that also
/// carries a combining accent ("о" + U+0301). Mapping over Swift Characters
/// would leave that cluster untouched and tokenize the name differently —
/// exactly the kind of silent divergence the conformance test exists to catch.
@inline(__always)
private func foldHomoglyphs(_ s: String) -> String {
    guard s.unicodeScalars.contains(where: { $0.value >= 0x0400 && $0.value <= 0x045F }) else { return s }
    var out = String.UnicodeScalarView()
    out.reserveCapacity(s.unicodeScalars.count)
    for scalar in s.unicodeScalars { out.append(homoglyphs[scalar] ?? scalar) }
    return String(out)
}

@inline(__always)
private func stripDiacritics(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in s.decomposedStringWithCanonicalMapping.unicodeScalars
    where !(scalar.value >= 0x0300 && scalar.value <= 0x036F) {
        out.append(scalar)
    }
    return String(out)
}

/// Uppercase, ASCII-folded, everything else collapsed to single spaces.
public func normalize(_ raw: String) -> String {
    if raw.isEmpty { return "" }
    let upper = stripDiacritics(foldHomoglyphs(raw)).uppercased()
    var out = [UInt8]()
    out.reserveCapacity(upper.utf8.count)
    var pendingSpace = false
    for byte in upper.utf8 {
        let isKept = (byte >= 65 && byte <= 90) || (byte >= 48 && byte <= 57)
        if isKept {
            if pendingSpace && !out.isEmpty { out.append(32) }
            pendingSpace = false
            out.append(byte)
        } else {
            // Every non-alphanumeric run — including the continuation bytes of a
            // multi-byte scalar — becomes one separator.
            pendingSpace = true
        }
    }
    return String(decoding: out, as: UTF8.self)
}

/// Strip a single leading personal title (Mr, Dr, Prof Dr, …) if tokens remain.
private func stripTitles(_ words: [String]) -> [String] {
    for title in Matching.titles where words.count > title.count {
        var matches = true
        for (i, word) in title.enumerated() {
            if words[i] != word { matches = false; break }
        }
        if matches { return Array(words.dropFirst(title.count)) }
    }
    return words
}

/// The scorer's view of a name: title-stripped, legal-form descriptors removed,
/// domain tokens canonicalized — and never reduced to nothing.
public func tokenStrings(_ raw: String) -> [String] {
    let all = stripTitles(normalize(raw).split(separator: " ").map(String.init))
    var kept: [String] = []
    kept.reserveCapacity(all.count)
    for t in all where !Matching.strip.contains(t) {
        kept.append(Matching.canon[t].map { $0.uppercased() } ?? t)
    }
    return kept.isEmpty ? all : kept
}

/// Alphanumeric-only key for identifier comparison.
public func idKey(_ raw: String) -> String {
    var out = [UInt8]()
    out.reserveCapacity(raw.utf8.count)
    for byte in raw.uppercased().utf8 where (byte >= 65 && byte <= 90) || (byte >= 48 && byte <= 57) {
        out.append(byte)
    }
    return String(decoding: out, as: UTF8.self)
}

// MARK: - Token

/*
 * One normalized token, with its expensive derivations computed once.
 *
 * The JS memoizes these in module-level Maps keyed by the token string; interning
 * tokens gives the same reuse (the corpus is 104k names over far fewer distinct
 * tokens) without a dictionary lookup on every comparison. A class, not a struct,
 * so the cached fields are shared by every record holding the token.
 */
public final class Token: Hashable, @unchecked Sendable {
    public let text: String
    public let bytes: [UInt8]

    private var _fold: [UInt8]?
    private var _metaphone: [UInt8]?
    private var _sortedBigrams: [UInt16]?
    private var _paddedTrigrams: Set<UInt32>?

    init(_ text: String) {
        self.text = text
        self.bytes = Array(text.utf8)
    }

    public var count: Int { bytes.count }

    var fold: [UInt8] {
        if let f = _fold { return f }
        let f = foldTranslitRaw(bytes)
        _fold = f
        return f
    }

    var metaphone: [UInt8] {
        if let m = _metaphone { return m }
        let m = metaphoneRaw(bytes)
        _metaphone = m
        return m
    }

    /// Sorted so Dice can intersect two cached arrays by merge.
    var sortedBigrams: [UInt16] {
        if let b = _sortedBigrams { return b }
        var out = [UInt16]()
        if bytes.count >= 2 {
            out.reserveCapacity(bytes.count - 1)
            for i in 0..<(bytes.count - 1) {
                out.append(UInt16(bytes[i]) << 8 | UInt16(bytes[i + 1]))
            }
            out.sort()
        }
        _sortedBigrams = out
        return out
    }

    /// Trigrams of "  TOKEN  ", as in the JS padded set.
    var paddedTrigrams: Set<UInt32> {
        if let t = _paddedTrigrams { return t }
        var padded = [UInt8](repeating: 32, count: bytes.count + 4)
        for (i, b) in bytes.enumerated() { padded[i + 2] = b }
        var set = Set<UInt32>()
        if padded.count >= 3 {
            set.reserveCapacity(padded.count - 2)
            for i in 0...(padded.count - 3) {
                set.insert(UInt32(padded[i]) << 16 | UInt32(padded[i + 1]) << 8 | UInt32(padded[i + 2]))
            }
        }
        _paddedTrigrams = set
        return set
    }

    public static func == (lhs: Token, rhs: Token) -> Bool { lhs === rhs || lhs.text == rhs.text }
    public func hash(into hasher: inout Hasher) { hasher.combine(text) }
}

/// Interning table. Corpus tokens are built once and shared; query tokens hit the
/// same table, so a query token against 4,000 candidates reuses one cached fold.
public final class TokenPool: @unchecked Sendable {
    public static let shared = TokenPool()
    private var pool: [String: Token] = [:]
    private let lock = NSLock()

    public init() {}

    public func token(_ text: String) -> Token {
        lock.lock()
        defer { lock.unlock() }
        if let existing = pool[text] { return existing }
        let made = Token(text)
        pool[text] = made
        return made
    }

    public func tokens(_ raw: String) -> [Token] {
        tokenStrings(raw).map(token)
    }

    public func reset() {
        lock.lock()
        pool.removeAll(keepingCapacity: false)
        lock.unlock()
    }
}

/// Convenience matching the JS `tokens(raw)` export.
public func tokens(_ raw: String) -> [Token] { TokenPool.shared.tokens(raw) }
