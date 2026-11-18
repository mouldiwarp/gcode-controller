# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

KerfLine is a native macOS GRBL sender (Swift 6.2, macOS 26, SwiftUI + Metal) for a FoxAlien XE-Ultra CNC. The same app
runs on two Macs: a **Hub** (design Mac) and an **Agent** (garage Mac next to the machine). It moves a real machine with a
spinning cutter, so treat streaming, travel checks, hold/stop and resume logic as safety-critical.

## Commands

All Swift code is one package in `swift/`.

```sh
scripts/ci.sh                    # what GitHub CI runs (swift test), in a clean worktree of HEAD — use this instead of waiting on CI
CI_DIRTY=1 scripts/ci.sh         # same, against the working tree (faster; misses uncommitted files)
cd swift && swift test           # all tests
swift test --filter GCCCoreTests                      # one test target
swift test --filter "GCCLibraryTests.SyncTests"       # one suite (swift-testing; filter by suite/test name)
swift run GCodeController        # run the app without installing
swift run gcc ports              # list serial ports (* = looks like GRBL)
swift run gcc stream --simulate ../samples/test-square.nc   # stream to the built-in GRBL simulator
scripts/build-app.sh             # release build, ad-hoc sign, install to ~/Applications
```

By default `scripts/ci.sh` tests `HEAD`, so commit before relying on it.

Tests use **swift-testing** (`import Testing`, `@Suite`, `@Test`, `#expect`), not XCTest.
`GCC_SNAPSHOT_DIR=<dir>` makes `DialogSnapshotTests` write each dialog as a PNG for checking layout offscreen.

### Dev runs beside the installed app

`GCC_HOME=<folder> swift run GCodeController` puts the saved setup, library, data and inbox under that folder, on port
8090 and Bonjour `_gcodehub-dev._tcp`, so it doesn't touch the real install (`GCCUI/Setup.swift`). Only in that mode:
`GCC_SELECT=<file name>` / `GCC_OPEN=probe|resume|surfacing|settings|start` open a dialog at launch, and a distributed
notification `gcc.dev.show` opens dialogs/sheets from a script (see `DevShow` in `GCCUI/App.swift`).

## Architecture

Module layering (each depends only on those above it; see `swift/Package.swift`):

- **GCCCore** — pure Swift, no I/O. G-code parsing, GRBL protocol/replies, the shared `AppState`/`Command` types
  (`Protocol.swift`, JSON shapes kept compatible with 1.0's saved data), resume-from-line, progress/time estimates,
  travel-limit checks, surfacing program generation, and the expected-`$$` settings check (`MachineCheck.swift`).
- **GCCMachine** — `Transport` (USB `SerialPort` or `FakeGrbl` simulator) and `MachineSession`, an actor that streams
  jobs with GRBL's character-counting protocol (unacked bytes never exceed the RX buffer) and emits `SessionEvent`s.
- **GCCLibrary** — the library on disk: content-addressed `BlobStore`, SQLite with a per-field change log, the Finder
  folder (`~/Documents/GCode Controller`) kept in step both ways by `WorkingCopy`/`FolderWatcher`, history, Trash,
  1.0 import. `Sync.swift` holds the sync rules: version vectors, stamps with a base; conflicting `path`/`content`
  edits become user-resolved conflicts, most other fields are newest-wins.
- **GCCNet** — `Instance` is the whole running app minus the window. Hub: Hummingbird HTTP API (`POST /api/jobs` for
  Swarf/Fretboard, localhost-only `POST /api/command`), Bonjour `_gcodehub._tcp`, inbox watcher, and the `/link`
  WebSocket. Agent: dials the hub's `/link` (Bonjour or explicit URL) and keeps redialling. `LinkMessage.swift` defines
  the link protocol (`hello`, `snapshot`, `cmd`/`result`, `toast`, `sync`; bump `linkProtocolVersion` on breaking changes).
- **GCCUI** — `AppModel` (window state; every button goes through `run(Command)`, refusals become toasts), SwiftUI
  panels and `Dialogs/`, the Metal toolpath view in `Viz/`, and `Updater` (self-update from the git checkout).
- Executables: `GCodeController` (the app, just calls `GCodeControllerApp.main()`) and `gcc` (headless CLI sender).

Key behaviours that span modules:

- **Machine ownership**: whichever Mac has the controller on USB owns it and is authoritative for machine/job/console
  state; the other mirrors snapshots and relays commands over the link. Either role (hub or agent) can own it.
- **Jobs stream from the owning Mac's own copy** of the library, never over the network, so Wi-Fi drops can't starve
  the machine. File groups are copied over before the first file starts.
- **Both Macs hold a full library replica**; `LibrarySync` exchanges change logs whenever linked.
- **Self-update**: `build-app.sh` bakes `GCCRepoPath`/`GCCCommit`/`GCCCommitTime` into Info.plist; the app pulls and
  rebuilds that checkout, refuses if it's dirty, and never updates while a job runs on that Mac.

## Naming in transition

The product name is **KerfLine** (repo `mouldiwarp/kerfline`, UI text), but the Swift package, modules (`GCC*`),
installed app name ("GCode Controller 2.0"), bundle id, library folder, `gcc.*` defaults keys and Bonjour types keep the
old GCode Controller names on purpose: they change together with Developer ID signing (ROADMAP phase 9) so macOS
permissions reset only once. Don't rename them piecemeal.

## Docs

`README.md` is user-facing and documents behaviour in detail (start-up `$$` checks, travel limits, resume, probing,
surfacing); keep it in sync when behaviour changes. `ROADMAP.md` tracks phases and pending machine bring-up checks.
`docs/SETUP.md` is the two-Mac walkthrough. Version 1.0 (Node.js + browser UI) lives only at tag `v1.0`.
