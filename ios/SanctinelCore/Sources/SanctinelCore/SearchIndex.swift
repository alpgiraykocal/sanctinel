import Foundation

/*
 * Candidate prefilter — a 1:1 port of lib/searchindex.js.
 *
 * RECALL INVARIANT. Every scoring channel in Matcher that can reach the 0.95
 * default threshold must be reproducible from this index, or the fast path
 * silently returns fewer hits than a full scan — a false negative, the worst
 * failure mode in screening. The three channels that do not follow from raw
 * character overlap are indexed explicitly: transliteration variants (trigrams of
 * the FOLDED form, namespaced), acronyms/initialisms, and exact identifiers.
 * Metaphone tops out at 0.92, below the default floor, so a phonetic-only hit
 * cannot clear it on a single-token query.
 *
 * Below the default threshold the engine full-scans instead, so the invariant
 * only has to hold at 0.95. RecallTests checks fast path == full scan.
 */

private let gramOverlapRatio = 0.25
private let shortTokenMax = 7
private let minSharedBigrams = 2
/// A single edit cannot move a token's length further than this, so a
/// length-incompatible token can be rejected without touching the entity.
private let maxLenDelta = 1

// MARK: - Gram encoding

/// A trigram of ASCII packs into 24 bits; bit 31 namespaces the folded form, and
/// a zero third byte marks the two-character gram a very short string produces.
@inline(__always)
private func packGram(_ a: UInt8, _ b: UInt8, _ c: UInt8, folded: Bool) -> UInt32 {
    let base = UInt32(a) << 16 | UInt32(b) << 8 | UInt32(c)
    return folded ? base | 0x8000_0000 : base
}

private func appendTrigrams(_ s: [UInt8], folded: Bool, into out: inout [UInt32], seen: inout Set<UInt32>) {
    func add(_ g: UInt32) {
        if seen.insert(g).inserted { out.append(g) }
    }
    if s.count < 3 {
        if s.count >= 2 { add(packGram(s[0], s[1], 0, folded: folded)) }
        return
    }
    for i in 0...(s.count - 3) {
        add(packGram(s[i], s[i + 1], s[i + 2], folded: folded))
    }
}

/// Grams are built from the SCORER's tokens, not the raw name: tokenizing drops
/// legal-form descriptors (COMPANY, GROUP, OOO …) that contribute nothing to the
/// score, and indexing them inflated the query's gram count and with it the
/// overlap floor.
/// Returns the grams in INSERTION order, deduplicated. A JavaScript Set iterates
/// in insertion order, and `candidates` walks the query's grams in that order to
/// build its candidate list — so a plain Swift Set, whose iteration order is
/// hash-derived, would hand back the same candidates in a different sequence and
/// rank equal-scoring hits differently from the web app.
func gramSet(_ tokenList: [Token]) -> [UInt32] {
    var joined = [UInt8]()
    for t in tokenList { joined.append(contentsOf: t.bytes) }
    var out = [UInt32]()
    var seen = Set<UInt32>()
    appendTrigrams(joined, folded: false, into: &out, seen: &seen)
    appendTrigrams(foldTranslitRaw(joined), folded: true, into: &out, seen: &seen)
    return out
}

/// Initials of a name's significant tokens — the key acronymScore compares a
/// short single-token query against.
func acronymOf(_ tokenList: [Token]) -> String {
    if tokenList.count < 2 || tokenList.count > 6 { return "" }
    var initials = [UInt8]()
    for t in tokenList where !t.bytes.isEmpty { initials.append(t.bytes[0]) }
    guard initials.count >= 2, initials.count <= 6 else { return "" }
    return String(decoding: initials, as: UTF8.self)
}

/// Bigrams of SHORT tokens, kept in their own lane. On a short token a single
/// transposition destroys every trigram — GHSAIR vs GHASIR share none — yet
/// Jaro-Winkler scores it 0.96. Bigrams survive that.
func bigramsOfShortToken(_ t: Token) -> [UInt16] {
    let s = t.bytes
    if s.count < 3 || s.count > shortTokenMax { return [] }
    var out = [UInt16]()
    out.reserveCapacity(s.count - 1)
    for i in 0..<(s.count - 1) { out.append(UInt16(s[i]) << 8 | UInt16(s[i + 1])) }
    return out
}

// MARK: - CSR posting lists

/*
 * Postings are stored CSR-style: one flat array of entity indices plus an offset
 * table, rather than a dictionary of per-key arrays. Measured over the 38k
 * snapshot that is 2.3M postings across 70k keys — a third of the memory of
 * arrays-of-arrays, and a sequential walk instead of chasing pointers. It also
 * means the built index can be written to disk verbatim and read back on launch
 * instead of being rebuilt every time the app starts.
 */
public struct PostingList<Key: Hashable> {
    var slots: [Key: Int32] = [:]
    var offsets: [Int32] = [0]
    var values: [Int32] = []
    /// Token lengths, packed alongside the bigram lane only.
    var lengths: [UInt8] = []

    var carriesLengths: Bool { !lengths.isEmpty }

    init() {}

    init(_ map: [Key: [Int32]], withLengths: Bool) {
        slots.reserveCapacity(map.count)
        offsets = [Int32](repeating: 0, count: map.count + 1)
        var total = 0
        var i = 0
        for (key, list) in map {
            slots[key] = Int32(i)
            offsets[i] = Int32(total)
            total += list.count
            i += 1
        }
        offsets[map.count] = Int32(total)
        values = [Int32](repeating: 0, count: total)
        if withLengths { lengths = [UInt8](repeating: 0, count: total) }
        var p = 0
        // Same iteration order as the slot assignment above: Dictionary iteration
        // is stable for an untouched dictionary, and nothing mutates it here.
        for (key, list) in map {
            var q = Int(offsets[Int(slots[key]!)])
            for v in list {
                if withLengths {
                    values[q] = v & 0xff_ffff
                    lengths[q] = UInt8(truncatingIfNeeded: v >> 24)
                } else {
                    values[q] = v
                }
                q += 1
            }
            p += list.count
        }
        precondition(p == total)
    }

