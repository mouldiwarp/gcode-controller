// GCode Controller.app: a small native launcher for the hub or agent.
//
// It finds Node and this repo, builds the web UI if it's out of date, runs the
// server as a child process, shows its log, and opens the browser when the
// server answers. Quitting the app stops the server. Nothing starts at login:
// the server only runs while this app is open.
//
// Built by scripts/build-mac-app.sh with plain swiftc (no Xcode project), so it
// compiles with the Command Line Tools on the Monterey garage Mac too.

import AppKit

// MARK: - Roles

enum Role: String, CaseIterable {
    case hub, agent, simulator

    var title: String {
        switch self {
        case .hub: return "Hub (design Mac)"
        case .agent: return "Agent (garage Mac, USB machine)"
        case .simulator: return "Agent with simulator (no machine)"
        }
    }

    var shortTitle: String {
        switch self {
        case .hub: return "Hub"
        case .agent: return "Agent"
        case .simulator: return "Agent · Simulator"
        }
    }

    var package: String { self == .hub ? "hub" : "agent" }
    var port: Int { self == .hub ? 8080 : 8081 }
    var extraArgs: [String] { self == .simulator ? ["--simulate"] : [] }
}

enum ServerState: Equatable {
    case stopped, preparing(String), starting, running, failed(String)
}

// MARK: - Helpers

enum Paths {
    static let defaults = UserDefaults.standard

    /// The repo checkout: Info.plist (set at build time), then the remembered choice.
    static func repo() -> URL? {
        let candidates = [
            defaults.string(forKey: "repoPath"),
            Bundle.main.object(forInfoDictionaryKey: "GCCRepoPath") as? String,
        ]
        for case let path? in candidates where isRepo(path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    static func isRepo(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: path + "/packages/hub/src/main.ts")
    }

    /// Node from the usual install locations, or whatever a login shell finds.
    static func node() -> String? {
        let fm = FileManager.default
        var candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node"]
        let nvm = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            let sorted = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            candidates += sorted.map { "\(nvm)/\($0)/bin/node" }
        }
        if let found = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) { return found }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        let path = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return fm.isExecutableFile(atPath: path) ? path : nil
    }

    static func modified(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }

    /// True when the built UI is missing or older than any web or shared source file.
    static func webNeedsBuild(repo: URL) -> Bool {
        guard let built = modified(repo.appendingPathComponent("packages/web/dist/index.html")) else { return true }
        let sources = ["packages/web/src", "packages/web/index.html", "packages/web/public", "packages/shared/src"]
        for rel in sources {
            let url = repo.appendingPathComponent(rel)
            if let m = modified(url), m > built { return true }
            guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for case let file as URL in e {
                if let m = modified(file), m > built { return true }
            }
        }
        return false
    }
}

// MARK: - Server process

final class Server {
    var onLog: (String) -> Void = { _ in }
    var onState: (ServerState) -> Void = { _ in }

    private(set) var state: ServerState = .stopped { didSet { onState(state) } }
    private var process: Process?
    private var stdinPipe: Pipe?
    private var healthTimer: Timer?
    private var generation = 0
    private var stopping = false

