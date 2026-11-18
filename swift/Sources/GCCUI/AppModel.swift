// The window's model: the running Instance, the latest AppState from it, toasts, and what's open.
// Every button sends a Command through `run`, which shows a refusal as a toast (as 1.0's store).

import AppKit
import Foundation
import GCCCore
import GCCLibrary
import GCCMachine
import GCCNet
import Observation
import UserNotifications

public struct ToastItem: Identifiable, Equatable {
    public let id = UUID()
    public var level: Toast.Level
    public var text: String
}

/// A file waiting for the start confirmation.
public struct StartRequest: Identifiable, Equatable {
    public var id: String { fileId }
    public var fileId: String
    /// The next file of a group, after a bit change.
    public var next: Bool
}

@MainActor @Observable
public final class AppModel {
    public private(set) var setup: AppSetup?
    public private(set) var state: AppState?
    public private(set) var instance: Instance?
    /// Why the app couldn't start (a busy port, an unreadable library).
    public private(set) var launchError: String?
    public private(set) var toasts: [ToastItem] = []
    public private(set) var conflicts: [LibraryConflict] = []
    public private(set) var trash: [TrashItem] = []

    /// The library file selected (shown in the 3D view when no job is loaded).
    public var previewId: String?
    public var confirmStart: StartRequest?
    public var managerOpen = false { didSet { if managerOpen { Task { await refreshTrash() } } } }
    public var conflictsOpen = false
    public var uploadOpen = false

    // Jog settings for this Mac (the step is remembered; the feeds start from the shared config).
    public var jogStep: Double = UserDefaults.standard.double(forKey: "gcc.jogStep") {
        didSet { UserDefaults.standard.set(jogStep, forKey: "gcc.jogStep") }
    }
    public var jogFeedXY: Double = 0
    public var jogFeedZ: Double = 0

    private var eventTask: Task<Void, Never>?
    private var refreshPending = false
    private var lastJob: JobStatus?
    private var lastAlarm: Int?
    private let notifications: Bool