    @inline(__always)
    func each(_ key: Key, _ body: (Int32, UInt8) -> Void) {
        guard let slot = slots[key] else { return }
        let start = Int(offsets[Int(slot)]), end = Int(offsets[Int(slot) + 1])
        if carriesLengths {
            for i in start..<end { body(values[i], lengths[i]) }
        } else {
            for i in start..<end { body(values[i], 0) }
        }
    }
}

// MARK: - Index

public struct SearchIndexData {
    var gram = PostingList<UInt32>()
    var identifiers = PostingList<String>()
    var acronyms = PostingList<String>()
    var bigrams = PostingList<UInt16>()
    public var count: Int = 0
}

public enum SearchIndex {
    public static func build(_ records: [ScreeningRecord]) -> SearchIndexData {
        var gram: [UInt32: [Int32]] = [:]
        var identifiers: [String: [Int32]] = [:]
        var acronyms: [String: [Int32]] = [:]
        var bigrams: [UInt16: [Int32]] = [:]
        gram.reserveCapacity(1 << 17)

        for (index, record) in records.enumerated() {
            let i = Int32(index)
            var grams = Set<UInt32>()
            var acr = Set<String>()
            // Keyed by bigram + the length of the token it came from, so the same
            // bigram from tokens of different lengths stays distinguishable.
            var bg = Set<UInt32>()

            for name in record.names {
                for g in gramSet(name.tokens) { grams.insert(g) }
                let a = acronymOf(name.tokens)
                if !a.isEmpty { acr.insert(a) }
                for token in name.tokens {
                    let len = UInt32(min(255, token.count))
                    for b in bigramsOfShortToken(token) {
                        bg.insert(UInt32(b) << 8 | len)
                    }
                }
            }

            for g in grams { gram[g, default: []].append(i) }
            for a in acr { acronyms[a, default: []].append(i) }
            for packed in bg {
                let b = UInt16(truncatingIfNeeded: packed >> 8)
                let len = Int32(packed & 0xff)
                // Each posting carries the token length in its high byte: the
                // typos this lane exists to catch cannot change a token's length
                // by more than one, so a length-incompatible token is rejected
                // without ever touching the entity — which is where the cost was.
                bigrams[b, default: []].append((len << 24) | i)
            }
            for id in record.identifiers where id.key.count >= 4 {
                identifiers[id.key, default: []].append(i)
            }
        }

        var out = SearchIndexData()
        out.gram = PostingList(gram, withLengths: false)
        out.identifiers = PostingList(identifiers, withLengths: false)
        out.acronyms = PostingList(acronyms, withLengths: false)
        out.bigrams = PostingList(bigrams, withLengths: true)
        out.count = records.count
        return out
    }

    /// Entity indices to score, or nil for "full scan".
    public static func candidates(_ index: SearchIndexData, query: String) -> [Int32]? {
        let qt = tokens(query)
        var joined = [UInt8]()
        for t in qt { joined.append(contentsOf: t.bytes) }
        if joined.count < 3 { return nil }          // too short for trigrams
        let qg = gramSet(qt)
        if qg.isEmpty { return nil }

        var counts = [Int32](repeating: 0, count: index.count)
        var touched = [Int32]()
        for g in qg {
            index.gram.each(g) { i, _ in
                if counts[Int(i)] == 0 { touched.append(i) }
                counts[Int(i)] += 1
            }
        }

        // Share at least ~25% of the query's trigrams. The floor is 1, not 2: a
        // short query ("Soe Win") has so few trigrams that a strong token match
        // can legitimately overlap on only one, and a floor of 2 dropped those.
        let minShared = Int32(max(1, Int(Double(qg.count) * gramOverlapRatio)))
        var out = [Int32]()
        var inOut = [Bool](repeating: false, count: index.count)
        for i in touched where counts[Int(i)] >= minShared {
            out.append(i)
            inOut[Int(i)] = true
        }

        // Exact identifier hits — an id-number query shares no name grams.
        let idk = idKey(query)
        if idk.count >= 4 {
            index.identifiers.each(idk) { i, _ in
                if !inOut[Int(i)] { out.append(i); inOut[Int(i)] = true }
            }
        }

        // Acronym hits: "CCC" ↔ China Communications Construction Company scores
        // 0.97 on a full scan but shares no trigram with the name it stands for.
        if qt.count == 1, qt[0].count >= 2, qt[0].count <= 6 {
            index.acronyms.each(qt[0].text) { i, _ in
                if !inOut[Int(i)] { out.append(i); inOut[Int(i)] = true }
            }
        }

        // Short-token bigram lane.
        var bigramCounts = [Int32](repeating: 0, count: index.count)
        for t in qt {
            let bg = bigramsOfShortToken(t)
            if bg.count < minSharedBigrams { continue }
            var seen = [Int32]()
            for b in bg {
                index.bigrams.each(b) { i, len in
                    if inOut[Int(i)] { return }
                    if abs(Int(len) - t.count) > maxLenDelta { return }
                    if bigramCounts[Int(i)] == 0 { seen.append(i) }
                    bigramCounts[Int(i)] += 1
                }
            }
            for i in seen {
                if bigramCounts[Int(i)] >= Int32(minSharedBigrams), !inOut[Int(i)] {
                    out.append(i)
                    inOut[Int(i)] = true
                }
                bigramCounts[Int(i)] = 0
            }
        }

        return out
    }
}
