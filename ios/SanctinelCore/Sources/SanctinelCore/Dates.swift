import Foundation

/*
 * Date-of-birth parsing into comparable intervals — a port of lib/dates.js.
 *
 * The four feeds write a birth date twelve different ways, and the screening
 * path used to pull every `\b(19|20)\d\d\b` out of the string and test the
 * user's year for membership. Right for "26 Mar 1990", wrong for every range:
 * against "1975 to 1979" the years list is [1975, 1979], so a person born in
 * 1977 — inside the range the list itself states — scored as a CONTRADICTION.
 */
public struct DateInterval: Sendable, Equatable {
    public let from: String        // YYYY-MM-DD, inclusive
    public let to: String          // YYYY-MM-DD, inclusive
    public let precision: String   // day | month | year | range
    public let approximate: Bool

    /// Does a four-digit year fall inside the interval?
    public func coversYear(_ year: String) -> Bool {
        guard !year.isEmpty else { return false }
        return String(from.prefix(4)) <= year && year <= String(to.prefix(4))
    }
}

public enum Dates {

    static let months: [String: Int] = [
        "JAN": 1, "JANUARY": 1, "FEB": 2, "FEBRUARY": 2, "MAR": 3, "MARCH": 3,
        "APR": 4, "APRIL": 4, "MAY": 5, "JUN": 6, "JUNE": 6, "JUL": 7, "JULY": 7,
        "AUG": 8, "AUGUST": 8, "SEP": 9, "SEPT": 9, "SEPTEMBER": 9, "OCT": 10,
        "OCTOBER": 10, "NOV": 11, "NOVEMBER": 11, "DEC": 12, "DECEMBER": 12,
    ]

