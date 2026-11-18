// swift-tools-version: 6.2
// GCode Controller 2.0: the native macOS app. See the plan in README "2.0".
import PackageDescription

let package = Package(
    name: "GCodeController",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "GCCCore", targets: ["GCCCore"]),
    ],
    targets: [
        // Pure Swift, no I/O: G-code, GRBL protocol, shared state, resume, progress, travel, surfacing.
        .target(name: "GCCCore"),
        .testTarget(name: "GCCCoreTests", dependencies: ["GCCCore"]),
    ]
)
