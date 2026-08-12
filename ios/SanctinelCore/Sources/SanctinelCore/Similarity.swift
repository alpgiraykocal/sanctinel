import Foundation

/*
 * Similarity primitives — a 1:1 port of the corresponding section of
 * lib/matcher.js. See Text.swift for why the port is literal rather than tidy.
 *
 * One JavaScript quirk is load-bearing here and is reproduced deliberately:
 * `'AEIOU'.includes('')` and `'IEY'.includes('')` are both TRUE, so where the JS
 * reads a character past the end of the string (`str[i + 1] || ''`) those tests
 * succeed. That is why HIGH keys to "HK" and MAC to "MS". A missing character is
 * therefore modelled as `nil` and treated as satisfying both tests, not as a
 * character that fails them.
 */

@inline(__always) private func isVowelSlot(_ c: UInt8?) -> Bool {
    guard let c else { return true }              // 'AEIOU'.includes('') === true
    return c == 65 || c == 69 || c == 73 || c == 79 || c == 85
}

@inline(__always) private func isSoftFollower(_ c: UInt8?) -> Bool {
    guard let c else { return true }              // 'IEY'.includes('') === true
    return c == 73 || c == 69 || c == 89
}

@inline(__always) private func at(_ s: [UInt8], _ i: Int) -> UInt8? {
    (i >= 0 && i < s.count) ? s[i] : nil
}

/// Does `s` start at `i` with the three given bytes? (`substr(i, 3) === "..."`)
@inline(__always) private func has3(_ s: [UInt8], _ i: Int, _ a: UInt8, _ b: UInt8, _ c: UInt8) -> Bool {
    i + 2 < s.count && s[i] == a && s[i + 1] == b && s[i + 2] == c
}

// MARK: - Metaphone-lite

/// Phonetic key: PH→F, CK→K, CH→X, SH→X, TH→0, soft C→S, soft G→J, silent
/// GN/KN/PN/WR/PS, silent internal H. Capped at six symbols, like the JS.
func metaphoneRaw(_ input: [UInt8]) -> [UInt8] {
    // `.replace(/[^A-Z]/g, '')` — digits are dropped before the state machine.
    var s = [UInt8]()
    s.reserveCapacity(input.count)
    for b in input where b >= 65 && b <= 90 { s.append(b) }
    if s.isEmpty { return [] }

    let len = s.count
    var out = [UInt8]()
    out.reserveCapacity(6)
    var i = 0

    // Silent leading digraphs.
    if len >= 2 {
        let a = s[0], b = s[1]
        if (a == 71 && b == 78) || (a == 75 && b == 78) || (a == 80 && b == 78)
            || (a == 87 && b == 82) || (a == 80 && b == 83) { i = 1 }
    }

    while i < len && out.count < 6 {
        let c = s[i]
        let n = at(s, i + 1)
        let p = at(s, i - 1)

        if let p, c == p, c != 67 { i += 1; continue }   // doubled letters, C excepted

        switch c {
        case 65, 69, 73, 79, 85:                        // A E I O U
            if i == 0 { out.append(65) }
            i += 1
        case 66:                                        // B
            out.append(80); i += 1
        case 67:                                        // C
            if has3(s, i, 67, 73, 65) || n == 72 { out.append(88); i += 2 }
            else if isSoftFollower(n) { out.append(83); i += 1 }
            else { out.append(75); i += 1 }
        case 68:                                        // D
            if n == 71, isSoftFollower(at(s, i + 2)) { out.append(74); i += 3 }
            else { out.append(84); i += 1 }
        case 70:                                        // F
            out.append(70); i += 1
        case 71:                                        // G
            if n == 72 {
                if isVowelSlot(at(s, i + 2)) { out.append(75) }
                i += 2
            } else if n == 78 {
                i += 1
            } else if isSoftFollower(n) {
                out.append(74); i += 1
            } else {
                out.append(75); i += 1
            }
        case 72:                                        // H
            if isVowelSlot(p) && isVowelSlot(n) { out.append(72) }
            i += 1
        case 74: out.append(74); i += 1                 // J
        case 75: out.append(75); i += 1                 // K
        case 76: out.append(76); i += 1                 // L
        case 77: out.append(77); i += 1                 // M
        case 78: out.append(78); i += 1                 // N
        case 80:                                        // P
            if n == 72 { out.append(70); i += 2 } else { out.append(80); i += 1 }
        case 81: out.append(75); i += 1                 // Q
        case 82: out.append(82); i += 1                 // R
        case 83:                                        // S
            if has3(s, i, 83, 67, 72) { out.append(88); i += 3 }
            else if n == 72 || has3(s, i, 83, 73, 79) || has3(s, i, 83, 73, 65) { out.append(88); i += 2 }
            else { out.append(83); i += 1 }
        case 84:                                        // T
            if n == 72 { out.append(48); i += 2 }       // '0'
            else if has3(s, i, 84, 73, 79) || has3(s, i, 84, 73, 65) { out.append(88); i += 3 }
            else { out.append(84); i += 1 }
        case 86: out.append(70); i += 1                 // V
        case 87, 89:                                    // W, Y
            if isVowelSlot(n), i == 0 { out.append(65) }
            i += 1
        case 88:                                        // X
            if i == 0 { out.append(83) } else { out.append(75); out.append(83) }
            i += 1
        case 90: out.append(83); i += 1                 // Z
        default: i += 1
        }
    }
    return out
}

