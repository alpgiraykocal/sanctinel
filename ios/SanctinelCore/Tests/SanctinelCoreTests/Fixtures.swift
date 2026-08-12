import Foundation
@testable import SanctinelCore
import XCTest

/// Loaders for the JS-generated fixtures in Fixtures/.
enum Fixtures {

    struct Primitives: Decodable {
        struct StringCase: Decodable { let input: String; let output: String }
        struct TokensCase: Decodable { let input: String; let output: [String] }
        struct Pair: Decodable {
            let a: String, b: String
            let jaroWinkler: Double
            let editSim: Double
            let dice: Double
            let jaccard3: Double
            let tokenSim: Double
            let sharesFoldedGram: Bool
        }
        struct DateOut: Decodable {
            let from: String
            let to: String
            let precision: String
            let approximate: Bool
        }
        struct DateCase: Decodable { let input: String; let output: DateOut? }
        struct Vocabulary: Decodable {
            let attributeKind: [StringCase]
            let identifierKind: [StringCase]
            let dates: [DateCase]
        }
        let vocabulary: Vocabulary
        let normalize: [StringCase]
        let tokens: [TokensCase]
        let idKey: [StringCase]
        let metaphone: [StringCase]
        let foldTranslit: [StringCase]
        let pairs: [Pair]
    }

    struct Screening {
        struct Expected: Decodable {
            let score: Double
            let matchType: String
            let matchedName: String
            let matchedField: String
            let explain: String
            let corroborated: Bool
            let conflict: Bool
        }
        struct Case: Decodable {
            let query: String
            let yob: String
            let country: String
            let record: Int
            let result: Expected?
        }
        let corpusCount: Int
        let documentFrequencies: [String: Int]
        /// Raw entity dictionaries, so the Swift side derives its own view of a
        /// record through RecordBuilder rather than reading pre-baked fields.
        let records: [[String: Any]]
        let cases: [Case]
    }

    struct Search: Decodable {
        struct Result: Decodable { let id: String; let score: Double; let matchType: String }
        struct Case: Decodable {
            let query: String
            let threshold: Double
            let authority: String
            let list: String
            let program: String
            let yob: String
            let country: String
            let count: Int
            let truncated: Bool
            let results: [Result]
        }
        let cases: [Case]
    }

    static func search() throws -> Search {
        try JSONDecoder().decode(Search.self, from: Data(contentsOf: url("search.json")))
    }

    struct Graph: Decodable {
        struct Node: Decodable {
            let id: String
            let hop: Int
            let inSnapshot: Bool
            let degree: Int
            let weightedDegree: Int
        }
        struct Edge: Decodable {
            let source: String
            let target: String
            let type: String
            let ownership: Bool
            let role: String?
            let hier: String
        }
        struct Case: Decodable {
            let center: String
            let depth: Int
            let nodes: [Node]
            let edges: [Edge]
            let nodeCount: Int
            let edgeCount: Int
            let ownershipEdges: Int
        }
        let cases: [Case]
    }

    struct Stats: Decodable {
        struct Bucket: Decodable { let name: String; let count: Int }
        struct Year: Decodable { let label: String; let count: Int }
        struct Recent: Decodable {
            let id: String
            let date: String
            let authority: String
            let country: String
            let aliases: Int
            let measures: [String]
        }
        let now: String
        let totals: SnapshotStats.Totals
        let byAuthority: [Bucket]
        let byList: [Bucket]
        let byType: [Bucket]
        let byMeasure: [Bucket]
        let byProgram: [Bucket]
        let byCountry: [Bucket]
        let years: [Year]
        let recent: [Recent]
    }

    static func graph() throws -> Graph {
        try JSONDecoder().decode(Graph.self, from: Data(contentsOf: url("graph.json")))
    }

    static func stats() throws -> Stats {
        try JSONDecoder().decode(Stats.self, from: Data(contentsOf: url("stats.json")))
    }

    static func url(_ name: String) throws -> URL {
        guard let base = Bundle.module.resourceURL else {
            throw XCTSkip("test bundle has no resources")
        }
        let candidate = base.appendingPathComponent("Fixtures/\(name)")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        let flat = base.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: flat.path) { return flat }
        throw XCTSkip("fixture \(name) not found — run: node scripts/gen-conformance-fixtures.js")
    }

    static func primitives() throws -> Primitives {
        try JSONDecoder().decode(Primitives.self, from: Data(contentsOf: url("primitives.json")))
    }

    static func screening() throws -> Screening {
        let data = try Data(contentsOf: url("screening.json"))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let records = root["records"] as? [[String: Any]] else {
            throw XCTSkip("screening.json is malformed")
        }
        let caseData = try JSONSerialization.data(withJSONObject: root["cases"] ?? [])
        let cases = try JSONDecoder().decode([Screening.Case].self, from: caseData)
        return Screening(
            corpusCount: root["corpusCount"] as? Int ?? 0,
            documentFrequencies: root["documentFrequencies"] as? [String: Int] ?? [:],
            records: records,
            cases: cases
        )
    }

    /// The committed snapshot, for the tests that need the whole list. Returns
    /// nil when it is absent so a checkout without it still runs the rest.
    static func snapshotURL() -> URL? {
        // Tests/SanctinelCoreTests/Fixtures.swift -> repo root
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }
        let snapshot = dir.appendingPathComponent("cache/snapshot.json.gz")
        return FileManager.default.fileExists(atPath: snapshot.path) ? snapshot : nil
    }
}