    static let monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    static func daysIn(_ year: Int, _ month: Int) -> Int {
        guard month >= 1, month <= 12 else { return 0 }
        if month == 2, (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 { return 29 }
        return monthLengths[month - 1]
    }

    static func ymd(_ y: Int, _ m: Int, _ d: Int) -> String {
        let ys = String(format: "%04d", y), ms = String(format: "%02d", m), ds = String(format: "%02d", d)
        return "\(ys)-\(ms)-\(ds)"
    }

    /// A calendar-valid day, or nil — guards against a source typo like 31 Feb
    /// producing an interval that sorts before its own start.
    static func day(_ y: Int, _ m: Int, _ d: Int) -> String? {
        guard y >= 1000, y <= 2999, m >= 1, m <= 12, d >= 1, d <= daysIn(y, m) else { return nil }
        return ymd(y, m, d)
    }

    static func monthSpan(_ y: Int, _ m: Int) -> (String, String, String)? {
        guard y >= 1000, y <= 2999, m >= 1, m <= 12 else { return nil }
        return (ymd(y, m, 1), ymd(y, m, daysIn(y, m)), "month")
    }

    static func yearSpan(_ y: Int) -> (String, String, String)? {
        guard y >= 1000, y <= 2999 else { return nil }
        return (ymd(y, 1, 1), ymd(y, 12, 31), "year")
    }

    /// Split a string into runs of digits and runs of letters, dropping the rest.
    /// Enough to classify every published form without a regex engine.
    static func fields(_ s: String) -> [(text: String, isDigits: Bool)] {
        var out: [(String, Bool)] = []
        var current = ""
        var digits = false
        for ch in s {
            let isD = ch.isNumber, isL = ch.isLetter
            if !isD && !isL {
                if !current.isEmpty { out.append((current, digits)); current = "" }
                continue
            }
            if !current.isEmpty && isD != digits { out.append((current, digits)); current = "" }
            digits = isD
            current.append(ch)
        }
        if !current.isEmpty { out.append((current, digits)) }
        return out
    }

    /// One date expression → bounds and precision, with no range handling.
    static func parseSingle(_ raw: String) -> (from: String, to: String, precision: String)? {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { return nil }
        let parts = fields(s)
        let separators = s.filter { !$0.isNumber && !$0.isLetter && !$0.isWhitespace }

        // 1990-03-26 / 1990-03
        if parts.count == 3, parts.allSatisfy({ $0.isDigits }), parts[0].text.count == 4,
           separators.allSatisfy({ $0 == "-" }) {
            let y = Int(parts[0].text) ?? 0, m = Int(parts[1].text) ?? 0, d = Int(parts[2].text) ?? 0
            if let exact = day(y, m, d) { return (exact, exact, "day") }
            return monthSpan(y, m) ?? yearSpan(y)
        }
        if parts.count == 2, parts.allSatisfy({ $0.isDigits }), parts[0].text.count == 4,
           separators.allSatisfy({ $0 == "-" }) {
            let y = Int(parts[0].text) ?? 0, m = Int(parts[1].text) ?? 0
            return monthSpan(y, m) ?? yearSpan(y)
        }

        /*
         * 22/08/1990 — UK OFSI, and it is DAY first. Not an assumption: 1,611
         * values in the snapshot have a first field above 12 and none has a
         * second field above 12, so reading it as MM/DD would misdate them all.
         */
        if parts.count == 3, parts.allSatisfy({ $0.isDigits }), parts[2].text.count == 4,
           separators.allSatisfy({ $0 == "/" }) {
            let d = Int(parts[0].text) ?? 0, m = Int(parts[1].text) ?? 0, y = Int(parts[2].text) ?? 0
            if d == 0 && m == 0 { return yearSpan(y) }
            if d == 0 { return monthSpan(y, m) ?? yearSpan(y) }
            if let exact = day(y, m, d) { return (exact, exact, "day") }
            return monthSpan(y, m) ?? yearSpan(y)
        }

        // 26 Mar 1990
        if parts.count == 3, parts[0].isDigits, !parts[1].isDigits, parts[2].isDigits,
           parts[2].text.count == 4, let m = months[parts[1].text.uppercased()] {
            let d = Int(parts[0].text) ?? 0, y = Int(parts[2].text) ?? 0
            if let exact = day(y, m, d) { return (exact, exact, "day") }
            return monthSpan(y, m) ?? yearSpan(y)
        }
        // Mar 1990
        if parts.count == 2, !parts[0].isDigits, parts[1].isDigits, parts[1].text.count == 4,
           let m = months[parts[0].text.uppercased()] {
            return monthSpan(Int(parts[1].text) ?? 0, m)
        }
        // 1990
        if parts.count == 1, parts[0].isDigits, parts[0].text.count == 4 {
            return yearSpan(Int(parts[0].text) ?? 0)
        }
        return nil
    }

    static let approxWords: Set<String> = ["APPROX", "APPROXIMATELY", "CIRCA", "CA", "C"]

    /// Strip the approximation markers, reporting whether any were present.
    static func stripApprox(_ s: String) -> (String, Bool) {
        var found = false
        var out: [String] = []
        for word in s.split(separator: " ") {
            let bare = word.uppercased().replacingOccurrences(of: ".", with: "")
            if approxWords.contains(bare) { found = true; continue }
            out.append(String(word))
        }
        return (out.joined(separator: " "), found)
    }

    /*
     * One published value → an inclusive interval.
     *
     * OFAC restates its own ranges as an explicit bound pair —
     * "1975 to 1979 (range 1975-01-01–1979-12-31)" — and that parenthetical wins
     * when present: it is the publisher's own resolution of the range.
     */
    public static func parseValue(_ raw: String) -> DateInterval? {
        var s = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if s.isEmpty { return nil }
        let (stripped, approximate) = stripApprox(s)
        s = stripped.trimmingCharacters(in: .whitespaces)

        if let open = s.range(of: "(range ", options: .caseInsensitive),
           let close = s.range(of: ")", range: open.upperBound..<s.endIndex) {
            let inner = String(s[open.upperBound..<close.lowerBound])
            let bounds = inner.split(whereSeparator: { $0 == "–" || $0 == "—" || $0 == "-" })
            // Two ISO dates split into six digit groups by the dashes inside them.
            if bounds.count == 6 {
                let from = bounds[0...2].joined(separator: "-")
                let to = bounds[3...5].joined(separator: "-")
                return DateInterval(from: from, to: to, precision: "range", approximate: approximate)
            }
        }
        // Drop any trailing parenthetical that was not an explicit range.
        if s.hasSuffix(")"), let open = s.lastIndex(of: "(") {
            s = String(s[s.startIndex..<open]).trimmingCharacters(in: .whitespaces)
        }

        let pieces = splitRange(s)
        if pieces.count == 2 {
            let a = parseSingle(pieces[0]), b = parseSingle(pieces[1])
            if let a, let b {
                let (lo, hi) = a.from <= b.from ? (a, b) : (b, a)
                return DateInterval(from: lo.from, to: hi.to, precision: "range", approximate: approximate)
            }
            if let a { return DateInterval(from: a.from, to: a.to, precision: a.precision, approximate: approximate) }
            if let b { return DateInterval(from: b.from, to: b.to, precision: b.precision, approximate: approximate) }
            return nil
        }

        guard let one = parseSingle(s) else { return nil }
        return DateInterval(from: one.from, to: one.to, precision: one.precision, approximate: approximate)
    }

    /// `/\s+to\s+|\s*[–—]\s*/` — " to " or an en/em dash between two date parts.
    static func splitRange(_ s: String) -> [String] {
        var pieces: [String] = []
        var current = ""
        let chars = Array(s)
        var i = 0
        while i < chars.count {
            if chars[i] == "–" || chars[i] == "—" {
                pieces.append(current.trimmingCharacters(in: .whitespaces)); current = ""; i += 1; continue
            }
            if chars[i] == " ", i + 3 < chars.count,
               chars[i + 1] == "t" || chars[i + 1] == "T", chars[i + 2] == "o" || chars[i + 2] == "O",
               chars[i + 3] == " " {
                pieces.append(current.trimmingCharacters(in: .whitespaces)); current = ""; i += 4; continue
            }
            current.append(chars[i])
            i += 1
        }
        pieces.append(current.trimmingCharacters(in: .whitespaces))
        return pieces.filter { !$0.isEmpty }
    }
}
