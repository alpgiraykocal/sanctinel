import Foundation
import SwiftUI
import BackgroundTasks
import SanctinelCore

/*
 * Owns the device's copy of the list and everything that keeps it current.
 *
 * The app is fully offline: screening, the full record, the ownership network
 * and the statistics all run against the stored snapshot, so a query never
 * leaves the phone and the app works with no network at all. The only thing
 * networking does is replace the list.
 *
 * A staleness threshold is enforced rather than merely displayed. A sanctions
 * list that silently ages is worse than one that is visibly missing: the analyst
 * gets the same confident-looking hits from a list that no longer matches what
 * the authority has published.
 */
@Observable
@MainActor
final class SnapshotService {

    enum Phase: Equatable {
        case starting
        case preparing(stage: String)
        case ready
        case failed(String)
    }

    /// Beyond this the list is treated as stale and the UI says so everywhere,
    /// not just on the Settings screen.
    static let stalenessThreshold: TimeInterval = 7 * 24 * 3600
    static let backgroundTaskIdentifier = "com.sanctinel.ios.refresh"

    private(set) var phase: Phase = .starting
    private(set) var engine: ScreeningEngine?
    private(set) var relationships: RelationshipGraph?
    private(set) var stats: SnapshotStats?
    private(set) var manifest: SnapshotStore.Manifest?

    private(set) var isRefreshing = false
    private(set) var lastRefreshMessage: String?
    private(set) var lastRefreshFailed = false
    /// When the app last reached the publisher — including checks that came back
    /// "unchanged". Persisted, because "we checked an hour ago" is only reassuring
    /// if it survives a relaunch.
    private(set) var lastCheckedAt: Date?
    private let lastCheckedKey = "lastSnapshotCheck"

    private let store: SnapshotStore
    private let fetcher: SnapshotFetcher
    private var refreshTask: Task<Void, Never>?

    init(store: SnapshotStore? = nil, fetcher: SnapshotFetcher = SnapshotFetcher()) {
        self.store = store ?? (try? SnapshotStore(directory: SnapshotStore.defaultDirectory()))
            ?? SnapshotStore(directory: URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("Snapshot", isDirectory: true))
        self.fetcher = fetcher
        lastCheckedAt = UserDefaults.standard.object(forKey: lastCheckedKey) as? Date
        Matching.loadBundled()
    }

    // MARK: - Derived state

    var meta: SnapshotMetaData { engine?.meta ?? SnapshotMetaData() }
    var isReady: Bool { if case .ready = phase { return true }; return false }
    var recordCount: Int { engine?.records.count ?? 0 }
    var storageBytes: Int { store.storageBytes }

    /// Age measured from the authority's publication date, not from the download
    /// — a list that downloaded fine but was published three weeks ago is three
    /// weeks old.
    var listAge: TimeInterval? {
        guard let published = DateText.parse(manifest?.publishedDate ?? meta.publishedDate) else { return nil }
        return Date().timeIntervalSince(published)
    }

    var isStale: Bool {
        guard let age = listAge else { return manifest != nil }
        return age > Self.stalenessThreshold
    }

    var ageText: String {
        guard let age = listAge else { return "unknown age" }
        let days = Int(age / 86400)
        if days <= 0 { return "today" }
        if days == 1 { return "1 day old" }
        return "\(days) days old"
    }

    // MARK: - Start-up

    func start() {
        guard case .starting = phase else { return }
        Task { await bootstrap() }
    }

    private func bootstrap() async {
        // Prefer what is already on disk: a rebuild is expensive and the stored
        // copy is what the previous run screened against.
        if store.hasSnapshot, await loadStored() {
            await refresh(reason: .launch)
            return
        }
        // First launch, or a format change. The seed shipped in the bundle means
        // the app can screen before it has ever reached the network.
        await importSeed()
        if isReady { await refresh(reason: .launch) }
    }

    @discardableResult
    private func loadStored() async -> Bool {
        phase = .preparing(stage: "Loading the list…")
        let store = self.store
        do {
            let loaded = try await Task.detached(priority: .userInitiated) {
                try store.load()
            }.value
            apply(loaded)
            return true
        } catch {
            // A corrupt or outdated archive is not fatal — rebuild from the seed.
            return false
        }
    }

