import SwiftUI
import SanctinelCore

struct RootView: View {
    @State private var service = SnapshotService()
    @State private var recents = RecentStore()
    @State private var tab: Tab = .screen
    @Environment(\.scenePhase) private var scenePhase

    enum Tab: Hashable { case screen, insights, settings }

    var body: some View {
        Group {
            switch service.phase {
            case .starting, .preparing:
                PreparingView(service: service)
            case .failed(let message):
                FailedView(message: message) { service.rebuildFromSeed() }
            case .ready:
                tabs
            }
        }
        .tint(Palette.primary)
        .environment(service)
        .environment(recents)
        .task {
            ServiceHolder.shared.service = service
            service.start()
            SnapshotService.scheduleBackgroundRefresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the app is the one moment we know the analyst is
            // about to rely on the list, so it is the right time to check it.
            if phase == .active, service.isReady {
                Task { await service.refresh(reason: .launch) }
            }
        }
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            SearchView()
                .tabItem { Label("Screen", systemImage: "magnifyingglass") }
                .tag(Tab.screen)

            InsightsView()
                .tabItem { Label("Insights", systemImage: "chart.bar.xaxis") }
                .tag(Tab.insights)

            SettingsView()
                .tabItem { Label("List", systemImage: "shield.lefthalf.filled") }
                .tag(Tab.settings)
        }
    }
}

/// First launch builds the search index from the list shipped in the app, so
/// screening works before the phone has ever reached the network. It takes a
/// moment and says what it is doing rather than showing a bare spinner.
struct PreparingView: View {
    let service: SnapshotService

    private var stage: String {
        if case .preparing(let stage) = service.phase { return stage }
        return "Starting…"
    }

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "shield.lefthalf.filled")
                .font(.system(size: 44))
                .foregroundStyle(Palette.primary)
            Text("Sanctinel")
                .font(.title2.weight(.bold))
                .foregroundStyle(Palette.foreground)
            ProgressView()
            Text(stage)
                .font(.footnote)
                .foregroundStyle(Palette.mutedFg)
                .multilineTextAlignment(.center)
            Text("Building the search index from the list bundled with the app. This happens once; every search after it runs on the device, offline.")
                .font(.caption)
                .foregroundStyle(Palette.mutedFg)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer()
            DisclaimerBanner(compact: true).padding(.horizontal, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
    }
}

struct FailedView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 38))
                .foregroundStyle(Palette.warn)
            Text("The list could not be prepared")
                .font(.headline)
                .foregroundStyle(Palette.foreground)
            Text(message)
                .font(.footnote)
                .foregroundStyle(Palette.body)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Rebuild from the bundled list", action: retry)
                .buttonStyle(.borderedProminent)
            Text("Nothing is screened until this succeeds — the app will not fall back to a partial list.")
                .font(.caption)
                .foregroundStyle(Palette.mutedFg)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
    }
}

#Preview {
    RootView()
}
