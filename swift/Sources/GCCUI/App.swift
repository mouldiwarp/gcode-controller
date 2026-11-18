// The app: on first launch, the role picker; then the main window, laid out as 1.0 (top bar and
// banners; DRO and jog on the left; job, library and tools on the right; 3D in the centre from
// phase 6), with toasts, the start confirmation, the library sheets and the menus.

import AppKit
import GCCCore
import GCCNet
import SwiftUI

public struct GCodeControllerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    public init() {}

    public var body: some Scene {
        Window("GCode Controller", id: "main") {
            RootView()
                .environment(model)
                .frame(minWidth: 1100, minHeight: 700)
                .preferredColorScheme(.dark)
                .onAppear { delegate.model = model }
        }
        .defaultSize(width: 1440, height: 900)
        .commands { AppCommands(model: model) }

        Settings {
            SetupView(initial: model.setup ?? AppSetup.load() ?? .suggested(), isFirstRun: false)
                .environment(model)
                .preferredColorScheme(.dark)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor var model: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `swift run` starts a plain process: make it a normal app with a window and a Dock icon.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        if model.jobRunningHere {
            let a = NSAlert()
            a.messageText = "A job is running on this Mac's machine"
            a.informativeText = "Quitting stops the job. Quit anyway?"
            a.alertStyle = .critical
            a.addButton(withTitle: "Keep running")
            a.addButton(withTitle: "Stop and quit")
            if a.runModal() == .alertFirstButtonReturn { return .terminateCancel }
        }
        Task { @MainActor in
            await model.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var keys = JogKeys()

    var body: some View {
        Group {
            if model.setup == nil, AppSetup.load() == nil {
                SetupView(initial: .suggested(), isFirstRun: true)
            } else if let e = model.launchError {
                LaunchFailed(error: e)
            } else if let s = model.state {
                MainWindow(s: s)
            } else {
                ProgressView("Starting…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.obsidian)
        .task {
            if model.setup == nil, model.instance == nil, let saved = AppSetup.load() { await model.launch(saved) }
        }
        .onAppear { keys.install(model) }
        .onDisappear { keys.remove() }
    }
}

struct MainWindow: View {
    @Environment(AppModel.self) private var model
    let s: AppState
    @AppStorage("gcc.rightWidth") private var rightWidth = 400.0

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            TopBar(s: s)
            Banners(s: s)
            HStack(alignment: .top, spacing: 12) {
                ScrollView {
                    VStack(spacing: 12) {
                        DroPanel(s: s)
                        JogPanel(s: s)
                    }
                }
                .frame(width: 330)
                .frame(maxHeight: .infinity)
                .scrollIndicators(.never)

                CentrePlaceholder(s: s)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                VStack(spacing: 12) {
                    JobPanel(s: s)
                    LibraryPanel(s: s).frame(maxHeight: .infinity)
                    ToolsPanel(s: s).frame(height: 260)
                }
                .frame(width: rightWidth)
                .overlay(alignment: .leading) { ColumnResizer(width: $rightWidth) }
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.obsidian)
        .foregroundStyle(Color.offwhite)
        .overlay(alignment: .bottomTrailing) { ToastsView().padding(16) }
        .sheet(isPresented: $model.managerOpen) { LibraryManager(s: s).environment(model) }
        .sheet(isPresented: $model.conflictsOpen) { ConflictsView().environment(model) }
        .alert(item: $model.confirmStart) { req in startAlert(req) }
    }

    /// Phase 6 replaces this with the full start dialog (preview, travel check, work zero).
    private func startAlert(_ req: StartRequest) -> Alert {
        let f = s.library.first { $0.id == req.fileId }
        let name = req.next ? (s.nextGroupFile?.name ?? f?.name ?? "the file") : (f?.name ?? "the file")
        let w = s.machine.wpos
        var lines = ["Work zero is set where X, Y and Z read 0. The tool is now at X \(fixed(w.x, 2)) Y \(fixed(w.y, 2)) Z \(fixed(w.z, 2))."]
        if let f, f.estSeconds > 0 { lines.append("About \(formatDuration(f.estSeconds)), \(dims(f)) mm.") }
        if let f, f.group != nil, !req.next { lines.append("Runs the rest of group \(f.group!) after it, pausing for each bit change.") }
        if model.conflict(for: req.fileId) != nil { lines.append("This file has a conflict: this Mac's version will run.") }
        if s.machine.homed != true { lines.append("The machine isn't homed, so moves aren't checked against its travel.") }
        let start = Alert.Button.default(Text(req.next ? "Start next" : "Start")) {
            if req.next { model.send(.startNext) } else { model.send(.start(fileId: req.fileId, group: f?.group != nil ? true : nil, fromLine: nil)) }
        }
        return Alert(title: Text("Start \(name)?"), message: Text(lines.joined(separator: "\n\n")), primaryButton: start, secondaryButton: .cancel())
    }
}

/// The 3D view arrives in phase 6; meanwhile, what's loaded.
struct CentrePlaceholder: View {
    @Environment(AppModel.self) private var model
    let s: AppState

    var body: some View {
        let f = s.job.fileId.flatMap { id in s.library.first { $0.id == id } } ?? model.selected
        VStack(spacing: 10) {
            Image(systemName: "cube.transparent").font(.system(size: 48, weight: .thin)).foregroundStyle(Color.steelDim)
            Text(f?.name ?? "No file selected").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.offwhite)
            if let f {
                Text("\(dims(f)) · ~\(formatDuration(f.estSeconds))")
                    .font(.system(size: 12)).foregroundStyle(Color.steel)
            }
            Text("The toolpath view comes in the next update.").font(.system(size: 11.5)).foregroundStyle(Color.steelDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.slate))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.line))
    }
}

/// Drag the right column's left edge to resize it.
struct ColumnResizer: View {
    @Binding var width: Double
    @State private var start: Double?

    var body: some View {
        Rectangle().fill(Color.clear).frame(width: 8).offset(x: -10)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { g in
                        if start == nil { start = width }
                        width = min(640, max(320, (start ?? width) - g.translation.width))
                    }
                    .onEnded { _ in start = nil })
    }
}