    public init() {
        // Notifications need an app bundle (not `swift run`).
        notifications = Bundle.main.bundleIdentifier != nil
        if notifications { UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in } }
    }

    public var name: String { setup?.name ?? "This Mac" }

    // MARK: Lifecycle

    /// Start as `setup` says (first launch: after the role picker).
    public func launch(_ setup: AppSetup) async {
        await shutdown()
        setup.save()
        self.setup = setup
        launchError = nil
        do {
            try FileManager.default.createDirectory(at: setup.dataDir, withIntermediateDirectories: true)
            if setup.role == .hub { try FileManager.default.createDirectory(at: setup.inbox, withIntermediateDirectories: true) }
            let library = try await Library.open(setup.libraryOptions)
            await library.watch()
            try await attach(Instance(setup.instanceOptions, library: library))
            // Take the machine if it's plugged in here (and keep trying until it is).
            if setup.machine != .none, await instance?.owner() == Instance.Owner.none {
                try? await instance?.execute(.connect(port: nil), by: setup.name)
            }
        } catch {
            launchError = error.localizedDescription
        }
    }

    /// Run an instance (tests pass their own).
    public func attach(_ instance: Instance) async throws {
        self.instance = instance
        let events = await instance.events()
        eventTask = Task { [weak self] in
            for await e in events { self?.handle(e) }
        }
        try await instance.start()
        await refresh()
    }

    public func shutdown() async {
        eventTask?.cancel()
        eventTask = nil
        if let instance {
            await instance.stop()
            await instance.library.close()
        }
        instance = nil
        state = nil
    }

    // MARK: Events

    private func handle(_ e: InstanceEvent) {
        switch e {
        case .changed:
            guard !refreshPending else { return }
            refreshPending = true
            Task {
                try? await Task.sleep(for: .milliseconds(40))
                refreshPending = false
                await refresh()
            }
        case .toast(let t):
            toast(t.level, t.text)
        }
    }

    public func refresh() async {
        guard let instance else { return }
        let s = await instance.state()
        if state == nil || jogFeedXY == 0 {
            jogFeedXY = s.config.jogFeedXY
            jogFeedZ = s.config.jogFeedZ
            if !s.config.jogSteps.contains(jogStep) { jogStep = s.config.jogSteps.dropFirst().first ?? 1 }
        }
        noticeChanges(s)
        state = s
        let c = await instance.library.conflicts()
        // New conflicts (on reconnect): ask straight away.
        if c.contains(where: { n in !conflicts.contains { $0.id == n.id } }) { conflictsOpen = true }
        conflicts = c
        if conflicts.isEmpty { conflictsOpen = false }
        if managerOpen { await refreshTrash() }
    }

    public func refreshTrash() async {
        trash = await instance?.library.trash() ?? []
    }

    /// macOS notifications when a job finishes or the machine alarms.
    private func noticeChanges(_ s: AppState) {
        defer {
            lastJob = s.job.status
            lastAlarm = s.machine.alarm?.code
        }
        guard state != nil else { return }
        if s.job.status != lastJob {
            switch s.job.status {
            case .done: notify("Job finished", "\(s.job.fileName ?? "The job") is done.")
            case .toolchange: notify("Bit change", "\(s.job.fileName ?? "A file") is done. Fit the next bit and re-probe Z.")
            case .error: notify("Job stopped", s.job.error ?? "The job stopped with an error.")
            default: break
            }
        }
        if let a = s.machine.alarm, a.code != lastAlarm { notify("Alarm \(a.code)", a.message) }
    }

    private func notify(_ title: String, _ body: String) {
        guard notifications else { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // MARK: Commands

    /// Send a command; a refusal shows as a toast. Returns whether it worked.
    @discardableResult
    public func run(_ cmd: Command) async -> Bool {
        guard let instance else { return false }
        do {
            try await instance.execute(cmd, by: name)
            await refresh()
            return true
        } catch {
            toast(.error, error.localizedDescription)
            return false
        }
    }

    public func send(_ cmd: Command) { Task { await run(cmd) } }

    public func jog(_ x: Double, _ y: Double, _ z: Double) {
        guard state?.canJog == true else { return }
        let s = jogStep
        send(.jog(x: x == 0 ? nil : x * s, y: y == 0 ? nil : y * s, z: z == 0 ? nil : z * s, feed: z != 0 ? jogFeedZ : jogFeedXY))
    }

    /// Add files to the library (into `folder`, "" for the top level).
    public func upload(_ urls: [URL], folder: String = "") async {
        guard let instance else { return }
        for url in urls {
            do {
                guard isGcodeName(url.lastPathComponent) else { throw LibraryError("Not a G-code file") }
                let data = try Data(contentsOf: url)
                _ = try await instance.upload(data, AddOptions(name: url.lastPathComponent, source: "Upload", folder: folder))
            } catch {
                toast(.error, "\(url.lastPathComponent): \(error.localizedDescription)")
            }
        }
        await refresh()
    }

    /// A library action that isn't a Command (Trash, history, conflicts): the local library, which syncs.
    public func library(_ action: @Sendable (Library) async throws -> Void) async {
        guard let library = instance?.library else { return }
        do {
            try await action(library)
        } catch {
            toast(.error, error.localizedDescription)
        }
        await refresh()
        await refreshTrash()
    }

    public func revealLibrary() {
        guard let root = instance?.library.root else { return }
        NSWorkspace.shared.activateFileViewerSelecting([root])
    }

    // MARK: Toasts

    public func toast(_ level: Toast.Level, _ text: String) {
        let t = ToastItem(level: level, text: text)
        toasts = Array(toasts.suffix(4)) + [t]
        Task {
            try? await Task.sleep(for: .seconds(level == .error ? 9 : 4.5))
            dismiss(t.id)
        }
    }

    public func dismiss(_ id: UUID) { toasts.removeAll { $0.id == id } }

    // MARK: Questions

    public var selected: LibraryItem? { state?.library.first { $0.id == previewId } }

    public func conflict(for fileId: String) -> LibraryConflict? { conflicts.first { $0.entryId == fileId } }

    /// A job is running on this Mac's machine (quitting would stop it).
    public var jobRunningHere: Bool {
        guard let s = state else { return false }
        return s.link.machineOn == name && (s.jobActive || s.job.status == .toolchange)
    }
}
