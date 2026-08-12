import Foundation

/*
 * The search path, ported from server.js `search()` so the phone applies the
 * same threshold clamp, the same full-scan fallback below the default, the same
 * ordering and the same truncation reporting as the web app.
 */

public struct SnapshotMetaData: Sendable, Equatable {
    public var source = ""
    public var isLive = false
    public var publicationId = ""
    public var publishedDate = ""
    public var retrievedAt = ""
    public var count = 0
    public var lists: [String] = []
    public var programs: [String] = []
    public var authorities: [String] = []

    public init() {}

    public init(from dict: [String: Any]) {
        source = RecordBuilder.string(dict["source"])
        isLive = dict["isLive"] as? Bool ?? false
        publicationId = RecordBuilder.string(dict["publicationId"])
        publishedDate = RecordBuilder.string(dict["publishedDate"])
        retrievedAt = RecordBuilder.string(dict["retrievedAt"])
        count = dict["count"] as? Int ?? 0
        lists = dict["lists"] as? [String] ?? []
        programs = dict["programs"] as? [String] ?? []
        authorities = dict["authorities"] as? [String] ?? []
    }
}

public struct SearchQueryOptions: Sendable, Equatable {
    public var query: String
    public var threshold: Double
    public var authority: String
    public var list: String
    public var program: String
    public var mods: Modifiers?

    public init(query: String, threshold: Double = 0.95, authority: String = "",
                list: String = "", program: String = "", mods: Modifiers? = nil) {
        self.query = query
        self.threshold = threshold
        self.authority = authority
        self.list = list
        self.program = program
        self.mods = mods
    }
}

public struct Hit: Sendable {
    public let recordIndex: Int
    public let id: String
    public let match: MatchResult
}

public struct SearchOutcome: Sendable {
    public let query: String
    public let threshold: Double
    /// Every hit above the threshold — not the number returned.
    public let count: Int
    public let truncated: Bool
    public let hits: [Hit]
    /// True when the query was scored against the whole list rather than the
    /// candidate index, which the UI reports because it is markedly slower.
    public let fullScan: Bool
}

public final class ScreeningEngine: @unchecked Sendable {
    public static let maxResults = 200
    public static let maxQueryLength = 120
    public static let defaultThreshold = 0.95

    public let records: [ScreeningRecord]
    public let meta: SnapshotMetaData
    private let index: SearchIndexData
    /// Record id to position, so a screen holding an id (the Insights feed, a
    /// graph node) can open the record without scanning the list.
    private let positionByID: [String: Int]

    public init(records: [ScreeningRecord], meta: SnapshotMetaData, index: SearchIndexData) {
        self.records = records
        self.meta = meta
        self.index = index
        var positions = [String: Int](minimumCapacity: records.count)
        for (i, record) in records.enumerated() where positions[record.id] == nil {
            positions[record.id] = i
        }
        positionByID = positions
    }

    public func recordIndex(forID id: String) -> Int? { positionByID[id] }

    /// Builds the index and the IDF corpus for a freshly loaded snapshot.
    public static func make(records: [ScreeningRecord], meta: SnapshotMetaData) -> ScreeningEngine {
        Corpus.shared.set(df: Corpus.documentFrequencies(records), n: records.count)
        return ScreeningEngine(records: records, meta: meta, index: SearchIndex.build(records))
    }

    public func search(_ options: SearchQueryOptions) -> SearchOutcome {
        let q = String(options.query.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(Self.maxQueryLength))
        let threshold = min(1, max(0.8, options.threshold))
        if q.isEmpty {
            return SearchOutcome(query: q, threshold: threshold, count: 0, truncated: false,
                                 hits: [], fullScan: false)
        }

        // At the default threshold the candidate index is recall-safe: every
        // channel that can reach 0.95 is reproducible from it. Below the default
        // — an analyst deliberately widening the net — scan the full list,
        // because no cheap index covers what the scorer will accept down there.
        let candidateList = threshold >= Self.defaultThreshold
            ? SearchIndex.candidates(index, query: q)
            : nil
        let pool: [Int32]
        if let candidateList {
            pool = candidateList
        } else {
            pool = Array(Int32(0)..<Int32(records.count))
        }

        var hits: [Hit] = []
        // Position in the POOL, not the record index. The candidate list comes
        // back in the order the index lanes touched it, and V8's stable sort
        // preserves exactly that among equal scores — tie-breaking on the record
        // index instead would rank equal-scoring hits differently from the web.
        var order: [Int] = []
        for (position, i) in pool.enumerated() {
            let record = records[Int(i)]
            if !options.authority.isEmpty, record.authority != options.authority { continue }
            if !options.list.isEmpty, record.list != options.list { continue }
            if !options.program.isEmpty, !record.programs.contains(options.program) { continue }
            guard let match = screenEntity(q, record, floor: threshold, mods: options.mods) else { continue }
            hits.append(Hit(recordIndex: Int(i), id: record.id, match: match))
            order.append(position)
        }

        let ranking = zip(hits, order).sorted { a, b in
            a.0.match.score == b.0.match.score ? a.1 < b.1 : a.0.match.score > b.0.match.score
        }
        hits = ranking.map(\.0)

        let count = hits.count
        return SearchOutcome(
            query: q,
            threshold: threshold,
            count: count,
            truncated: count > Self.maxResults,
            hits: Array(hits.prefix(Self.maxResults)),
            fullScan: candidateList == nil
        )
    }

    /// Full scan at any threshold — the reference the recall test compares the
    /// indexed path against.
    public func fullScan(_ options: SearchQueryOptions) -> [Hit] {
        let q = String(options.query.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(Self.maxQueryLength))
        let threshold = min(1, max(0.8, options.threshold))
        var hits: [Hit] = []
        for (i, record) in records.enumerated() {
            if !options.authority.isEmpty, record.authority != options.authority { continue }
            if !options.list.isEmpty, record.list != options.list { continue }
            if !options.program.isEmpty, !record.programs.contains(options.program) { continue }
            guard let match = screenEntity(q, record, floor: threshold, mods: options.mods) else { continue }
            hits.append(Hit(recordIndex: i, id: record.id, match: match))
        }
        hits.sort { a, b in
            a.match.score == b.match.score ? a.recordIndex < b.recordIndex : a.match.score > b.match.score
        }
        return hits
    }
}