    func start(role: Role, repo: URL, node: String, completion: @escaping (Bool) -> Void) {
        generation += 1
        let gen = generation
        stopping = false
        let nodeDir = (node as NSString).deletingLastPathComponent
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(nodeDir):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["FORCE_COLOR"] = "0"

        DispatchQueue.global(qos: .userInitiated).async {
            // 1. Dependencies and the web UI, the same steps as the .command launchers.
            if !FileManager.default.fileExists(atPath: repo.path + "/node_modules") {
                self.setState(.preparing("Installing packages (first run)…"), gen)
                guard self.runStep(["npm", "install"], repo: repo, env: env, nodeDir: nodeDir, gen: gen) else {
                    return self.fail("npm install failed. See the log.", gen, completion)
                }
            }
            if Paths.webNeedsBuild(repo: repo) {
                self.setState(.preparing("Building the web UI…"), gen)
                guard self.runStep(["npm", "run", "build:web"], repo: repo, env: env, nodeDir: nodeDir, gen: gen) else {
                    return self.fail("Building the web UI failed. See the log.", gen, completion)
                }
            }
            guard gen == self.generation else { return }

            // 2. The server itself. stdin is a pipe we hold open; the server exits
            //    when it closes, so a force-quit app never leaves it running.
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: node)
                p.currentDirectoryURL = repo
                p.environment = env
                p.arguments = [
                    repo.path + "/node_modules/tsx/dist/cli.mjs",
                    repo.path + "/packages/\(role.package)/src/main.ts",
                ] + role.extraArgs + ["--exit-with-parent"]
                let input = Pipe()
                p.standardInput = input
                self.attachOutput(to: p)
                p.terminationHandler = { proc in
                    DispatchQueue.main.async {
                        guard gen == self.generation else { return }
                        self.healthTimer?.invalidate()
                        self.process = nil
                        self.stdinPipe = nil
                        if self.stopping || proc.terminationStatus == 0 {
                            self.state = .stopped
                        } else {
                            self.state = .failed("The \(role.package) stopped (exit \(proc.terminationStatus)). See the log.")
                        }
                    }
                }
                do {
                    try p.run()
                } catch {
                    return self.fail("Couldn't start Node: \(error.localizedDescription)", gen, completion)
                }
                self.process = p
                self.stdinPipe = input
                self.state = .starting
                self.log("▶ \(role.shortTitle) started (pid \(p.processIdentifier))\n")
                self.waitForHealth(port: role.port, gen: gen, completion: completion)
            }
        }
    }

    /// SIGTERM, then SIGKILL after 3 s.
    func stop(then: (() -> Void)? = nil) {
        stopping = true
        healthTimer?.invalidate()
        guard let p = process, p.isRunning else {
            generation += 1
            state = .stopped
            then?()
            return
        }
        log("■ Stopping…\n")
        p.terminate()
        let pid = p.processIdentifier
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning { kill(pid, SIGKILL) }
            p.waitUntilExit()
            DispatchQueue.main.async {
                self.generation += 1
                self.process = nil
                self.stdinPipe = nil
                self.state = .stopped
                then?()
            }
        }
    }

    var isRunning: Bool { process?.isRunning ?? false }

    // MARK: private

    private func setState(_ s: ServerState, _ gen: Int) {
        DispatchQueue.main.async { if gen == self.generation { self.state = s } }
    }

    private func fail(_ message: String, _ gen: Int, _ completion: @escaping (Bool) -> Void) {
        DispatchQueue.main.async {
            guard gen == self.generation else { return }
            self.log("✖ \(message)\n")
            self.state = .failed(message)
            completion(false)
        }
    }

    private func log(_ s: String) {
        if Thread.isMainThread { onLog(s) } else { DispatchQueue.main.async { self.onLog(s) } }
    }

    private func attachOutput(to p: Process) {
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; return }
            self?.log(String(decoding: data, as: UTF8.self))
        }
    }

    /// Runs `npm …` to completion, streaming output to the log. Called off the main thread.
    private func runStep(_ args: [String], repo: URL, env: [String: String], nodeDir: String, gen: Int) -> Bool {
        let npm = nodeDir + "/npm"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: FileManager.default.isExecutableFile(atPath: npm) ? npm : "/usr/bin/env")
        p.arguments = FileManager.default.isExecutableFile(atPath: npm) ? Array(args.dropFirst()) : args
        p.currentDirectoryURL = repo
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        attachOutput(to: p)
        log("$ \(args.joined(separator: " "))\n")
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0 && gen == generation
    }

    private func waitForHealth(port: Int, gen: Int, completion: @escaping (Bool) -> Void) {
        let url = URL(string: "http://localhost:\(port)/api/health")!
        var done = false
        let started = Date()
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self = self, gen == self.generation, !done else { timer.invalidate(); return }
            if Date().timeIntervalSince(started) > 60 {
                timer.invalidate()
                self.state = .failed("The server didn't answer on port \(port).")
                completion(false)
                return
            }
            var req = URLRequest(url: url)
            req.timeoutInterval = 1
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
                DispatchQueue.main.async {
                    guard gen == self.generation, !done else { return }
                    done = true
                    timer.invalidate()
                    self.state = .running
                    completion(true)
                }
            }.resume()
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let server = Server()
    var window: NSWindow!
    var dot = NSView()
    var statusLabel = NSTextField(labelWithString: "")
    var urlButton = NSButton()
    var openButton = NSButton()
    var restartButton = NSButton()
    var logView = NSTextView()
    var roleItems: [Role: NSMenuItem] = [:]
    var quitting = false

    var role: Role? {
        get { UserDefaults.standard.string(forKey: "role").flatMap(Role.init(rawValue:)) }
        set { UserDefaults.standard.set(newValue?.rawValue, forKey: "role") }
    }

    var localURL: URL? { role.map { URL(string: "http://localhost:\($0.port)")! } }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        server.onLog = { [weak self] in self?.appendLog($0) }
        server.onState = { [weak self] in self?.render($0) }
        render(.stopped)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if role == nil { role = askRole(firstRun: true) }
        guard role != nil else { NSApp.terminate(nil); return }
        updateRoleMenu()
        startServer(openBrowser: true)
    }

    // Closing the window keeps the server running; click the Dock icon to bring it back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || !server.isRunning { return .terminateNow }
        checkActiveJob { [weak self] active in
            guard let self = self else { return }
            if let active = active {
                let a = NSAlert()
                a.alertStyle = .critical
                a.messageText = "A job is \(active)."
                a.informativeText = "Quitting stops the agent, which stops streaming to the machine mid-cut. Hold or stop the job first unless you mean to abandon it."
                a.addButton(withTitle: "Keep Running")
                a.addButton(withTitle: "Quit Anyway")
                if a.runModal() == .alertFirstButtonReturn {
                    NSApp.reply(toApplicationShouldTerminate: false)
                    return
                }
            }
            self.quitting = true
            self.server.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    /// Calls back with "running" or "paused" if the agent has a job in progress, nil otherwise.
    func checkActiveJob(_ done: @escaping (String?) -> Void) {
        guard let role = role, role != .hub,
              let url = URL(string: "http://localhost:\(role.port)/api/agent/state") else { return done(nil) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var status: String?
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let job = json["job"] as? [String: Any],
               let s = job["status"] as? String, ["running", "paused", "loading", "stopping"].contains(s) {
                status = s
            }
            DispatchQueue.main.async { done(status) }
        }.resume()
    }

    // MARK: actions

    func startServer(openBrowser: Bool) {
        guard let role = role else { return }
        guard let repo = Paths.repo() ?? chooseRepo() else {
            render(.failed("Choose the gcode-controller folder to continue (Server ▸ Choose Folder…)."))
            return
        }
        guard let node = Paths.node() else {
            render(.failed("Node.js wasn't found. Install Node 22 LTS from nodejs.org, then press Restart."))
            return
        }
        appendLog("— \(role.title) · \(repo.path) · \(node)\n")
        server.start(role: role, repo: repo, node: node) { [weak self] ok in
            if ok && openBrowser { self?.openInBrowser() }
        }
    }

    @objc func openInBrowser() {
        if let url = localURL { NSWorkspace.shared.open(url) }
    }

    @objc func restart() {
        server.stop { [weak self] in self?.startServer(openBrowser: false) }
    }

    @objc func changeRole(_ sender: NSMenuItem) {
        guard let new = sender.representedObject as? String, let r = Role(rawValue: new), r != role else { return }
        let apply = { [weak self] in
            guard let self = self else { return }
            self.role = r
            self.updateRoleMenu()
            self.server.stop { self.startServer(openBrowser: true) }
        }
        checkActiveJob { active in
            if active != nil {
                let a = NSAlert()
                a.messageText = "A job is \(active!)."
                a.informativeText = "Switching roles stops the agent. Finish or stop the job first."
                a.runModal()
                return
            }
            apply()
        }
    }

    @objc func chooseRepoAction() {
        if chooseRepo() != nil { restart() }
    }

    @objc func showWindow() { window.makeKeyAndOrderFront(nil) }

    @objc func clearLog() { logView.string = "" }

    @objc func revealData() {
        let dir = NSHomeDirectory() + "/Library/Application Support/GCodeController"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    func chooseRepo() -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Choose your gcode-controller folder (the one with Start Hub.command in it)."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/src")
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        guard Paths.isRepo(url.path) else {
            let a = NSAlert()
            a.messageText = "That isn't the gcode-controller folder."
            a.informativeText = "Pick the folder that contains packages/hub and Start Hub.command."
            a.runModal()
            return nil
        }
        UserDefaults.standard.set(url.path, forKey: "repoPath")
        return url
    }

    func askRole(firstRun: Bool) -> Role? {
        let a = NSAlert()
        a.messageText = firstRun ? "What does this Mac do?" : "Change role"
        a.informativeText = """
        Hub: the design Mac. Keeps the file library; Swarf and Fretboard Modeller send to it.
        Agent: the garage Mac plugged into the machine over USB.
        Simulator: an agent with a pretend machine, for testing.

        You can change this later from the Server menu.
        """
        for r in Role.allCases { a.addButton(withTitle: r.shortTitle) }
        switch a.runModal() {
        case .alertFirstButtonReturn: return .hub
        case .alertSecondButtonReturn: return .agent
        case .alertThirdButtonReturn: return .simulator
        default: return nil
        }
    }

    // MARK: UI

    func render(_ state: ServerState) {
        let gold = NSColor(srgbRed: 0.773, green: 0.627, blue: 0.349, alpha: 1)
        let color: NSColor
        let text: String
        switch state {
        case .stopped: color = .systemGray; text = "Stopped"
        case .preparing(let s): color = gold.withAlphaComponent(0.6); text = s
        case .starting: color = gold.withAlphaComponent(0.6); text = "Starting…"
        case .running: color = .systemGreen; text = "Running"
        case .failed(let s): color = .systemRed; text = s
        }
        dot.layer?.backgroundColor = color.cgColor
        statusLabel.stringValue = [role?.shortTitle, text].compactMap { $0 }.joined(separator: " · ")
        let url = localURL?.absoluteString ?? ""
        urlButton.title = state == .running ? url : ""
        openButton.isEnabled = state == .running
        window?.title = "GCode Controller" + (role.map { " — \($0.shortTitle)" } ?? "")
    }

    func appendLog(_ s: String) {
        guard let storage = logView.textStorage else { return }
        let atBottom = logView.visibleRect.maxY >= logView.bounds.maxY - 20
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor(srgbRed: 0.878, green: 0.878, blue: 0.878, alpha: 1),
        ]
        // Strip ANSI colour codes.
        let clean = s.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
        storage.append(NSAttributedString(string: clean, attributes: attrs))
        if storage.length > 400_000 { storage.deleteCharacters(in: NSRange(location: 0, length: storage.length - 300_000)) }
        if atBottom { logView.scrollToEndOfDocument(nil) }
    }

    func updateRoleMenu() {
        for (r, item) in roleItems { item.state = r == role ? .on : .off }
        render(server.state)
    }

    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 440),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.minSize = NSSize(width: 520, height: 280)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("main")
        if !window.setFrameUsingName("main") { window.center() }
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0.071, green: 0.071, blue: 0.071, alpha: 1)

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 6
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 12), dot.heightAnchor.constraint(equalToConstant: 12)])

        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        urlButton = NSButton(title: "", target: self, action: #selector(openInBrowser))
        urlButton.isBordered = false
        urlButton.contentTintColor = NSColor(srgbRed: 0.773, green: 0.627, blue: 0.349, alpha: 1)

        openButton = NSButton(title: "Open in Browser", target: self, action: #selector(openInBrowser))
        openButton.keyEquivalent = "\r"
        restartButton = NSButton(title: "Restart", target: self, action: #selector(restart))

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let top = NSStackView(views: [dot, statusLabel, urlButton, spacer, restartButton, openButton])
        top.orientation = .horizontal
        top.spacing = 10
        top.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)

        let scroll = NSTextView.scrollableTextView()
        logView = scroll.documentView as! NSTextView
        logView.isEditable = false
        logView.backgroundColor = NSColor(srgbRed: 0.118, green: 0.118, blue: 0.118, alpha: 1)
        logView.textContainerInset = NSSize(width: 8, height: 8)
        scroll.drawsBackground = false

        let root = NSStackView(views: [top, scroll])
        root.orientation = .vertical
        root.spacing = 0
        root.alignment = .leading
        top.translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            top.widthAnchor.constraint(equalTo: root.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: root.widthAnchor),
        ])
        window.contentView = root
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About GCode Controller", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide GCode Controller", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit GCode Controller", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let serverItem = NSMenuItem()
        let serverMenu = NSMenu(title: "Server")
        serverMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        serverMenu.addItem(withTitle: "Restart", action: #selector(restart), keyEquivalent: "r")
        serverMenu.addItem(.separator())
        let roleHeader = NSMenuItem(title: "This Mac is the…", action: nil, keyEquivalent: "")
        roleHeader.isEnabled = false
        serverMenu.addItem(roleHeader)
        for r in Role.allCases {
            let item = NSMenuItem(title: r.title, action: #selector(changeRole(_:)), keyEquivalent: "")
            item.representedObject = r.rawValue
            item.indentationLevel = 1
            roleItems[r] = item
            serverMenu.addItem(item)
        }
        serverMenu.addItem(.separator())
        serverMenu.addItem(withTitle: "Choose Folder…", action: #selector(chooseRepoAction), keyEquivalent: "")
        serverMenu.addItem(withTitle: "Show Data Folder", action: #selector(revealData), keyEquivalent: "")
        serverMenu.addItem(withTitle: "Clear Log", action: #selector(clearLog), keyEquivalent: "k")
        serverItem.submenu = serverMenu
        main.addItem(serverItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Status Window", action: #selector(showWindow), keyEquivalent: "1")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
