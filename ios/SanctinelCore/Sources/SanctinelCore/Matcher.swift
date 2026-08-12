import Foundation

/*
 * Scoring — a 1:1 port of the scoring half of lib/matcher.js.
 *
 * Compliance note carried over from the JS: naive exact matching is not
 * adequate. This scores primary names AND every alias, classifies match strength
 * so weak single-token hits (the "Ali"/"Mohammed" problem) stay separable, and
 * screens non-name identifiers for exact hits.
 */

let weakSingleTokens: Set<String> = [
    "ALI", "MOHAMMED", "MOHAMMAD", "MUHAMMAD", "AHMED", "AHMAD", "ABDUL",
    "ABDULLAH", "HASSAN", "HUSSEIN", "HUSAIN", "IBRAHIM", "KHAN", "SAID",
    "SAYED", "AL", "BIN", "IBN", "BINT", "ABU", "UM", "EL", "THE", "AND", "OF",
]

// MARK: - Corpus term weighting (IDF)

/// Document frequency of every name token across the snapshot. A distinctive
/// surname carries far more identifying signal than COMPANY or MOHAMMED, and
/// weighting by IDF is what raises precision without a hand-kept stopword list.
public final class Corpus: @unchecked Sendable {
    public static let shared = Corpus()
    private var df: [String: Int] = [:]
    private var n: Int = 0

    public init() {}

    public func set(df: [String: Int], n: Int) {
        self.df = df
        self.n = n
    }

    public var count: Int { n }

    @inline(__always)
    public func idf(_ token: String) -> Double {
        if n == 0 { return 1 }
        let d = df[token] ?? 0
        return log(Double(n + 1) / Double(d + 1)) + 1   // >= 1, higher for rarer tokens
    }

    /// The same derivation lib/ingest.js runs after a snapshot is built.
    public static func documentFrequencies(_ records: [ScreeningRecord]) -> [String: Int] {
        var df: [String: Int] = [:]
        df.reserveCapacity(1 << 16)
        var seen = Set<String>()
        for record in records {
            seen.removeAll(keepingCapacity: true)
            for name in record.names {
                for token in name.tokens { seen.insert(token.text) }
            }
            for token in seen { df[token, default: 0] += 1 }
        }
        return df
    }
}

// MARK: - Token similarity

/// Jaro-Winkler ∪ Damerau-edit ∪ Dice ∪ trigram ∪ Metaphone ∪ transliteration ∪
/// initial. The phonetic and transliteration boosts are gated on a base
/// Jaro-Winkler so lossy keys cannot match unrelated tokens.
public func tokenSim(_ a: Token, _ b: Token) -> Double {
    if a.text == b.text { return 1 }
    // initial ↔ full ("D." ↔ "Dmitri")
    if (a.count == 1 && b.bytes.first == a.bytes[0]) || (b.count == 1 && a.bytes.first == b.bytes[0]) {
        return 0.88
    }
    let jw = jaroWinkler(a.bytes, b.bytes)
    // Clearly dissimilar tokens — the vast majority of pairs — skip the O(n²)
    // channels; only a cheap Dice can rescue a heavily reordered pair.
    if jw < 0.5 {
        let dc = dice(a, b)
        return dc > jw ? dc : jw
    }
    var s = jw

    // Each channel is skipped when its own exact upper bound cannot beat what we
    // already have, so the result is unchanged and only the cost goes away.
    let la = a.count, lb = b.count
    let maxL = Double(max(la, lb))
    if 1 - Double(abs(la - lb)) / maxL > s {
        let e = editSim(a.bytes, b.bytes)
        if e > s { s = e }
    }
    let nbA = la - 1, nbB = lb - 1
    if nbA > 0, nbB > 0, (2 * Double(min(nbA, nbB))) / Double(nbA + nbB) > s {
        let d = dice(a, b)
        if d > s { s = d }
    }
    let j3 = jaccard3(a, b)
    if j3 > s { s = j3 }

    if jw >= 0.62, la >= 4, lb >= 4 {
        let ma = a.metaphone
        if !ma.isEmpty, ma == b.metaphone { s = max(s, 0.92) }
    }
    if jw >= 0.6 {
        let fa = a.fold, fb = b.fold
        // Without the shared-gram gate the boost fires on pairs that merely share
        // a prefix (MAERSK↔MASHREK), manufacturing hits at exactly the 0.95
        // default that the candidate index cannot reproduce.
        if sharesFoldedGram(fa, fb) {
            s = max(s, min(0.95, jaroWinkler(fa, fb)))
        }
    }
    return s
}

