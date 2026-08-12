import Foundation

/*
 * Snapshot analytics — a port of lib/stats.js.
 *
 * Everything here is derived from the SAME snapshot the screening path uses, so
 * a statistic and a search result can never disagree. On the phone this runs
 * once, when a snapshot is imported, and the result is stored: a full pass over
 * 38k entities is not something to repeat on every tab switch.
 *
 * Dates: each authority publishes its listing date in its own format — OFAC, EU,
 * UN and BIS in ISO, UK OFSI in DD/MM/YYYY. They are normalized to ISO here so
 * the timeline and the "recent" ranking are comparable. The date is the
 * AUTHORITY'S designation date, not when the app fetched it.
 */

public struct SnapshotStats: Codable, Sendable {
    public struct Totals: Codable, Sendable {
        public var entities = 0
        public var authorities = 0
        public var lists = 0
        public var programs = 0
        public var countries = 0
        public var dated = 0
        public var undated = 0
        public var withAliases = 0
        public var withIdentifiers = 0
        public var withRelationships = 0
        public var relationshipEdges = 0
        public var ownershipEdges = 0
        public var added30 = 0
        public var added90 = 0
        public var added365 = 0
        public var newest = ""
        public var oldest = ""
        public init() {}
    }

    public struct Bucket: Codable, Sendable, Hashable, Identifiable {
        public let name: String
        public let count: Int
        public var id: String { name }
        public init(name: String, count: Int) { self.name = name; self.count = count }
    }

    public struct Year: Codable, Sendable, Hashable, Identifiable {
        public let label: String
        public let count: Int
        public var id: String { label }
    }

    public struct RecentDesignation: Codable, Sendable, Hashable, Identifiable {
        public let id: String
        public let name: String
        public let authority: String
        public let list: String
        public let type: String
        public let title: String
        public let programs: [String]
        public let measures: [String]
        public let date: String
        public let aliases: Int
        public let country: String
    }

    public var generatedAt = ""
    public var totals = Totals()
    public var byAuthority: [Bucket] = []
    public var byList: [Bucket] = []
    public var byType: [Bucket] = []
    public var byMeasure: [Bucket] = []
    public var byProgram: [Bucket] = []
    public var byCountry: [Bucket] = []
    public var years: [Year] = []
    public var recent: [RecentDesignation] = []

    public init() {}
}

public enum StatsBuilder {
    static let recentLimit = 150         // most recent designations across all lists
    static let recentPerAuthority = 40   // …plus this many per authority, so the
                                         // authority filter is never empty for a
                                         // list that has not published lately
    static let topN = 15
    static let timelineYears = 16
    private static let day: TimeInterval = 86_400

    /// A date only counts if it exists on the calendar: "31/02/2020" would
    /// otherwise sort into the timeline and render blank.
    static func isRealDate(_ y: Int, _ m: Int, _ d: Int) -> Bool {
        guard m >= 1, m <= 12, d >= 1 else { return false }
        var components = DateComponents()
        components.year = y; components.month = m; components.day = d
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = calendar.date(from: components) else { return false }
        let back = calendar.dateComponents([.year, .month, .day], from: date)
        return back.year == y && back.month == m && back.day == d
    }

    /// Accepts "YYYY-MM-DD" / ISO timestamps and "D/M/YYYY" (UK OFSI).
    public static func normalizeDate(_ value: String) -> String {
        let s = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return "" }
        let chars = Array(s)

        // ^(\d{4})-(\d{2})-(\d{2})
        if chars.count >= 10,
           let y = Int(String(chars[0..<4])), chars[4] == "-",
           let m = Int(String(chars[5..<7])), chars[7] == "-",
           let d = Int(String(chars[8..<10])),
           chars[0..<4].allSatisfy(\.isNumber), chars[5..<7].allSatisfy(\.isNumber),
           chars[8..<10].allSatisfy(\.isNumber) {
            return isRealDate(y, m, d) ? String(chars[0..<10]) : ""
        }