struct ToastsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(model.toasts) { t in
                let c: Color = t.level == .error ? .danger : t.level == .warn ? .warn : .info
                HStack(alignment: .top, spacing: 10) {
                    Rectangle().fill(c).frame(width: 3)
                    Text(t.text).font(.system(size: 12.5)).foregroundStyle(Color.offwhite).fixedSize(horizontal: false, vertical: true)
                    Button {
                        model.dismiss(t.id)
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                    }
                    .buttonStyle(.plain).foregroundStyle(Color.steel)
                }
                .padding(.vertical, 8).padding(.trailing, 10)
                .frame(maxWidth: 380, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.slate3))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.lineStrong))
                .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.toasts)
    }
}

struct LaunchFailed: View {
    @Environment(AppModel.self) private var model
    let error: String

    var body: some View {
        VStack(spacing: 12) {
            Text("GCode Controller couldn't start").font(.system(size: 17, weight: .semibold))
            Text(error).font(.system(size: 13)).foregroundStyle(Color.steel).multilineTextAlignment(.center).frame(maxWidth: 520)
            HStack {
                Button("Try again") { if let s = model.setup { Task { await model.launch(s) } } }.gccButton(.primary)
                SettingsLink { Text("Settings…") }.gccButton()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: First run and Settings: this Mac's role

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var setup: AppSetup
    let isFirstRun: Bool

    init(initial: AppSetup, isFirstRun: Bool) {
        _setup = State(initialValue: initial)
        self.isFirstRun = isFirstRun
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isFirstRun {
                Text("GCODE CONTROLLER").font(.custom("Helvetica", size: 15).weight(.bold)).tracking(4).foregroundStyle(Color.gold)
                Text("How does this Mac fit in?").font(.system(size: 20, weight: .semibold))
            } else {
                Text("THIS MAC").font(.heading).tracking(2)
            }
            HStack(spacing: 12) {
                roleCard(.hub, "Hub", "The design Mac. Keeps the library, takes files from Swarf, Fretboard and the inbox folder.")
                roleCard(.agent, "Agent", "The machine Mac in the garage. Keeps a copy of the library and works on its own if the hub is off.")
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("Name").foregroundStyle(Color.steel)
                    TextField("Name", text: $setup.name).gccField().frame(width: 280)
                }
                GridRow {
                    Text("Machine").foregroundStyle(Color.steel)
                    Picker("", selection: $setup.machine) {
                        ForEach(MachineKind.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .labelsHidden().frame(width: 300)
                }
                if setup.role == .agent {
                    GridRow {
                        Text("Hub").foregroundStyle(Color.steel)
                        TextField("Found automatically (or host:port)", text: $setup.hubAddress).gccField().frame(width: 280)
                    }
                }
                GridRow {
                    Text("Trial").foregroundStyle(Color.steel)
                    Toggle("Run alongside 1.0 (own port, folder and data; 1.0 is left alone)", isOn: $setup.trial)
                }
            }
            .font(.system(size: 13))
            Text(where_).font(.system(size: 11.5)).foregroundStyle(Color.steel).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                if !isFirstRun { Button("Cancel") { dismiss() }.gccButton() }
                Button(isFirstRun ? "Start" : "Apply and restart") {
                    let s = setup
                    Task { await model.launch(s) }
                    if !isFirstRun { dismiss() }
                }
                .gccButton(.primary).keyboardShortcut(.defaultAction)
                .disabled(setup.name.trimmingCharacters(in: .whitespaces).isEmpty || (!isFirstRun && model.jobRunningHere))
            }
        }
        .padding(28)
        .frame(width: 640)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(isFirstRun ? Color.obsidian : Color.slate)
        .foregroundStyle(Color.offwhite)
    }

    private var where_: String {
        "Library folder: \(setup.libraryRoot.path(percentEncoded: false).replacingOccurrences(of: NSHomeDirectory(), with: "~"))"
            + (setup.role == .hub ? " · Swarf/Fretboard port \(setup.port)" : "")
            + (setup.role == .hub && setup.trial && setup.v1 != nil ? " · 1.0's library is copied in on first start (1.0 isn't changed)" : "")
    }

    private func roleCard(_ role: Role, _ title: String, _ text: String) -> some View {
        let on = setup.role == role
        return Button {
            setup.role = role
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(title.uppercased()).font(.heading).tracking(2).foregroundStyle(on ? Color.goldBright : .offwhite)
                Text(text).font(.system(size: 12)).foregroundStyle(Color.steel).fixedSize(horizontal: false, vertical: true)
            }
            .padding(14).frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 8).fill(on ? Color.goldDim : Color.slate))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? Color.gold : Color.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: Menus

struct AppCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Add to Library…") { model.uploadOpen = true }.keyboardShortcut("o")
                .disabled(model.state == nil)
            Button("Manage Library…") { model.managerOpen = true }.keyboardShortcut("l", modifiers: [.command, .shift])
                .disabled(model.state == nil)
            Button("Show Library in Finder") { model.revealLibrary() }.disabled(model.state == nil)
            Button("Resolve Conflicts…") { model.conflictsOpen = true }.disabled(model.conflicts.isEmpty)
        }
        CommandMenu("Machine") {
            let s = model.state
            let ready = s?.machineReady == true
            Button("Connect") { model.send(.connect(port: nil)) }.disabled(s?.machine.connection != .disconnected)
            Button("Disconnect") { model.send(.disconnect) }.disabled(!ready || s?.jobActive == true)
            Divider()
            Button("Home") { model.send(.home) }.keyboardShortcut("h", modifiers: [.command, .option])
                .disabled(!ready || s?.jobActive == true)
            Button("Unlock") { model.send(.unlock) }.disabled(!ready || s?.machine.status != .alarm)
            Button("Probe Z") { model.send(.probeZ) }.disabled(!ready || s?.machine.status != .idle || s?.jobActive == true)
            Divider()
            Button(s?.machine.status == .hold ? "Resume" : "Feed Hold") { model.send(s?.machine.status == .hold ? .resume : .hold) }
                .keyboardShortcut("h", modifiers: [.command, .shift]).disabled(!ready)
            Button("Stop") { model.send(.stop) }.keyboardShortcut(".", modifiers: .command).disabled(!ready)
            Button("Soft Reset") { model.send(.reset) }.disabled(!ready)
        }
    }
}
