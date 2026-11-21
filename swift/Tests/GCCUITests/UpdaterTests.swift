import Foundation
import GCCCore
import Testing

@testable import GCCUI

/// An origin repository and a checkout of it, as on each Mac.
private struct Repos {
    let dir = FileManager.default.temporaryDirectory.appending(path: "gcc-updater-tests/\(UUID().uuidString)")
    var origin: URL { dir.appending(path: "origin.git") }
    var mac: URL { dir.appending(path: "mac") }
    var dev: URL { dir.appending(path: "dev") }

    init() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try sh("git init --quiet --bare -b main origin.git", in: dir)
        try sh("git clone --quiet origin.git dev", in: dir)
        try commit("first", in: dev)
        try sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: dev)
        try sh("git clone --quiet origin.git mac", in: dir)
    }

    func commit(_ message: String, in repo: URL) throws {
        try sh("echo '\(message)' >> notes.txt && git add notes.txt && git -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@t commit --no-verify --quiet -m '\(message)'", in: repo)
    }

    func head(_ repo: URL) throws -> String { try sh("git rev-parse HEAD", in: repo).trimmed }

    @discardableResult
    func sh(_ cmd: String, in dir: URL) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", cmd]
        p.currentDirectoryURL = dir
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        if p.terminationStatus != 0 { throw UpdateError("\(cmd): \(text)") }
        return text
    }
}

private actor Steps {
    var all: [String] = []
    func add(_ s: String) { all.append(s) }
}

