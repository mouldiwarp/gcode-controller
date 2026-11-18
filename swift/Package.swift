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
        .library(name: "GCCNet", targets: ["GCCNet"]),
        .executable(name: "gcc", targets: ["gcc"]),
    ],
    dependencies: [
        // HTTP and WebSocket server (SwiftNIO). The only third-party code.
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
        .package(url: "https://github.com/hummingbird-project/hummingbird-websocket.git", from: "2.0.0"),
    ],
    targets: [
        // Pure Swift, no I/O: G-code, GRBL protocol, shared state, resume, progress, travel, surfacing.
        .target(name: "GCCCore"),
        // The machine: USB serial, the GRBL simulator, and the streaming session (1.0's controller).
        .target(name: "GCCMachine", dependencies: ["GCCCore"]),
        // The file library: blobs, SQLite, the Finder folder working copy, history, Trash, 1.0 import.
        .target(name: "GCCLibrary", dependencies: ["GCCCore"], linkerSettings: [.linkedLibrary("sqlite3")]),
        // The running app without its window: hub HTTP API, Bonjour, the Mac-to-Mac link, library
        // sync, machine ownership and the inbox.
        .target(name: "GCCNet", dependencies: [
            "GCCCore", "GCCMachine", "GCCLibrary",
            .product(name: "Hummingbird", package: "hummingbird"),
            .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
            .product(name: "HummingbirdWSClient", package: "hummingbird-websocket"),
        ]),
        // Headless sender: `gcc ports`, `gcc stream [--simulate | --port P] file.nc`.
        .executableTarget(name: "gcc", dependencies: ["GCCMachine"]),
        .testTarget(name: "GCCCoreTests", dependencies: ["GCCCore"]),
        .testTarget(name: "GCCMachineTests", dependencies: ["GCCMachine"]),
        .testTarget(name: "GCCLibraryTests", dependencies: ["GCCLibrary"]),
        .testTarget(name: "GCCNetTests", dependencies: ["GCCNet", "GCCCore", "GCCMachine", "GCCLibrary"]),
    ]
)
