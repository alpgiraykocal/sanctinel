import XCTest
@testable import SanctinelCore

/*
 * End-to-end tests over the real committed snapshot.
 *
 * The fixture tests prove the scorer agrees with the JS on individual records;
 * these prove the whole pipeline agrees — prefilter included. An index that
 * quietly drops a candidate produces a false negative, which no per-record test
 * can see, so the ranked output is compared query by query and the fast path is
 * checked against a full scan.
 *
 * Skipped when cache/snapshot.json.gz is absent so a checkout without the data
 * still runs the rest of the suite.
 */
final class SnapshotTests: XCTestCase {

    private static var engine: ScreeningEngine?
    private static var loadFailure: Error?

    override class func setUp() {
        super.setUp()
        Matching.loadBundled()
        guard let url = Fixtures.snapshotURL() else { return }
        do {
            let loaded = try SnapshotLoader.load(gzipped: try Data(contentsOf: url))
            engine = ScreeningEngine.make(records: loaded.records, meta: loaded.meta)
        } catch {
            loadFailure = error
        }
    }

    private func requireEngine() throws -> ScreeningEngine {
        if let failure = Self.loadFailure { throw failure }
        guard let engine = Self.engine else {
            throw XCTSkip("cache/snapshot.json.gz not present")
        }
        return engine
    }

    func testSnapshotLoads() throws {
        let engine = try requireEngine()
        XCTAssertGreaterThan(engine.records.count, 30_000)
        XCTAssertFalse(engine.meta.authorities.isEmpty)
        XCTAssertTrue(engine.meta.authorities.contains("OFAC"))
        XCTAssertFalse(engine.meta.lists.isEmpty)
        XCTAssertEqual(engine.meta.count, engine.records.count)
    }

    /// The ranked list the phone produces must equal the one server.js produces.
    func testEndToEndSearchMatchesJavaScript() throws {
        let engine = try requireEngine()
        let fixture = try Fixtures.search()

        var problems: [String] = []
        for c in fixture.cases {
            let mods = (c.yob.isEmpty && c.country.isEmpty) ? nil : Modifiers(yob: c.yob, country: c.country)
            let outcome = engine.search(SearchQueryOptions(
                query: c.query, threshold: c.threshold, authority: c.authority,
                list: c.list, program: c.program, mods: mods))

            let label = "\(c.query.debugDescription)@\(c.threshold)"
            if outcome.count != c.count {
                problems.append("\(label): count \(outcome.count) != \(c.count)")
            }
            if outcome.truncated != c.truncated {
                problems.append("\(label): truncated \(outcome.truncated) != \(c.truncated)")
            }
            let gotIds = outcome.hits.map(\.id)
            let wantIds = c.results.map(\.id)
            if gotIds != wantIds {
                let firstDiff = zip(gotIds, wantIds).enumerated().first { $0.element.0 != $0.element.1 }?.offset
                problems.append("\(label): ranking diverges at \(firstDiff.map(String.init) ?? "length")"
                                + " (got \(gotIds.prefix(5)), want \(wantIds.prefix(5)))")
            }
            for (hit, expected) in zip(outcome.hits, c.results) where abs(hit.match.score - expected.score) > 1e-9 {
                problems.append("\(label): \(hit.id) score \(hit.match.score) != \(expected.score)")
            }
        }

        if !problems.isEmpty {
            XCTFail("""
                \(problems.count) end-to-end divergences from the JS pipeline.
                First 15:
                \(problems.prefix(15).joined(separator: "\n"))
                """)
        }
    }

    /// The recall invariant: at the default threshold the candidate index must
    /// surface everything a full scan would. Anything it misses is a false
    /// negative — the worst failure mode in screening.
    func testFastPathMatchesFullScan() throws {
        let engine = try requireEngine()
        let queries = [
            "ivanov", "rosneft", "sberbank", "mohammed", "kim jong un", "CCC", "CML",
            "ghsair", "soe win", "yusuf", "huawei", "gazprom neft", "wagner",
            "petroleos de venezuela", "bank melli", "сompany", "751234567",
        ]
        var problems: [String] = []
        for q in queries {
            let options = SearchQueryOptions(query: q, threshold: ScreeningEngine.defaultThreshold)
            let fast = Set(engine.search(options).hits.map(\.id))
            let full = Set(engine.fullScan(options).prefix(ScreeningEngine.maxResults).map(\.id))
            let missed = full.subtracting(fast)
            if !missed.isEmpty {
                problems.append("\(q): prefilter missed \(missed.count) hits — \(missed.prefix(5))")
            }
        }
        XCTAssertTrue(problems.isEmpty, problems.joined(separator: "\n"))
    }

    func testSearchLatencyIsInteractive() throws {
        let engine = try requireEngine()
        // Warm the token caches the same way a first keystroke would.
        _ = engine.search(SearchQueryOptions(query: "ivanov"))
        let queries = ["rosneft", "mohammed ali", "sberbank", "kim jong un", "gazprom"]
        let started = Date()
        for q in queries { _ = engine.search(SearchQueryOptions(query: q)) }
        let perQuery = Date().timeIntervalSince(started) / Double(queries.count)
        // Generous: this runs in a debug build on CI hardware. It exists to catch
        // an accidental full scan, which is an order of magnitude slower, not to
        // police milliseconds.
        XCTAssertLessThan(perQuery, 1.5, "median query took \(perQuery)s")
    }
}
