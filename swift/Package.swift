// swift-tools-version: 6.2
// GCode Controller 2.0: the native macOS app. See the plan in README "2.0".
import PackageDescription

let package = Package(
    name: "GCodeController",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "GCCCore", targets: ["GCCCore"]),
        .library(name: "GCCMachine", targets: ["GCCMachine"]),
        .library(name: "GCCLibrary", targets: ["GCCLibrary"]),
        .executable(name: "gcc", targets: ["gcc"]),
    ],
    targets: [
        // Pure Swift, no I/O: G-code, GRBL protocol, shared state, resume, progress, travel, surfacing.
        .target(name: "GCCCore"),
        // The machine: USB serial, the GRBL simulator, and the streaming session (1.0's controller).
        .target(name: "GCCMachine", dependencies: ["GCCCore"]),
        // The file library: blobs, SQLite, the Finder folder working copy, history, Trash, 1.0 import.
        .target(name: "GCCLibrary", dependencies: ["GCCCore"], linkerSettings: [.linkedLibrary("sqlite3")]),
        // Headless sender: `gcc ports`, `gcc stream [--simulate | --port P] file.nc`.
        .executableTarget(name: "gcc", dependencies: ["GCCMachine"]),
        .testTarget(name: "GCCCoreTests", dependencies: ["GCCCore"]),
        .testTarget(name: "GCCMachineTests", dependencies: ["GCCMachine"]),
        .testTarget(name: "GCCLibraryTests", dependencies: ["GCCLibrary"]),
    ]
)
