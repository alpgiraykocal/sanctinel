import Foundation
import SwiftUI
import SanctinelCore

/*
 * Screening state.
 *
 * Search runs on-device against the stored snapshot, so there is no network in
 * this path at all — no debounce against a rate limit, no cold start, no
 * truncated payload. The debounce that remains is purely about not scoring 38k
 * records on every keystroke, and it runs off the main actor so typing stays
 * smooth while a query is scored.
 */
@Observable
@MainActor
final class SearchModel {
    var query = SearchQuery()
    var outcome: SearchOutcome?
    var errorText: String?
    var isSearching = false

    private var task: Task<Void, Never>?
    private var runID = 0
    private weak var service: SnapshotService?

    func attach(_ service: SnapshotService) { self.service = service }

    var hits: [Hit] { outcome?.hits ?? [] }
    var hasQuery: Bool { !query.isEmpty }

    /// The engine returns the top slice but reports every hit above the
    /// threshold; an analyst who reads "200 matches" when 573 cleared the line
    /// has been misinformed.
    var truncationNotice: String? {
        guard let outcome, outcome.truncated else { return nil }
        return "Showing the top \(outcome.hits.count) of \(outcome.count) hits above this threshold. Narrow the query or raise the threshold to see the rest."
    }

    var fullScanNotice: String? {
        guard let outcome, outcome.fullScan, outcome.count > 0 else { return nil }
        return "Below 0.95 every record is scored, so this took longer and will include weaker leads."
    }

    func record(for hit: Hit) -> ScreeningRecord? {
        guard let engine = service?.engine, hit.recordIndex < engine.records.count else { return nil }
        return engine.records[hit.recordIndex]
    }

    func runDebounced() {
        task?.cancel()
        guard hasQuery else {
            runID += 1
            outcome = nil
            errorText = nil
            isSearching = false
            return
        }
        task = Task { [weak self] in
            // Short: this is local work, so the wait is about coalescing
            // keystrokes rather than sparing a server.
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled else { return }
            await self?.run()
        }
    }

    func runNow() {
        task?.cancel()
        guard hasQuery else { return }
        task = Task { [weak self] in await self?.run() }
    }

    private func run() async {
        guard let engine = service?.engine else {
            errorText = "The list is still being prepared."
            return
        }
        let options = query.options
        runID += 1
        let id = runID
        isSearching = true
        errorText = nil

        // Scoring happens off the main actor: at the widened threshold this is a
        // full scan of 38k records and must not block typing.
        let result = await Task.detached(priority: .userInitiated) {
            engine.search(options)
        }.value

        guard runID == id else { return }
        outcome = result
        isSearching = false
    }

    func reset() {
        task?.cancel()
        runID += 1
        query = SearchQuery()
        outcome = nil
        errorText = nil
        isSearching = false
    }

    func clearFilters() {
        query.authority = ""
        query.list = ""
        query.program = ""
        query.yob = ""
        query.country = ""
        runDebounced()
    }

    /// Back to the defaults the engine would apply on its own, keeping the query.
    func resetQuerySettings() {
        query.threshold = ScreeningEngine.defaultThreshold
        clearFilters()
    }
}

/// Everything the engine accepts, in one value the view can bind to.
struct SearchQuery: Equatable {
    var q = ""
    var threshold: Double = ScreeningEngine.defaultThreshold
    var authority = ""
    var list = ""
    var program = ""
    var yob = ""
    var country = ""

    var isEmpty: Bool { q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var hasFilters: Bool {
        !authority.isEmpty || !list.isEmpty || !program.isEmpty || !yob.isEmpty || !country.isEmpty
    }

    var filterCount: Int {
        [authority, list, program, yob, country].filter { !$0.isEmpty }.count
    }

    var isThresholdDefault: Bool {
        abs(threshold - ScreeningEngine.defaultThreshold) < 0.0001
    }

    /// Anything that makes this query different from what the engine does by
    /// default. The results header reports it, so a widened threshold or a
    /// narrowed list is never something the reader has to remember setting.
    var isAdjusted: Bool { hasFilters || !isThresholdDefault }

    var adjustmentCount: Int { filterCount + (isThresholdDefault ? 0 : 1) }

    var adjustmentSummary: String {
        var parts: [String] = []
        if !isThresholdDefault { parts.append(String(format: "%.2f", threshold)) }
        if !authority.isEmpty { parts.append(authority) }
        if !list.isEmpty { parts.append(list) }
        if !program.isEmpty { parts.append(program) }
        if !yob.isEmpty { parts.append("b.\(yob)") }
        if !country.isEmpty { parts.append(country) }
        if parts.count <= 2 { return parts.joined(separator: " · ") }
        return parts.prefix(2).joined(separator: " · ") + " +\(parts.count - 2)"
    }

    var options: SearchQueryOptions {
        SearchQueryOptions(
            query: q,
            threshold: threshold,
            authority: authority,
            list: list,
            program: program,
            mods: (yob.isEmpty && country.isEmpty) ? nil : Modifiers(yob: yob, country: country)
        )
    }
}

/// Recently opened records, so an analyst can step back to a hit after wandering
/// through its ownership network. Ids and names only, on this device — the
/// queries that found them are never written anywhere.
@Observable
@MainActor
final class RecentStore {
    private(set) var items: [Item] = []
    private let key = "recentEntities"
    private let limit = 25

    struct Item: Codable, Identifiable, Hashable {
        var id: String
        var name: String
        var authority: String
        var list: String
    }

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let decoded = try? JSONDecoder().decode([Item].self, from: data) {
            items = decoded
        }
    }

    func record(id: String, name: String, authority: String, list: String) {
        let item = Item(id: id, name: name, authority: authority, list: list)
        items.removeAll { $0.id == item.id }
        items.insert(item, at: 0)
        if items.count > limit { items = Array(items.prefix(limit)) }
        persist()
    }

    func clear() {
        items = []
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}
