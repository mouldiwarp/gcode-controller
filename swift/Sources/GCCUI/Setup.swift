// How this Mac runs: Hub or Agent, its name, where its machine is, and (until the cut-over) whether
// it's a trial alongside 1.0. Kept in UserDefaults; chosen on first launch, changed in Settings.

import Foundation
import GCCCore
import GCCLibrary
import GCCMachine
import GCCNet

public enum MachineKind: String, Codable, CaseIterable, Sendable {
    /// The FoxAlien on a USB port of this Mac (found automatically).
    case usb
    /// The built-in GRBL simulator, for trying things out.
    case simulator
    /// No machine here; the other Mac has it.
    case none

    public var label: String {
        switch self {
        case .usb: "USB (FoxAlien plugged into this Mac)"
        case .simulator: "Simulator"
        case .none: "None (the other Mac has it)"
        }
    }
}

public struct AppSetup: Codable, Equatable, Sendable {
    public var role: Role
    public var name: String
    public var machine: MachineKind
    /// Agent: the hub as "host" or "host:port"; empty finds it with Bonjour.
    public var hubAddress: String
    /// Run alongside 1.0: its own port, folder, data and Bonjour service, so 1.0 is untouched.
    public var trial: Bool

    public init(role: Role, name: String, machine: MachineKind, hubAddress: String = "", trial: Bool = true) {
        self.role = role
        self.name = name
        self.machine = machine
        self.hubAddress = hubAddress
        self.trial = trial
    }

    /// A first guess for the role picker.
    public static func suggested() -> AppSetup {
        AppSetup(role: .hub, name: Host.current().localizedName ?? "This Mac", machine: .none)
    }

    static let key = "gcc.setup"

    /// Development: GCC_HOME=<folder> puts every path (and the saved setup) under that folder, on its
    /// own port and Bonjour service, so it can run beside the installed app without either noticing.
    static let devHome: URL? = ProcessInfo.processInfo.environment["GCC_HOME"].map { URL(filePath: $0) }
    public static var store: UserDefaults { devHome == nil ? .standard : UserDefaults(suiteName: "GCodeController.dev")! }

    public static func load(_ defaults: UserDefaults = store) -> AppSetup? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(AppSetup.self, from: $0) }
    }

    public func save(_ defaults: UserDefaults = AppSetup.store) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: AppSetup.key) }
    }

    // MARK: Where things live

    private static var home: URL { devHome ?? FileManager.default.homeDirectoryForCurrentUser }
    private static var support: URL { home.appending(path: "Library/Application Support/GCodeController") }

    /// The database and content blobs.
    public var dataDir: URL { AppSetup.support.appending(path: trial ? "app-trial" : "app") }
    /// The Finder folder.
    public var libraryRoot: URL { AppSetup.home.appending(path: trial ? "Documents/GCode Controller 2.0 Trial" : "Documents/GCode Controller") }
    /// Hub: files dropped here are imported.
    public var inbox: URL { AppSetup.home.appending(path: trial ? "GCode Inbox 2.0 Trial" : "GCode Inbox") }
    public var port: Int { AppSetup.devHome != nil ? defaultHubPort + 10 : trial ? defaultHubPort + 1 : defaultHubPort }
    public var serviceType: String { AppSetup.devHome != nil ? "_gcodehub-dev._tcp" : trial ? "_gcodehub-try._tcp" : hubServiceType }

    /// 1.0's hub library, imported (read only) on the hub's first start.
    public var v1: V1Paths? {
        guard role == .hub else { return nil }
        let p = V1Paths(dataDir: AppSetup.support.appending(path: "hub"), libraryDir: AppSetup.home.appending(path: "Documents/GCode Controller"))
        return FileManager.default.fileExists(atPath: p.libraryDir.path) ? p : nil
    }

    /// Agent: the hub's link, or nil to find it with Bonjour.
    public var hubURL: URL? {
        let a = hubAddress.trimmingCharacters(in: .whitespaces)
        if a.isEmpty { return nil }
        if a.contains("://") { return URL(string: a) }
        let hostPort = a.contains(":") ? a : "\(a):\(port)"
        return URL(string: "ws://\(hostPort)/link")
    }

    public var machineOption: MachineOption {
        switch machine {
        case .usb: .serial(path: nil)
        case .simulator: .simulator(FakeGrblOptions())
        case .none: .none
        }
    }

    public var instanceOptions: InstanceOptions {
        InstanceOptions(
            name: name, role: role, port: port, serviceType: serviceType, hubURL: role == .agent ? hubURL : nil, machine: machineOption,
            inbox: role == .hub ? inbox : nil)
    }

    public var libraryOptions: LibraryOptions {
        LibraryOptions(dataDir: dataDir, root: libraryRoot, systemTrash: true, importV1: v1)
    }
}