// MARK: - Name scoring

private let tokenSetMax = 64

/// IDF-weighted, order-independent token-set score with greedy 1:1 assignment
/// (no token reused) plus a whole-string channel.
func tokenSetScore(_ qTokens: [Token], _ cTokens: [Token]) -> Double {
    if qTokens.isEmpty || cTokens.isEmpty { return 0 }
    let Q = min(qTokens.count, tokenSetMax)
    let C = min(cTokens.count, tokenSetMax)

    var sim = [Double](repeating: 0, count: Q * C)
    for i in 0..<Q {
        for j in 0..<C { sim[i * C + j] = tokenSim(qTokens[i], cTokens[j]) }
    }
    var qUsed = [Bool](repeating: false, count: Q)
    var cUsed = [Bool](repeating: false, count: C)

    // Weights are taken over every query token, not the clamped set — matching
    // the JS, where `w` is built from qTokens before Q is applied.
    let w = qTokens.map { Corpus.shared.idf($0.text) }
    var wsum = 0.0
    var matched = 0
    let need = min(Q, C)

    // Greedy 1:1 assignment, highest similarity first. Scanning row-major takes
    // the earliest (i, j) among equals, which is the tie-break the JS sort left.
    while matched < need {
        var best = -1.0
        var bi = -1, bj = -1
        for i in 0..<Q where !qUsed[i] {
            let row = i * C
            for j in 0..<C where !cUsed[j] {
                let v = sim[row + j]
                if v > best { best = v; bi = i; bj = j }
            }
        }
        if bi < 0 { break }
        qUsed[bi] = true
        cUsed[bj] = true
        wsum += w[bi] * best
        matched += 1
    }

    let wtot = w.reduce(0, +)
    let tokenAvg = wtot > 0 ? wsum / wtot : 0

    var qJoin = [UInt8](), cJoin = [UInt8]()
    for t in qTokens { qJoin.append(contentsOf: t.bytes) }
    for t in cTokens { cJoin.append(contentsOf: t.bytes) }
    let whole = max(jaroWinkler(qJoin, cJoin), max(diceRaw(qJoin, cJoin), jaccard3Raw(qJoin, cJoin)))
    return max(tokenAvg, 0.5 * tokenAvg + 0.5 * whole)
}

/// Query "CML" ↔ initials of "Caspian Maritime Logistics".
func acronymScore(_ qTokens: [Token], _ cTokens: [Token]) -> Double {
    guard qTokens.count == 1, cTokens.count >= 2 else { return 0 }
    let q = qTokens[0].bytes
    if q.count < 2 || q.count > 6 { return 0 }
    var initials = [UInt8]()
    initials.reserveCapacity(cTokens.count)
    for t in cTokens where !t.bytes.isEmpty { initials.append(t.bytes[0]) }
    if initials == q { return 0.97 }
    if initials.starts(with: q) || q.starts(with: initials) { return 0.9 }
    return 0
}