struct UpdaterTests {
    @Test func aCheckCountsTheCommitsThisBuildDoesntHave() async throws {
        let r = try Repos()
        let built = try r.head(r.mac)
        let u = Updater(repo: r.mac, built: built, build: ["/usr/bin/true"])
        #expect(try await u.check() == UpdateCheck(behind: 0, latest: nil, changes: []))

        try r.commit("Fix the probe retract", in: r.dev)
        try r.commit("Faster jogging", in: r.dev)
        try r.sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: r.dev)
        let c = try await u.check()
        #expect(c.behind == 2)
        #expect(c.changes == ["Faster jogging", "Fix the probe retract"])
        #expect(c.latest?.commit == (try r.head(r.dev)))
        #expect(c.latest?.time != nil)
    }

    @Test func aPullWithoutARebuildStillCountsAsBehind() async throws {
        let r = try Repos()
        let built = try r.head(r.mac)
        try r.commit("Newer", in: r.dev)
        try r.sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: r.dev)
        try r.sh("git pull --quiet --ff-only", in: r.mac)
        // The checkout is up to date, but this build isn't.
        let c = try await Updater(repo: r.mac, built: built, build: ["/usr/bin/true"]).check()
        #expect(c.behind == 1)
        // A dev run (no stamped commit) compares with the checkout.
        #expect(try await Updater(repo: r.mac, built: nil, build: ["/usr/bin/true"]).check().behind == 0)
    }

    @Test func updatePullsThenBuilds() async throws {
        let r = try Repos()
        try r.commit("Newer", in: r.dev)
        try r.sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: r.dev)
        let marker = r.dir.appending(path: "built")
        let u = Updater(repo: r.mac, built: nil, build: ["/usr/bin/touch", marker.path])
        let steps = Steps()
        try await u.update { await steps.add($0) }
        #expect(try r.head(r.mac) == (try r.head(r.dev)))
        #expect(FileManager.default.fileExists(atPath: marker.path))
        #expect(await steps.all.count == 2)
    }

    /// The other Mac runs code that's committed there but not pushed: the pull brings nothing new, so don't rebuild
    /// and restart on the same code (it would come straight back asking to update).
    @Test func nothingNewOnGitHubMeansNoRebuild() async throws {
        let r = try Repos()
        let built = try r.head(r.mac)
        let marker = r.dir.appending(path: "built")
        let u = Updater(repo: r.mac, built: built, build: ["/usr/bin/touch", marker.path])
        #expect(try await u.update { _ in } == false)
        #expect(!FileManager.default.fileExists(atPath: marker.path))

        try r.commit("Pushed", in: r.dev)
        try r.sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: r.dev)
        #expect(try await u.update { _ in } == true)
        #expect(FileManager.default.fileExists(atPath: marker.path))
    }

    @Test func aCommitOnlyHereIsntPublished() async throws {
        let r = try Repos()
        let u = Updater(repo: r.dev, built: nil, build: ["/usr/bin/true"])
        #expect(await u.isPublished(try r.head(r.dev)))
        try r.commit("Not pushed", in: r.dev)
        #expect(!(await u.isPublished(try r.head(r.dev))))
        try r.sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: r.dev)
        #expect(await u.isPublished(try r.head(r.dev)))
        #expect(!(await u.isPublished("0123456789abcdef0123456789abcdef01234567")))
    }

    @Test func aPullThatCantFastForwardChangesNothing() async throws {
        let r = try Repos()
        try r.commit("On GitHub", in: r.dev)
        try r.sh("git -c core.hooksPath=/dev/null push --no-verify --quiet origin main", in: r.dev)
        try r.commit("Local edit", in: r.mac)
        let before = try r.head(r.mac)
        let marker = r.dir.appending(path: "built")
        let u = Updater(repo: r.mac, built: nil, build: ["/usr/bin/touch", marker.path])
        await #expect(throws: UpdateError.self) { try await u.update { _ in } }
        #expect(try r.head(r.mac) == before)
        #expect(!FileManager.default.fileExists(atPath: marker.path))
    }

    @Test func aFailedBuildReportsItsOutput() async throws {
        let r = try Repos()
        let u = Updater(repo: r.mac, built: nil, build: ["/bin/sh", "-c", "echo 'error: no such module'; exit 1"])
        do {
            try await u.update { _ in }
            Issue.record("expected the build to fail")
        } catch let e as UpdateError {
            #expect(e.message.contains("The build failed"))
            #expect(e.message.contains("error: no such module"))
        }
    }

    @Test func aDevRunCantUpdateItself() {
        let dev = BuildInfo(code: CodeVersion(version: "2.0.0"), repo: URL(fileURLWithPath: "/tmp"), bundle: nil)
        #expect(!dev.canUpdate)
        let app = BuildInfo(code: CodeVersion(version: "2.0.0"), repo: URL(fileURLWithPath: "/tmp"), bundle: URL(fileURLWithPath: "/Applications/X.app"))
        #expect(app.canUpdate)
    }

    @Test @MainActor func keepAwakeTogglesItsAssertion() {
        let k = KeepAwake()
        #expect(k.set(true))
        #expect(k.isOn)
        #expect(!k.set(true))
        #expect(k.set(false))
        #expect(!k.isOn)
    }
}

struct DefaultsMigrationTests {
    @Test func kerfLineTakesOverGCodeControllersSettingsOnce() throws {
        let old = "gcc-tests.old.\(UUID().uuidString)"
        let newSuite = "gcc-tests.new.\(UUID().uuidString)"
        defer {
            UserDefaults.standard.removePersistentDomain(forName: old)
            UserDefaults.standard.removePersistentDomain(forName: newSuite)
        }
        let setup = try JSONEncoder().encode(AppSetup(role: .agent, name: "Garage", machine: .none))
        UserDefaults.standard.setPersistentDomain(["gcc.setup": setup, "gcc.jogStep": 10.0, "NSWindow Frame main": "x"], forName: old)
        let new = try #require(UserDefaults(suiteName: newSuite))

        #expect(AppSetup.migrateDefaults(from: old, to: new))
        #expect(AppSetup.load(new)?.name == "Garage")
        #expect(new.double(forKey: "gcc.jogStep") == 10)
        #expect(new.object(forKey: "NSWindow Frame main") == nil)
        // Once it has its own setup, it's left alone.
        #expect(!AppSetup.migrateDefaults(from: old, to: new))
    }
}
