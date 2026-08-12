import XCTest
@testable import SanctinelCore

/// Import, persist, reload — and prove the reloaded engine screens identically
/// to the freshly built one. A serializer that quietly drops a posting or a
/// low-quality flag would change scores only after a relaunch, which is the
/// hardest kind of divergence to notice.
final class StoreTests: XCTestCase {

    override class func setUp() {
        super.setUp()
        Matching.loadBundled()
    }

    func testRoundTripPreservesScreening() throws {
        guard let url = Fixtures.snapshotURL() else { throw XCTSkip("cache/snapshot.json.gz not present") }
        let gz = try Data(contentsOf: url)

        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("sanctinel-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = SnapshotStore(directory: directory)
        let manifest = try store.importSnapshot(gzipped: gz, etag: "test-etag")
        XCTAssertGreaterThan(manifest.recordCount, 30_000)
        XCTAssertEqual(manifest.etag, "test-etag")

        // Reference: build straight from the snapshot, as the import did.
        let direct = try SnapshotLoader.load(gzipped: gz, pool: TokenPool())
        let reference = ScreeningEngine.make(records: direct.records, meta: direct.meta)

        let loaded = try store.load(pool: TokenPool())
        XCTAssertEqual(loaded.engine.records.count, reference.records.count)
        XCTAssertEqual(loaded.engine.meta.authorities, reference.meta.authorities)
        XCTAssertEqual(loaded.engine.meta.lists, reference.meta.lists)
        XCTAssertEqual(loaded.engine.meta.programs.count, reference.meta.programs.count)
        XCTAssertEqual(loaded.stats.totals.entities, reference.records.count)
        XCTAssertFalse(loaded.stats.recent.isEmpty)

        for query in ["ivanov", "rosneft", "CCC", "mohammed ali", "751234567", "ghsair"] {
            let options = SearchQueryOptions(query: query)
            let want = reference.search(options)
            let got = loaded.engine.search(options)
            XCTAssertEqual(got.count, want.count, "hit count for \(query)")
            XCTAssertEqual(got.hits.map(\.id), want.hits.map(\.id), "ranking for \(query)")
            for (a, b) in zip(got.hits, want.hits) {
                XCTAssertEqual(a.match.score, b.match.score, accuracy: 1e-12, "score for \(query)/\(a.id)")
                XCTAssertEqual(a.match.matchedName, b.match.matchedName, "matchedName for \(query)/\(a.id)")
                XCTAssertEqual(a.match.explain, b.match.explain, "explain for \(query)/\(a.id)")
            }
        }

        // The ownership graph rebuilds from the stored relationships.
        let centre = loaded.engine.records.first { !$0.relationships.isEmpty }
        let centreId = try XCTUnwrap(centre?.id)
        let fromStore = try XCTUnwrap(loaded.relationships.egoNetwork(centerId: centreId))
        let fromReference = try XCTUnwrap(RelationshipGraph(records: reference.records)
            .egoNetwork(centerId: centreId))
        XCTAssertEqual(Set(fromStore.nodes.map(\.id)), Set(fromReference.nodes.map(\.id)))
        XCTAssertEqual(fromStore.edgeCount, fromReference.edgeCount)

        // Full records come back off the blob with their detail intact.
        let hit = try XCTUnwrap(loaded.engine.search(SearchQueryOptions(query: "ivanov")).hits.first)
        let full = try XCTUnwrap(store.fullRecord(at: hit.recordIndex))
        XCTAssertEqual(RecordBuilder.string(full["id"]), hit.id)
        XCTAssertNotNil(full["names"])
    }

    func testGzipInflateMatchesFoundation() throws {
        guard let url = Fixtures.snapshotURL() else { throw XCTSkip("cache/snapshot.json.gz not present") }
        let inflated = try Gzip.inflate(try Data(contentsOf: url))
        let root = try JSONSerialization.jsonObject(with: inflated) as? [String: Any]
        XCTAssertNotNil(root?["entities"])
        XCTAssertGreaterThan(inflated.count, 10_000_000)
    }

    func testPoisonPillIsRefused() throws {
        let tiny = try JSONSerialization.data(withJSONObject: [
            "meta": ["source": "test"],
            "entities": [["id": "1", "name": "TEST"]],
        ])
        XCTAssertThrowsError(try SnapshotLoader.load(json: tiny)) { error in
            guard case SnapshotLoader.Failure.poisonPill = error else {
                return XCTFail("expected a poison-pill refusal, got \(error)")
            }
        }
    }
}
