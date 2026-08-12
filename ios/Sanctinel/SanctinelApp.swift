import SwiftUI
import SanctinelCore

@main
struct SanctinelApp: App {
    @State private var registered = false

    init() {
        // Registration has to happen before the app finishes launching, and the
        // handler needs the live service, which the scene owns — so it reaches
        // back through a weak holder rather than the other way round.
        SnapshotService.registerBackgroundTask { ServiceHolder.shared.service }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// Lets the background-task handler, which runs outside the view hierarchy,
/// reach the running service.
@MainActor
final class ServiceHolder {
    static let shared = ServiceHolder()
    weak var service: SnapshotService?
}