        // ^(\d{1,2})/(\d{1,2})/(\d{4})$
        let parts = s.split(separator: "/", omittingEmptySubsequences: false)
        if parts.count == 3,
           parts[0].count >= 1, parts[0].count <= 2, parts[0].allSatisfy(\.isNumber),
           parts[1].count >= 1, parts[1].count <= 2, parts[1].allSatisfy(\.isNumber),
           parts[2].count == 4, parts[2].allSatisfy(\.isNumber),
           let d = Int(parts[0]), let m = Int(parts[1]), let y = Int(parts[2]),
           isRealDate(y, m, d) {
            return String(format: "%04d-%02d-%02d", y, m, d)
        }
        return ""
    }

    /// Nationality/citizenship where the authority states it, else the address
    /// country. Counted once per entity so a party with five addresses in one
    /// country does not outweigh five separate parties.
    static func countries(of entity: [String: Any]) -> [String] {
        var out: [String] = []
        for a in entity["attributes"] as? [[String: Any]] ?? [] {
            let label = RecordBuilder.string(a["label"])
            // By canonical kind: matching the two literal strings meant OFAC's own
            // wording — `Nationality Country` (5,821 attributes) and `Citizenship
            // Country` (1,142) — never matched, so for OFAC parties this fell
            // through to the address country and the chart described where a party
            // is located rather than what it is a national of.
            let kind = Vocab.attributeKind(label)
            guard kind == "nationality" || kind == "citizenship" else { continue }
            for c in Countries.parse(RecordBuilder.string(a["value"])) where !out.contains(c) {
                out.append(c)
            }
        }
        if out.isEmpty {
            for ad in entity["addresses"] as? [[String: Any]] ?? [] {
                let c = Countries.canonical(RecordBuilder.string(ad["country"]))
                if !c.isEmpty, !out.contains(c) { out.append(c) }
            }
        }
        return out
    }

    public static func compute(entities: [[String: Any]], now: Date = Date()) -> SnapshotStats {
        var byAuthority: [String: Int] = [:], byList: [String: Int] = [:], byType: [String: Int] = [:]
        var byMeasure: [String: Int] = [:], byProgram: [String: Int] = [:], byCountry: [String: Int] = [:]
        var byYear: [String: Int] = [:]

        var totals = SnapshotStats.Totals()
        var recent: [SnapshotStats.RecentDesignation] = []
        let nowSeconds = now.timeIntervalSince1970

        func bump(_ map: inout [String: Int], _ key: String) {
            if key.isEmpty { return }
            map[key, default: 0] += 1
        }

        for entity in entities {
            let authorityRaw = RecordBuilder.string(entity["authority"])
            let authority = authorityRaw.isEmpty ? "OFAC" : authorityRaw
            bump(&byAuthority, authority)
            bump(&byList, RecordBuilder.string(entity["list"]))
            let type = RecordBuilder.string(entity["type"])
            bump(&byType, type.isEmpty ? "Unknown" : type)

            let measures = measuresOf(entity)
            for m in measures { bump(&byMeasure, m) }
            for p in entity["programs"] as? [String] ?? [] { bump(&byProgram, p) }

            let countryList = countries(of: entity)
            for c in countryList { bump(&byCountry, c) }

            let names = entity["names"] as? [[String: Any]] ?? []
            if names.count > 1 { totals.withAliases += 1 }
            let identifiers = entity["identifiers"] as? [[String: Any]] ?? []
            let documents = entity["idDocuments"] as? [[String: Any]] ?? []
            if !identifiers.isEmpty || !documents.isEmpty { totals.withIdentifiers += 1 }

            let relationships = entity["relationships"] as? [[String: Any]] ?? []
            if !relationships.isEmpty { totals.withRelationships += 1 }
            totals.relationshipEdges += relationships.count
            for r in relationships where Ownership.isOwnership(RecordBuilder.string(r["type"])) {
                totals.ownershipEdges += 1
            }

            let date = normalizeDate(RecordBuilder.string(entity["datePublished"]))
            if date.isEmpty { continue }
            totals.dated += 1
            if totals.newest.isEmpty || date > totals.newest { totals.newest = date }
            if totals.oldest.isEmpty || date < totals.oldest { totals.oldest = date }
            bump(&byYear, String(date.prefix(4)))

            if let parsed = utcMidnight(date) {
                let age = nowSeconds - parsed
                if age >= 0 {
                    if age <= 30 * day { totals.added30 += 1 }
                    if age <= 90 * day { totals.added90 += 1 }
                    if age <= 365 * day { totals.added365 += 1 }
                }
            }

            recent.append(SnapshotStats.RecentDesignation(
                id: RecordBuilder.string(entity["id"]),
                name: RecordBuilder.string(entity["name"]),
                authority: authority,
                list: RecordBuilder.string(entity["list"]),
                type: type.isEmpty ? "Unknown" : type,
                title: RecordBuilder.string(entity["title"]),
                programs: Array((entity["programs"] as? [String] ?? []).prefix(6)),
                measures: measures,
                date: date,
                aliases: max(0, names.count - 1),
                country: countryList.first ?? ""
            ))
        }

        recent.sort { a, b in
            if a.date != b.date { return a.date > b.date }
            return compareLocalized(a.name, b.name) == .orderedAscending
        }

        // Global head plus each authority's own head. OFAC publishes far more
        // often than the others, so a purely global window would leave the
        // EU/UN/UK/BIS filters showing nothing.
        var picked = Set(recent.prefix(recentLimit).map(\.id))
        var perAuthority: [String: Int] = [:]
        for r in recent {
            let n = perAuthority[r.authority] ?? 0
            if n >= recentPerAuthority { continue }
            perAuthority[r.authority] = n + 1
            picked.insert(r.id)
        }
        let recentOut = recent.filter { picked.contains($0.id) }

        totals.entities = entities.count
        totals.undated = entities.count - totals.dated
        totals.authorities = byAuthority.count
        totals.lists = byList.count
        totals.programs = byProgram.count
        totals.countries = byCountry.count

        // Trailing window ending at the newest designation in the snapshot, so a
        // list that has not published for a few days is not a gap at the edge.
        let endYear = Int(totals.newest.prefix(4)) ?? Calendar(identifier: .gregorian)
            .component(.year, from: now)
        var years: [SnapshotStats.Year] = []
        for y in (endYear - timelineYears + 1)...endYear {
            let label = String(y)
            years.append(SnapshotStats.Year(label: label, count: byYear[label] ?? 0))
        }

        var stats = SnapshotStats()
        stats.generatedAt = ISO8601DateFormatter().string(from: now)
        stats.totals = totals
        stats.byAuthority = topList(byAuthority, limit: nil)
        stats.byList = topList(byList, limit: topN)
        stats.byType = topList(byType, limit: nil)
        stats.byMeasure = topList(byMeasure, limit: topN)
        stats.byProgram = topList(byProgram, limit: topN)
        stats.byCountry = topList(byCountry, limit: topN)
        stats.years = years
        stats.recent = recentOut
        return stats
    }

    static func measuresOf(_ entity: [String: Any]) -> [String] {
        if let list = entity["sanctionsTypes"] as? [String], !list.isEmpty { return list }
        let single = RecordBuilder.string(entity["sanctionsType"])
        return single.isEmpty ? [] : [single]
    }

    static func topList(_ map: [String: Int], limit: Int?) -> [SnapshotStats.Bucket] {
        var entries = map.map { SnapshotStats.Bucket(name: $0.key, count: $0.value) }
        entries.sort { a, b in
            a.count == b.count ? compareLocalized(a.name, b.name) == .orderedAscending : a.count > b.count
        }
        if let limit { entries = Array(entries.prefix(limit)) }
        return entries
    }

    /// `String.prototype.localeCompare` — ICU collation, so "a" sorts before "B".
    /// Pinned to en_US rather than the device locale so the ordering is the same
    /// on every phone and the same as the server's.
    static func compareLocalized(_ a: String, _ b: String) -> ComparisonResult {
        a.compare(b, options: [], range: nil, locale: Locale(identifier: "en_US"))
    }

    static func utcMidnight(_ isoDay: String) -> TimeInterval? {
        var components = DateComponents()
        components.year = Int(isoDay.prefix(4))
        components.month = Int(isoDay.dropFirst(5).prefix(2))
        components.day = Int(isoDay.dropFirst(8).prefix(2))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.date(from: components)?.timeIntervalSince1970
    }
}
