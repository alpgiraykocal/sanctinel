import Foundation

/*
 * The device's copy of the list.
 *
 * Import happens once per snapshot: inflate, parse, build the search corpus, the
 * candidate index and the statistics, then write all of it to Application
 * Support. Everything after that — launching, searching, opening a record,
 * drawing a network, reading the Insights tab — is local, so the app works with
 * no network at all and a query never leaves the phone.
 *
 * Full records are kept in an offset-indexed blob rather than in memory: the
 * scorer needs names and identifiers, but addresses, documents, attributes and
 * remarks are only needed for the one record the analyst opened.
 */
public final class SnapshotStore: @unchecked Sendable {

    public struct Manifest: Codable, Sendable {
        public var formatVersion: Int
        public var recordCount: Int
        public var importedAt: Date
        /// Publication date from the snapshot, which is what "how old is my list"
        /// must be measured against — not when the phone downloaded it.
        public var publishedDate: String
        public var publicationId: String
        public var source: String
        /// ETag of the file this was built from, for the conditional GET.
        public var etag: String
        public var bytes: Int

        // 2: the corpus archive carries per-record countryCodes. A stored v1
        // snapshot is discarded and rebuilt rather than read without them —
        // reading it would silently screen against the old string comparison.
        public static let currentFormat = 2
    }

    public struct Loaded {
        public let engine: ScreeningEngine
        public let relationships: RelationshipGraph
        public let stats: SnapshotStats
        public let manifest: Manifest
    }

    public enum Failure: LocalizedError {
        case notImported
        case formatChanged

        public var errorDescription: String? {
            switch self {
            case .notImported: return "No list has been downloaded yet."
            case .formatChanged: return "The stored list uses an older format and will be rebuilt."
            }
        }
    }

    public let directory: URL
    private let fileManager = FileManager.default

    public init(directory: URL) {
        self.directory = directory
    }

