import Foundation

/*
 * Turns the downloaded `cache/snapshot.json.gz` into the engine's inputs.
 *
 * The derived list/program/authority sets are rebuilt here exactly as
 * lib/ingest.js `finalizeSnapshot` builds them, because the cached file carries
 * only `meta` and `entities` — the filter pickers are derived, not transmitted.
 */
public enum SnapshotLoader {

    /// The poison-pill floor from lib/ingest.js. A snapshot that parsed almost
    /// nothing must never replace a good one: a clean run with zero hits is the
    /// worst screening failure there is.
    public static let minimumEntities = 100

    public enum Failure: LocalizedError {
        case malformed
        case poisonPill(count: Int)

        public var errorDescription: String? {
            switch self {
            case .malformed:
                return "The snapshot file could not be read."
            case .poisonPill(let count):
                return "Refusing a snapshot with only \(count) records — the previous list is kept."
            }
        }
    }

    public struct Loaded {
        public let entities: [[String: Any]]
        public let records: [ScreeningRecord]
        public let meta: SnapshotMetaData
    }

    public static func load(gzipped data: Data, pool: TokenPool = TokenPool()) throws -> Loaded {
        try load(json: try Gzip.inflate(data), pool: pool)
    }

    public static func load(json data: Data, pool: TokenPool = TokenPool()) throws -> Loaded {
        guard let root = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any],
              let entities = root["entities"] as? [[String: Any]] else {
            throw Failure.malformed
        }
        if entities.count < minimumEntities { throw Failure.poisonPill(count: entities.count) }

        var records: [ScreeningRecord] = []
        records.reserveCapacity(entities.count)
        for entity in entities { records.append(RecordBuilder.make(from: entity, pool: pool)) }

        var meta = SnapshotMetaData(from: root["meta"] as? [String: Any] ?? [:])
        meta.count = records.count
        meta.lists = Array(Set(records.map(\.list))).filter { !$0.isEmpty }.sorted()
        meta.programs = Array(Set(records.flatMap(\.programs))).filter { !$0.isEmpty }.sorted()
        meta.authorities = Array(Set(records.map(\.authority))).filter { !$0.isEmpty }.sorted()

        return Loaded(entities: entities, records: records, meta: meta)
    }
}
