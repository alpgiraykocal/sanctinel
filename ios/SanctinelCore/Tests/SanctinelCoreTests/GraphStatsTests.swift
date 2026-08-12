import XCTest
@testable import SanctinelCore

/// The ownership graph and the snapshot statistics, checked against the same JS
/// modules the web app serves from. The graph is a display aid rather than a
/// determination, but a port that silently dropped an ownership edge would
/// understate 50 Percent Rule exposure, so its node and edge sets are frozen too.
final class GraphStatsTests: XCTestCase {

    private static var loaded: SnapshotLoader.Loaded?
    private static var relationships: RelationshipGraph?

    override class func setUp() {
        super.setUp()
        Matching.loadBundled()
        guard let url = Fixtures.snapshotURL(),
              let data = try? Data(contentsOf: url),
              let loaded = try? SnapshotLoader.load(gzipped: data) else { return }
        self.loaded = loaded
        relationships = RelationshipGraph(records: loaded.records)
    }

    private func requireLoaded() throws -> (SnapshotLoader.Loaded, RelationshipGraph) {
        guard let loaded = Self.loaded, let graph = Self.relationships else {
            throw XCTSkip("cache/snapshot.json.gz not present")
        }
        return (loaded, graph)
    }

    func testEgoNetworksMatchJavaScript() throws {
        let (_, graph) = try requireLoaded()
        let fixture = try Fixtures.graph()

        for c in fixture.cases {
            guard let result = graph.egoNetwork(centerId: c.center, depth: c.depth) else {
                XCTFail("no network for \(c.center)")
                continue
            }
            XCTAssertEqual(result.nodeCount, c.nodeCount, "node count for \(c.center)")
            XCTAssertEqual(result.edgeCount, c.edgeCount, "edge count for \(c.center)")
            XCTAssertEqual(result.ownershipEdges, c.ownershipEdges, "ownership edges for \(c.center)")

            // Node identity and hop distance must agree; the ordering within a
            // hop is a display detail the app re-sorts anyway.
            let gotNodes = Dictionary(uniqueKeysWithValues: result.nodes.map { ($0.id, $0) })
            for expected in c.nodes {
                guard let got = gotNodes[expected.id] else {
                    XCTFail("\(c.center): missing node \(expected.id)")
                    continue
                }
                XCTAssertEqual(got.hop, expected.hop, "\(c.center)/\(expected.id) hop")
                XCTAssertEqual(got.inSnapshot, expected.inSnapshot, "\(c.center)/\(expected.id) inSnapshot")
                XCTAssertEqual(got.degree, expected.degree, "\(c.center)/\(expected.id) degree")
                XCTAssertEqual(got.weightedDegree, expected.weightedDegree, "\(c.center)/\(expected.id) weighted")
            }
            XCTAssertEqual(Set(result.nodes.map(\.id)), Set(c.nodes.map(\.id)), "node set for \(c.center)")

            let gotEdges = Set(result.edges.map { "\($0.source)->\($0.target):\($0.type)|\($0.ownership)|\($0.role ?? "-")|\($0.hier)" })
            let wantEdges = Set(c.edges.map { "\($0.source)->\($0.target):\($0.type)|\($0.ownership)|\($0.role ?? "-")|\($0.hier)" })
            XCTAssertEqual(gotEdges, wantEdges, "edge set for \(c.center)")
        }
    }

    func testStatsMatchJavaScript() throws {
        let (loaded, _) = try requireLoaded()
        let fixture = try Fixtures.stats()
        // JS toISOString() carries milliseconds, which the default parser rejects.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let now = fractional.date(from: fixture.now) ?? ISO8601DateFormatter().date(from: fixture.now) else {
            throw XCTSkip("stats fixture has no pinned instant")
        }
        let stats = StatsBuilder.compute(entities: loaded.entities, now: now)