    /// The default location: Application Support, excluded from iCloud backup —
    /// it is a rebuildable cache of a public list, not user data.
    public static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory,
                                               in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        return base.appendingPathComponent("Snapshot", isDirectory: true)
    }

    private var manifestURL: URL { directory.appendingPathComponent("manifest.json") }
    private var corpusURL: URL { directory.appendingPathComponent("corpus.bin") }
    private var indexURL: URL { directory.appendingPathComponent("index.bin") }
    private var statsURL: URL { directory.appendingPathComponent("stats.json") }
    private var recordsURL: URL { directory.appendingPathComponent("records.bin") }
    private var offsetsURL: URL { directory.appendingPathComponent("records.idx") }

    public var hasSnapshot: Bool {
        fileManager.fileExists(atPath: manifestURL.path) && fileManager.fileExists(atPath: corpusURL.path)
    }

    public func manifest() -> Manifest? {
        guard let data = try? Data(contentsOf: manifestURL) else { return nil }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }

    // MARK: - Import

    public struct ImportProgress: Sendable {
        public let stage: Stage
        public enum Stage: String, Sendable {
            case inflating, parsing, indexing, analysing, writing, done
        }
    }

    /// Builds every artifact from a downloaded `snapshot.json.gz` and swaps them
    /// in. Writes to a staging directory first: a snapshot that fails halfway
    /// must never leave the app with half of one list and half of another.
    @discardableResult
    public func importSnapshot(gzipped data: Data, etag: String,
                               progress: ((ImportProgress) -> Void)? = nil) throws -> Manifest {
        progress?(ImportProgress(stage: .inflating))
        let json = try Gzip.inflate(data)

        progress?(ImportProgress(stage: .parsing))
        let pool = TokenPool()
        let loaded = try SnapshotLoader.load(json: json, pool: pool)

        progress?(ImportProgress(stage: .indexing))
        Corpus.shared.set(df: Corpus.documentFrequencies(loaded.records), n: loaded.records.count)
        let index = SearchIndex.build(loaded.records)

        progress?(ImportProgress(stage: .analysing))
        let stats = StatsBuilder.compute(entities: loaded.entities)

        progress?(ImportProgress(stage: .writing))
        let staging = directory.appendingPathComponent("staging", isDirectory: true)
        try? fileManager.removeItem(at: staging)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)

        try CorpusArchive.encode(records: loaded.records, meta: loaded.meta)
            .write(to: staging.appendingPathComponent("corpus.bin"), options: .atomic)
        try IndexArchive.encode(index)
            .write(to: staging.appendingPathComponent("index.bin"), options: .atomic)
        try JSONEncoder().encode(stats)
            .write(to: staging.appendingPathComponent("stats.json"), options: .atomic)
        try writeRecords(loaded.entities, to: staging)

        let manifest = Manifest(
            formatVersion: Manifest.currentFormat,
            recordCount: loaded.records.count,
            importedAt: Date(),
            publishedDate: loaded.meta.publishedDate,
            publicationId: loaded.meta.publicationId,
            source: loaded.meta.source,
            etag: etag,
            bytes: data.count
        )
        try JSONEncoder().encode(manifest)
            .write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)

        // Promote: move each finished file over the live one. The manifest goes
        // last, so an interruption leaves the previous manifest pointing at
        // files that still parse.
        for name in ["corpus.bin", "index.bin", "stats.json", "records.bin", "records.idx", "manifest.json"] {
            let from = staging.appendingPathComponent(name)
            let to = directory.appendingPathComponent(name)
            guard fileManager.fileExists(atPath: from.path) else { continue }
            _ = try? fileManager.removeItem(at: to)
            try fileManager.moveItem(at: from, to: to)
        }
        try? fileManager.removeItem(at: staging)
        excludeFromBackup()

        progress?(ImportProgress(stage: .done))
        return manifest
    }

    private func writeRecords(_ entities: [[String: Any]], to staging: URL) throws {
        var blob = Data()
        blob.reserveCapacity(entities.count * 900)
        var offsets = [UInt64]()
        offsets.reserveCapacity(entities.count + 1)
        offsets.append(0)
        for entity in entities {
            if let encoded = try? JSONSerialization.data(withJSONObject: entity, options: []) {
                blob.append(encoded)
            }
            offsets.append(UInt64(blob.count))
        }
        try blob.write(to: staging.appendingPathComponent("records.bin"), options: .atomic)

        var offsetData = Data(capacity: offsets.count * 8)
        for value in offsets {
            withUnsafeBytes(of: value.littleEndian) { offsetData.append(contentsOf: $0) }
        }
        try offsetData.write(to: staging.appendingPathComponent("records.idx"), options: .atomic)
    }

    // MARK: - Load

    public func load(pool: TokenPool = TokenPool.shared) throws -> Loaded {
        guard hasSnapshot, let manifest = manifest() else { throw Failure.notImported }
        guard manifest.formatVersion == Manifest.currentFormat else { throw Failure.formatChanged }

        let corpus = try CorpusArchive.decode(try Data(contentsOf: corpusURL, options: .mappedIfSafe), pool: pool)
        let index = try IndexArchive.decode(try Data(contentsOf: indexURL, options: .mappedIfSafe))
        let stats = (try? JSONDecoder().decode(SnapshotStats.self, from: Data(contentsOf: statsURL)))
            ?? SnapshotStats()

        // The IDF weighting is corpus-wide and is not stored: recomputing it is a
        // single pass over the already-tokenized names, far cheaper than the
        // archive read that precedes it.
        Corpus.shared.set(df: Corpus.documentFrequencies(corpus.records), n: corpus.records.count)

        let engine = ScreeningEngine(records: corpus.records, meta: corpus.meta, index: index)
        let relationships = RelationshipGraph(records: corpus.records)
        return Loaded(engine: engine, relationships: relationships, stats: stats, manifest: manifest)
    }

    /// The full listed record, read from the blob on demand.
    public func fullRecord(at index: Int) -> [String: Any]? {
        guard let offsets = try? Data(contentsOf: offsetsURL, options: .mappedIfSafe),
              offsets.count >= (index + 2) * 8 else { return nil }
        func offset(_ i: Int) -> UInt64 {
            var value: UInt64 = 0
            withUnsafeMutableBytes(of: &value) { destination in
                offsets.copyBytes(to: destination, from: (i * 8)..<((i + 1) * 8))
            }
            return UInt64(littleEndian: value)
        }
        let start = Int(offset(index)), end = Int(offset(index + 1))
        guard end > start,
              let handle = try? FileHandle(forReadingFrom: recordsURL) else { return nil }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: UInt64(start))
            guard let data = try handle.read(upToCount: end - start) else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    /// Bytes the stored list occupies. Worth surfacing: the archives are an
    /// order of magnitude larger than the download they were built from, and a
    /// user deciding whether to keep the app should not have to guess.
    public var storageBytes: Int {
        guard let entries = try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        return entries.reduce(0) { total, url in
            total + ((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
    }

    public func deleteAll() {
        try? fileManager.removeItem(at: directory)
    }

    private func excludeFromBackup() {
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