// MARK: - Transliteration fold

@inline(__always)
private func replaceAll(_ src: [UInt8], _ pattern: [UInt8], _ replacement: [UInt8]) -> [UInt8] {
    let m = pattern.count
    guard m > 0, src.count >= m else { return src }
    var out = [UInt8]()
    out.reserveCapacity(src.count)
    var i = 0
    while i < src.count {
        if i + m <= src.count {
            var hit = true
            for k in 0..<m where src[i + k] != pattern[k] { hit = false; break }
            if hit {
                out.append(contentsOf: replacement)
                i += m
                continue
            }
        }
        out.append(src[i])
        i += 1
    }
    return out
}

/// `.replace(/(.)\1+/g, '$1')` — collapse runs of the same byte.
@inline(__always)
private func collapseRuns(_ src: [UInt8]) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(src.count)
    for b in src where out.last != b { out.append(b) }
    return out
}

/// Romanization-insensitive key: the same name spelled Yusuf / Yousef / Jusuf
/// folds together. Eleven passes, in the JS order — SCH before CH matters.
func foldTranslitRaw(_ input: [UInt8]) -> [UInt8] {
    var s = input
    s = replaceAll(s, [83, 67, 72], [83])   // SCH -> S
    s = replaceAll(s, [80, 72], [70])       // PH  -> F
    s = replaceAll(s, [71, 72], [71])       // GH  -> G
    s = replaceAll(s, [75, 72], [75])       // KH  -> K
    s = replaceAll(s, [84, 72], [84])       // TH  -> T
    s = replaceAll(s, [67, 75], [75])       // CK  -> K
    s = replaceAll(s, [67, 72], [67])       // CH  -> C
    s = replaceAll(s, [83, 72], [83])       // SH  -> S
    s = replaceAll(s, [87, 82], [82])       // WR  -> R
    s = replaceAll(s, [81, 85], [75])       // QU  -> K
    s = replaceAll(s, [88], [75, 83])       // X   -> KS

    s = collapseRuns(s)

    var stripped = [UInt8]()
    stripped.reserveCapacity(s.count)
    for b in s where b != 72 && b != 87 { stripped.append(b) }   // drop H, W

    for i in 0..<stripped.count {
        let b = stripped[i]
        if b == 69 || b == 73 || b == 89 || b == 74 { stripped[i] = 73 }  // E I Y J -> I
        else if b == 79 || b == 85 { stripped[i] = 85 }                   // O U     -> U
    }

    // Vowel folding can create new runs (YOUSEF -> IUUSIF), so collapse again or
    // the same name romanized two ways stops sharing the trigrams the candidate
    // index is built on.
    stripped = collapseRuns(stripped)

    var out = [UInt8]()
    out.reserveCapacity(stripped.count)
    for b in stripped where (b >= 65 && b <= 90) || (b >= 48 && b <= 57) { out.append(b) }
    return out
}

/// Do two folded forms share a trigram? The transliteration boost is gated on
/// this because it is the same signal the candidate index is built from — a boost
/// firing without it would score a hit the prefilter can never surface.
func sharesFoldedGram(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    // Folds shorter than a trigram carry no evidence: folding collapses "HAAA"
    // to "A", which would then "match" every token that folds to one letter.
    if a.count < 3 || b.count < 3 { return false }
    if a == b { return true }
    for i in 0...(a.count - 3) {
        let x = a[i], y = a[i + 1], z = a[i + 2]
        if b.count >= 3 {
            for j in 0...(b.count - 3) where b[j] == x && b[j + 1] == y && b[j + 2] == z {
                return true
            }
        }
    }
    return false
}

// MARK: - Edit / set similarity

public func jaroWinkler(_ a: [UInt8], _ b: [UInt8]) -> Double {
    if a == b { return 1 }
    if a.isEmpty || b.isEmpty { return 0 }
    let matchDist = max(0, max(a.count, b.count) / 2 - 1)
    var aMatch = [Bool](repeating: false, count: a.count)
    var bMatch = [Bool](repeating: false, count: b.count)
    var matches = 0
    for i in 0..<a.count {
        let start = max(0, i - matchDist)
        let end = min(i + matchDist + 1, b.count)
        var j = start
        while j < end {
            if !bMatch[j] && a[i] == b[j] {
                aMatch[i] = true; bMatch[j] = true; matches += 1
                break
            }
            j += 1
        }
    }
    if matches == 0 { return 0 }
    var transpositions = 0.0
    var k = 0
    for i in 0..<a.count where aMatch[i] {
        while !bMatch[k] { k += 1 }
        if a[i] != b[k] { transpositions += 1 }
        k += 1
    }
    transpositions /= 2
    let m = Double(matches)
    let jaro = (m / Double(a.count) + m / Double(b.count) + (m - transpositions) / m) / 3
    var prefix = 0
    for i in 0..<min(4, min(a.count, b.count)) {
        if a[i] == b[i] { prefix += 1 } else { break }
    }
    return jaro + Double(prefix) * 0.1 * (1 - jaro)
}