        XCTAssertEqual(stats.totals.entities, fixture.totals.entities)
        XCTAssertEqual(stats.totals.dated, fixture.totals.dated)
        XCTAssertEqual(stats.totals.undated, fixture.totals.undated)
        XCTAssertEqual(stats.totals.authorities, fixture.totals.authorities)
        XCTAssertEqual(stats.totals.lists, fixture.totals.lists)
        XCTAssertEqual(stats.totals.programs, fixture.totals.programs)
        XCTAssertEqual(stats.totals.countries, fixture.totals.countries)
        XCTAssertEqual(stats.totals.withAliases, fixture.totals.withAliases)
        XCTAssertEqual(stats.totals.withIdentifiers, fixture.totals.withIdentifiers)
        XCTAssertEqual(stats.totals.withRelationships, fixture.totals.withRelationships)
        XCTAssertEqual(stats.totals.relationshipEdges, fixture.totals.relationshipEdges)
        XCTAssertEqual(stats.totals.ownershipEdges, fixture.totals.ownershipEdges)
        XCTAssertEqual(stats.totals.added30, fixture.totals.added30)
        XCTAssertEqual(stats.totals.added90, fixture.totals.added90)
        XCTAssertEqual(stats.totals.added365, fixture.totals.added365)
        XCTAssertEqual(stats.totals.newest, fixture.totals.newest)
        XCTAssertEqual(stats.totals.oldest, fixture.totals.oldest)

        assertBuckets(stats.byAuthority, fixture.byAuthority, "byAuthority")
        assertBuckets(stats.byList, fixture.byList, "byList")
        assertBuckets(stats.byType, fixture.byType, "byType")
        assertBuckets(stats.byMeasure, fixture.byMeasure, "byMeasure")
        assertBuckets(stats.byProgram, fixture.byProgram, "byProgram")
        assertBuckets(stats.byCountry, fixture.byCountry, "byCountry")

        XCTAssertEqual(stats.years.map(\.label), fixture.years.map(\.label))
        XCTAssertEqual(stats.years.map(\.count), fixture.years.map(\.count))

        // The recent list drives the Insights feed; membership is what matters,
        // and ties within a date are a display ordering detail.
        XCTAssertEqual(Set(stats.recent.map(\.id)), Set(fixture.recent.map(\.id)), "recent set")
        let byId = Dictionary(uniqueKeysWithValues: stats.recent.map { ($0.id, $0) })
        for expected in fixture.recent {
            guard let got = byId[expected.id] else { continue }
            XCTAssertEqual(got.date, expected.date, "recent \(expected.id) date")
            XCTAssertEqual(got.authority, expected.authority, "recent \(expected.id) authority")
            XCTAssertEqual(got.country, expected.country, "recent \(expected.id) country")
            XCTAssertEqual(got.aliases, expected.aliases, "recent \(expected.id) aliases")
            XCTAssertEqual(got.measures, expected.measures, "recent \(expected.id) measures")
        }
    }

    func testCountryNormalization() {
        XCTAssertEqual(Countries.canonical("RUSSIAN FEDERATION"), "Russia")
        XCTAssertEqual(Countries.canonical("KP"), "North Korea")
        XCTAssertEqual(Countries.canonical("Korea, North"), "North Korea")
        XCTAssertEqual(Countries.canonical("CONGO, DEMOCRATIC REPUBLIC OF (was Zaire)"), "DR Congo")
        XCTAssertEqual(Countries.canonical("n/a"), "")
        XCTAssertEqual(Countries.canonical("12345"), "")
        XCTAssertEqual(Countries.canonical("UNITED ARAB EMIRATES"), "United Arab Emirates")
        XCTAssertEqual(Countries.parse("(1) Russia. (2) Ukraine"), ["Russia", "Ukraine"])
        XCTAssertEqual(Countries.parse("Iran; Iraq"), ["Iran", "Iraq"])
    }

    func testDateNormalization() {
        XCTAssertEqual(StatsBuilder.normalizeDate("2024-01-11"), "2024-01-11")
        XCTAssertEqual(StatsBuilder.normalizeDate("2024-01-11T10:00:00Z"), "2024-01-11")
        XCTAssertEqual(StatsBuilder.normalizeDate("5/3/2021"), "2021-03-05")
        XCTAssertEqual(StatsBuilder.normalizeDate("31/02/2020"), "")
        XCTAssertEqual(StatsBuilder.normalizeDate(""), "")
        XCTAssertEqual(StatsBuilder.normalizeDate("not a date"), "")
    }

    private func assertBuckets(_ got: [SnapshotStats.Bucket], _ want: [Fixtures.Stats.Bucket],
                               _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(got.map(\.name), want.map(\.name), "\(label) names", file: file, line: line)
        XCTAssertEqual(got.map(\.count), want.map(\.count), "\(label) counts", file: file, line: line)
    }
}