/// "Why did this match" for the winning candidate name — computed once for the
/// best hit, not in the hot loop. Audit-grade transparency for the analyst.
func explainMatch(_ query: String, _ candName: String) -> String {
    let q = tokens(query), c = tokens(candName)
    if q.isEmpty || c.isEmpty { return "" }
    var used = Set<Int>()
    var parts: [String] = []
    for qt in q {
        var bestScore = -1.0
        var bestIndex = -1
        for j in 0..<c.count where !used.contains(j) {
            let s = tokenSim(qt, c[j])
            if bestIndex < 0 || s > bestScore { bestScore = s; bestIndex = j }
        }
        if bestIndex < 0 || bestScore < 0.5 {
            parts.append("\(qt.text) (no match)")
            continue
        }
        used.insert(bestIndex)
        let ct = c[bestIndex]
        var how = "fuzzy"
        if qt.text == ct.text { how = "exact" }
        else if qt.count == 1 || ct.count == 1 { how = "initial" }
        else if !qt.metaphone.isEmpty, qt.metaphone == ct.metaphone { how = "phonetic" }
        else if qt.fold == ct.fold { how = "transliteration" }
        else if editSim(qt.bytes, ct.bytes) >= 0.8 { how = "typo" }
        parts.append(qt.text == ct.text ? "\(qt.text) exact" : "\(qt.text)↔\(ct.text) \(how)")
    }
    return parts.joined(separator: " · ")
}

func classifyName(_ score: Double, isExactNorm: Bool, onAlias: Bool) -> String {
    if isExactNorm { return onAlias ? "strong_alias" : "exact" }
    if score >= 0.92 { return onAlias ? "strong_alias" : "strong" }
    if score >= 0.86 { return onAlias ? "weak_alias" : "fuzzy" }
    return "weak"
}

// MARK: - Modifiers

struct ModifierOutcome {
    var score: Double
    var corroborated: Bool
    var conflict: Bool
}

/// Provided year-of-birth / country either confirm a fuzzy name hit or
/// contradict it — the standard "secondary identifiers as score modifiers"
/// screening control.
func applyModifiers(_ score: Double, _ record: ScreeningRecord, _ mods: Modifiers?) -> ModifierOutcome {
    guard let mods, !mods.isEmpty else {
        return ModifierOutcome(score: score, corroborated: false, conflict: false)
    }
    var out = score
    var corroborated = false
    var conflict = false

    if !mods.yob.isEmpty {
        let intervals = record.birthIntervals
        if !intervals.isEmpty {
            // Any-of: several stated birth dates are alternatives the publisher
            // could not decide between, not a set the subject must satisfy all of.
            if intervals.contains(where: { $0.coversYear(mods.yob) }) {
                out = min(1, out + 0.05); corroborated = true
            } else {
                out -= 0.06; conflict = true
            }
        }
    }

    if !mods.country.isEmpty {
        /*
         * Code comparison first. "North Korea", "Korea, North", "DPRK" and
         * "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" are one jurisdiction written
         * four ways across four authorities, and the string comparison below
         * scored the first against the last as a CONFLICT — a corroborating
         * identifier taken as a contradicting one.
         *
         * Any-of, not all-of: a party with addresses in three countries is
         * corroborated by naming one of them, which is what the string path did
         * too (its haystack pooled every address together).
         */
        var qCodes: [String] = []
        for c in Countries.codes(mods.country) {
            for x in Countries.expand(c) where !qCodes.contains(x) { qCodes.append(x) }
        }
        let rCodes = record.countryCodes
        if !qCodes.isEmpty, !rCodes.isEmpty {
            if qCodes.contains(where: { rCodes.contains($0) }) {
                out = min(1, out + 0.04); corroborated = true
            } else {
                out -= 0.04; conflict = true
            }
            return ModifierOutcome(score: max(0, out), corroborated: corroborated, conflict: conflict)
        }
        // Neither side resolved to a known jurisdiction — a region, a disputed
        // territory, a source's placeholder. Fall back to the string comparison
        // rather than silently declining to check.
        var cc = [UInt8]()
        for byte in mods.country.uppercased().utf8 {
            cc.append((byte >= 65 && byte <= 90) ? byte : 32)
        }
        let ccTokens = String(decoding: cc, as: UTF8.self)
            .split(separator: " ").map(String.init)
        let hayTokens = record.countryTokens
        // Token-level, not substring — "US" must not match inside "RUSSIA".
        // Prefix tolerance (>= 4 chars) still links Russia ↔ Russian Federation.
        func tokenHit(_ q: String) -> Bool {
            hayTokens.contains { t in
                t == q || (q.count >= 4 && t.hasPrefix(q)) || (t.count >= 4 && q.hasPrefix(t))
            }
        }
        if !hayTokens.isEmpty, !ccTokens.isEmpty {
            if ccTokens.allSatisfy(tokenHit) { out = min(1, out + 0.04); corroborated = true }
            else { out -= 0.04; conflict = true }
        }
    }

    return ModifierOutcome(score: max(0, out), corroborated: corroborated, conflict: conflict)
}

