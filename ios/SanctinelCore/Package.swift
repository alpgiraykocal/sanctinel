// swift-tools-version: 5.9
import PackageDescription

// The screening engine, kept out of the app target on purpose: it is
// Foundation-only, so `swift test` runs it headless in CI on any machine with a
// Swift toolchain — which is what the conformance test against the JavaScript
// implementation needs.
let package = Package(
    name: "SanctinelCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "SanctinelCore", targets: ["SanctinelCore"]),
    ],
    targets: [
        .target(name: "SanctinelCore", resources: [.copy("Resources/matching.json")]),
        .testTarget(
            name: "SanctinelCoreTests",
            dependencies: ["SanctinelCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
