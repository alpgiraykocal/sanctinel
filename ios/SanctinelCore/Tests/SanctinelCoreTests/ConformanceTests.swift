import XCTest
@testable import SanctinelCore

/*
 * The Swift engine must return exactly what lib/matcher.js returns.
 *
 * The phone scores on-device and the web app scores on the server. If those two
 * drift, the phone clears a party the web flags — silently, at the fourth
 * decimal, in the direction that matters least visibly and most legally. So the
 * JavaScript implementation is the reference and these fixtures freeze its
 * output; regenerate with `node scripts/gen-conformance-fixtures.js` whenever
 * the JS scorer or data/matching.json changes.
 */
final class ConformanceTests: XCTestCase {

    override class func setUp() {
        super.setUp()
        Matching.loadBundled()
    }

    // MARK: - Primitives

    /*
     * Vocabulary and date parity over the whole published inventory — every
     * distinct attribute label, identifier type and birth-date value in the
     * snapshot.
     *
     * These two derivations decide which attribute IS a birth date and which
     * year corroborates a hit, so a port that disagrees moves scores on the
     * phone and nowhere else. Asserting them directly means that shows up here
     * rather than as a mysterious score delta.
     */
    func testVocabularyMatchesJavaScript() throws {
        let fixture = try Fixtures.primitives()
        var mismatches: [String] = []

        for c in fixture.vocabulary.attributeKind {
            let got = Vocab.attributeKind(c.input)
            if got != c.output { mismatches.append("attributeKind(\(c.input.debugDescription)) = \(got) != \(c.output)") }
        }
        for c in fixture.vocabulary.identifierKind {
            let got = Vocab.identifierKind(c.input)
            if got != c.output { mismatches.append("identifierKind(\(c.input.debugDescription)) = \(got) != \(c.output)") }
        }
        for c in fixture.vocabulary.dates {
            let got = Dates.parseValue(c.input)
            guard let want = c.output else {
                if got != nil { mismatches.append("parseValue(\(c.input.debugDescription)) = \(got!) != nil") }
                continue
            }
            guard let got else {
                mismatches.append("parseValue(\(c.input.debugDescription)) = nil != \(want.from)…\(want.to)")
                continue
            }
            if got.from != want.from || got.to != want.to
                || got.precision != want.precision || got.approximate != want.approximate {
                mismatches.append("parseValue(\(c.input.debugDescription)) = \(got.from)…\(got.to)/\(got.precision)/\(got.approximate)"
                    + " != \(want.from)…\(want.to)/\(want.precision)/\(want.approximate)")
            }
        }

        if !mismatches.isEmpty {
            XCTFail("""
                \(mismatches.count) vocabulary/date divergences from the JS.
                First 20:
                \(mismatches.prefix(20).joined(separator: "\n"))
                """)
        }
    }

    func testPrimitives() throws {
        let fixture = try Fixtures.primitives()

        for c in fixture.normalize {
            XCTAssertEqual(normalize(c.input), c.output, "normalize(\(c.input.debugDescription))")
        }
        for c in fixture.tokens {
            XCTAssertEqual(tokenStrings(c.input), c.output, "tokens(\(c.input.debugDescription))")
        }
        for c in fixture.idKey {
            XCTAssertEqual(idKey(c.input), c.output, "idKey(\(c.input.debugDescription))")
        }
        for c in fixture.metaphone {
            let got = String(decoding: metaphoneRaw(Array(c.input.utf8)), as: UTF8.self)
            XCTAssertEqual(got, c.output, "metaphone(\(c.input))")
        }
        for c in fixture.foldTranslit {
            let got = String(decoding: foldTranslitRaw(Array(c.input.utf8)), as: UTF8.self)
            XCTAssertEqual(got, c.output, "foldTranslit(\(c.input))")
        }

        let pool = TokenPool()
        for p in fixture.pairs {
            let a = pool.token(p.a), b = pool.token(p.b)
            assertClose(jaroWinkler(a.bytes, b.bytes), p.jaroWinkler, "jaroWinkler(\(p.a),\(p.b))")
            assertClose(editSim(a.bytes, b.bytes), p.editSim, "editSim(\(p.a),\(p.b))")
            assertClose(dice(a, b), p.dice, "dice(\(p.a),\(p.b))")
            assertClose(jaccard3(a, b), p.jaccard3, "jaccard3(\(p.a),\(p.b))")
            assertClose(tokenSim(a, b), p.tokenSim, "tokenSim(\(p.a),\(p.b))")
            XCTAssertEqual(sharesFoldedGram(a.fold, b.fold), p.sharesFoldedGram,
                           "sharesFoldedGram(\(p.a),\(p.b))")
        }
    }

    // MARK: - Screening

    func testScreeningMatchesJavaScript() throws {
        let fixture = try Fixtures.screening()
        let pool = TokenPool()
        let records = fixture.records.map { RecordBuilder.make(from: $0, pool: pool) }
        Corpus.shared.set(df: fixture.documentFrequencies, n: fixture.corpusCount)
        defer { Corpus.shared.set(df: [:], n: 0) }

        var mismatches: [String] = []
        for c in fixture.cases {
            let record = records[c.record]
            let mods = (c.yob.isEmpty && c.country.isEmpty) ? nil : Modifiers(yob: c.yob, country: c.country)
            let got = screenEntity(c.query, record, floor: 0, mods: mods)

            guard let expected = c.result else {
                if got != nil { mismatches.append("\(c.query) / \(record.id): expected no match, got \(got!.score)") }
                continue
            }
            guard let got else {
                mismatches.append("\(c.query) / \(record.id): expected \(expected.score), got no match")
                continue
            }
            if abs(got.score - expected.score) > 1e-9 {
                mismatches.append("\(c.query) / \(record.id): score \(got.score) != \(expected.score)")
            }
            if got.matchType != expected.matchType {
                mismatches.append("\(c.query) / \(record.id): matchType \(got.matchType) != \(expected.matchType)")
            }
            if got.matchedName != expected.matchedName {
                mismatches.append("\(c.query) / \(record.id): matchedName \(got.matchedName) != \(expected.matchedName)")
            }
            if got.matchedField != expected.matchedField {
                mismatches.append("\(c.query) / \(record.id): matchedField \(got.matchedField) != \(expected.matchedField)")
            }
            if got.explain != expected.explain {
                mismatches.append("\(c.query) / \(record.id): explain \(got.explain.debugDescription) != \(expected.explain.debugDescription)")
            }
            if got.corroborated != expected.corroborated || got.conflict != expected.conflict {
                mismatches.append("\(c.query) / \(record.id): modifiers \(got.corroborated)/\(got.conflict) != \(expected.corroborated)/\(expected.conflict)")
            }
        }

        if !mismatches.isEmpty {
            XCTFail("""
                \(mismatches.count) of \(fixture.cases.count) cases diverge from the JS scorer.
                First 20:
                \(mismatches.prefix(20).joined(separator: "\n"))
                """)
        }
    }

    private func assertClose(_ got: Double, _ expected: Double, _ label: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        // A real divergence shows up far above this; the tolerance only absorbs
        // the last-bit difference between two orderings of the same arithmetic.
        XCTAssertEqual(got, expected, accuracy: 1e-12, label, file: file, line: line)
    }
}