// MARK: - Entry points

/// Exact-match screen over non-name identifiers — passport, national/tax ID,
/// IMO/MMSI, call sign, digital-currency address.
public func matchIdentifier(_ query: String, _ record: ScreeningRecord) -> MatchResult? {
    let qk = idKey(query)
    if qk.count < 4 { return nil }        // too short to be a meaningful identifier
    for id in record.identifiers where id.key == qk {
        return MatchResult(score: 1, matchType: "identifier", matchedName: id.value,
                           matchedField: id.type, explain: "exact \(id.type) identifier match",
                           corroborated: false, conflict: false)
    }
    return nil
}

/// Best name score across the primary name and every alias.
public func matchName(_ query: String, _ record: ScreeningRecord,
                      floor: Double, mods: Modifiers?) -> MatchResult? {
    let qTokens = tokens(query)
    if qTokens.isEmpty { return nil }
    let qNorm = qTokens.map(\.text).joined(separator: " ")

    var bestScore = -1.0
    var bestExact = false
    var bestName = ""
    var bestOnAlias = false
    var bestAliasType = ""
    var found = false

    for cand in record.names {
        let cTokens = cand.tokens
        if cTokens.isEmpty { continue }
        let cNorm = cTokens.map(\.text).joined(separator: " ")
        let isExact = cNorm == qNorm
        var score = isExact ? 1 : max(tokenSetScore(qTokens, cTokens), acronymScore(qTokens, cTokens))

        if qTokens.count == 1, weakSingleTokens.contains(qTokens[0].text), !isExact {
            score = min(score, 0.75)
        }
        // Single-token query against a multi-token name: an EXACT token hit (the
        // classic surname search) lands at 0.96 — above the 0.95 default, below a
        // full-name match for ranking. Fuzzy single-token hits keep the 0.9
        // damping so partial noise stays below the line.
        if qTokens.count == 1, cTokens.count > 1, !isExact {
            score = score >= 0.999 ? 0.96 : score * 0.9
        }
        if cand.lowQuality { score *= 0.97 }   // OFAC low-quality alias: mild discount

        if !found || score > bestScore {
            found = true
            bestScore = score
            bestExact = isExact
            bestName = cand.name
            bestOnAlias = !cand.primary
            bestAliasType = cand.type
        }
    }
    if !found { return nil }

    let mod = applyModifiers(bestScore, record, mods)
    if mod.score < floor { return nil }

    return MatchResult(
        score: jsToFixed4(mod.score),
        matchType: classifyName(mod.score, isExactNorm: bestExact, onAlias: bestOnAlias),
        matchedName: bestName,
        matchedField: bestOnAlias ? "alias (\(bestAliasType))" : "primary name",
        explain: bestExact ? "exact name match" : explainMatch(query, bestName),
        corroborated: mod.corroborated,
        conflict: mod.conflict
    )
}

/// Best of the identifier and name channels.
public func screenEntity(_ query: String, _ record: ScreeningRecord,
                         floor: Double, mods: Modifiers?) -> MatchResult? {
    let idm = matchIdentifier(query, record)
    let nm = matchName(query, record, floor: floor, mods: mods)
    if let idm, nm == nil || idm.score >= nm!.score { return idm }
    return nm
}

/// `Number(x.toFixed(4))` — the rounding the JS applies before returning a score.
///
/// Scaling by 10,000 and rounding is NOT equivalent: the multiply introduces its
/// own rounding, so a value just under 0.62325 lands on 0.6233 where JavaScript
/// gives 0.6232. toFixed rounds the exact binary value, which is what printf's
/// correctly-rounded conversion does too.
@inline(__always)
func jsToFixed4(_ x: Double) -> Double {
    Double(String(format: "%.4f", x)) ?? x
}