    private func importSeed() async {
        guard let url = Bundle.main.url(forResource: "seed-snapshot", withExtension: "json.gz")
                ?? Bundle.main.url(forResource: "seed-snapshot.json", withExtension: "gz") else {
            phase = .failed("The bundled list is missing from this build.")
            return
        }
        do {
            let data = try Data(contentsOf: url)
            try await importSnapshot(data, etag: "", label: "Preparing the list")
        } catch {
            phase = .failed(message(for: error))
        }
    }

    private func importSnapshot(_ data: Data, etag: String, label: String) async throws {
        let store = self.store
        phase = .preparing(stage: "\(label)…")

        let manifest = try await Task.detached(priority: .userInitiated) { [weak self] in
            try store.importSnapshot(gzipped: data, etag: etag) { progress in
                Task { @MainActor in
                    self?.phase = .preparing(stage: "\(label) — \(progress.stage.rawValue)…")
                }
            }
        }.value

        let loaded = try await Task.detached(priority: .userInitiated) { try store.load() }.value
        apply(loaded)
        self.manifest = manifest
    }

    private func apply(_ loaded: SnapshotStore.Loaded) {
        engine = loaded.engine
        relationships = loaded.relationships
        stats = loaded.stats
        manifest = loaded.manifest
        phase = .ready
    }

    // MARK: - Refresh

    enum RefreshReason { case launch, manual, background }

    func refresh(reason: RefreshReason) async {
        if isRefreshing { return }
        // On launch, only reach for the network when the stored list has had time
        // to go out of date; a cold start should not wait on a 5 MB download.
        if reason == .launch, let age = listAge, age < 12 * 3600, manifest != nil { return }

        isRefreshing = true
        lastRefreshFailed = false
        defer { isRefreshing = false }

        do {
            let outcome = try await fetcher.fetch(currentETag: manifest?.etag ?? "")
            noteChecked()
            switch outcome {
            case .notModified:
                lastRefreshMessage = "Already current — the published list has not changed."
            case .updated(let data, let etag):
                try await importSnapshot(data, etag: etag, label: "Updating the list")
                lastRefreshMessage = "Updated to the list published \(DateText.medium(manifest?.publishedDate ?? ""))."
            }
        } catch is CancellationError {
            return
        } catch {
            lastRefreshFailed = true
            lastRefreshMessage = message(for: error)
            // A failed refresh must never take the working list away.
            if !isReady, store.hasSnapshot { await loadStored() }
        }
    }

    func refreshNow() {
        refreshTask?.cancel()
        refreshTask = Task { await refresh(reason: .manual) }
    }

    func rebuildFromSeed() {
        refreshTask?.cancel()
        refreshTask = Task {
            store.deleteAll()
            engine = nil
            relationships = nil
            stats = nil
            manifest = nil
            phase = .starting
            await bootstrap()
        }
    }

    private func noteChecked() {
        let now = Date()
        lastCheckedAt = now
        UserDefaults.standard.set(now, forKey: lastCheckedKey)
    }

    private func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    // MARK: - Records

    /// The full listed record for a hit, read from disk on demand.
    func fullRecord(at index: Int) -> [String: Any]? {
        store.fullRecord(at: index)
    }

    // MARK: - Background refresh

    /// Registered at launch. iOS decides when these actually run, so this is a
    /// best-effort daily top-up — the foreground catch-up in `bootstrap` is what
    /// guarantees the list is checked when someone actually opens the app.
    static func registerBackgroundTask(service: @escaping () -> SnapshotService?) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: backgroundTaskIdentifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { return task.setTaskCompleted(success: false) }
            scheduleBackgroundRefresh()
            let work = Task { @MainActor in
                await service()?.refresh(reason: .background)
                refresh.setTaskCompleted(success: true)
            }
            refresh.expirationHandler = { work.cancel() }
        }
    }

    static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: backgroundTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 12 * 3600)
        try? BGTaskScheduler.shared.submit(request)
    }
}