/// Damerau–Levenshtein with a reduced cost for confusable substitutions (0↔O,
/// 1↔L, homoglyph digits): a disguised character is nearly a match.
public func damerau(_ a: [UInt8], _ b: [UInt8]) -> Double {
    let al = a.count, bl = b.count
    if al == 0 { return Double(bl) }
    if bl == 0 { return Double(al) }
    let w = bl + 1
    var prev2 = [Double](repeating: 0, count: w)
    var prev = [Double](repeating: 0, count: w)
    var cur = [Double](repeating: 0, count: w)
    for j in 0...bl { prev[j] = Double(j) }
    for i in 1...al {
        cur[0] = Double(i)
        let ca = a[i - 1]
        for j in 1...bl {
            let cb = b[j - 1]
            let cost: Double = ca == cb ? 0 : (Matching.isConfusable(ca, cb) ? 0.5 : 1)
            var v = prev[j] + 1
            let ins = cur[j - 1] + 1; if ins < v { v = ins }
            let sub = prev[j - 1] + cost; if sub < v { v = sub }
            if i > 1, j > 1, ca == b[j - 2], a[i - 2] == cb {
                let tr = prev2[j - 2] + 1; if tr < v { v = tr }
            }
            cur[j] = v
        }
        swap(&prev2, &prev)
        swap(&prev, &cur)
    }
    return prev[bl]
}

public func editSim(_ a: [UInt8], _ b: [UInt8]) -> Double {
    let maxLen = max(a.count, b.count)
    return maxLen > 0 ? 1 - damerau(a, b) / Double(maxLen) : 1
}

/// Sørensen–Dice over bigram multisets, intersected by merging two sorted arrays.
func dice(_ a: Token, _ b: Token) -> Double {
    if a.text == b.text { return 1 }
    if a.count < 2 || b.count < 2 { return 0 }
    let A = a.sortedBigrams, B = b.sortedBigrams
    var i = 0, j = 0, inter = 0
    while i < A.count && j < B.count {
        if A[i] == B[j] { inter += 1; i += 1; j += 1 }
        else if A[i] < B[j] { i += 1 }
        else { j += 1 }
    }
    return (2 * Double(inter)) / Double(A.count + B.count)
}

/// Trigram Jaccard over the padded forms — stronger than Dice on longer strings.
func jaccard3(_ a: Token, _ b: Token) -> Double {
    if a.text == b.text { return 1 }
    if a.count < 2 || b.count < 2 { return 0 }
    let A = a.paddedTrigrams, B = b.paddedTrigrams
    let (small, large) = A.count <= B.count ? (A, B) : (B, A)
    var inter = 0
    for g in small where large.contains(g) { inter += 1 }
    return Double(inter) / Double(A.count + B.count - inter)
}

/// Whole-string channels operate on the joined token text, which is not interned;
/// these build the n-grams directly rather than going through the token cache.
func diceRaw(_ a: [UInt8], _ b: [UInt8]) -> Double {
    if a == b { return 1 }
    if a.count < 2 || b.count < 2 { return 0 }
    func bigrams(_ s: [UInt8]) -> [UInt16] {
        var out = [UInt16]()
        out.reserveCapacity(s.count - 1)
        for i in 0..<(s.count - 1) { out.append(UInt16(s[i]) << 8 | UInt16(s[i + 1])) }
        return out.sorted()
    }
    let A = bigrams(a), B = bigrams(b)
    var i = 0, j = 0, inter = 0
    while i < A.count && j < B.count {
        if A[i] == B[j] { inter += 1; i += 1; j += 1 }
        else if A[i] < B[j] { i += 1 }
        else { j += 1 }
    }
    return (2 * Double(inter)) / Double(A.count + B.count)
}

func jaccard3Raw(_ a: [UInt8], _ b: [UInt8]) -> Double {
    if a == b { return 1 }
    if a.count < 2 || b.count < 2 { return 0 }
    func padded(_ s: [UInt8]) -> Set<UInt32> {
        var p = [UInt8](repeating: 32, count: s.count + 4)
        for (i, b) in s.enumerated() { p[i + 2] = b }
        var set = Set<UInt32>()
        for i in 0...(p.count - 3) {
            set.insert(UInt32(p[i]) << 16 | UInt32(p[i + 1]) << 8 | UInt32(p[i + 2]))
        }
        return set
    }
    let A = padded(a), B = padded(b)
    let (small, large) = A.count <= B.count ? (A, B) : (B, A)
    var inter = 0
    for g in small where large.contains(g) { inter += 1 }
    return Double(inter) / Double(A.count + B.count - inter)
}
