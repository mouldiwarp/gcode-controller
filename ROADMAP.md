# Roadmap

Status key: ✅ done · 🚧 in progress · ⬜ planned · 💡 idea

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold: monorepo, README, roadmap, CI | ✅ |
| 2 | Shared library and GRBL simulator | ✅ |
| 3 | Agent: serial streamer, machine state, job control | ✅ |
| 4 | Hub: library, upload API, inbox, Bonjour, sync | ✅ |
| 5 | Web UI: DRO, jog, zero, 3D progress, library, console, overrides, macros | ✅ |
| 6 | Sync hardening: restart mid-job, multi-browser tests, double-click launchers, setup guide | ✅ |
| 6b | Mac app launched from Spotlight (hub / agent / simulator roles; quitting stops the server) | ✅ |
| 7 | "Send to GRBL Controller" in Swarf and Fretboard Modeller | ✅ merged into main in both apps |
| 7b | Z probe with a touch plate; run a file group in order with bit-change stops | ✅ (simulator-tested; check on the machine) |
| 7c | Library manager: project folders in `~/Documents/GCode Controller`, kept in step with Finder | ✅ |
| 7d | Version checks: an out-of-date agent is held until it's updated, with Update now | ✅ |
| 7e | Spoilboard surfacing: zero at the left edge on the centre line, ramp-in zigzag skim | ✅ (simulator-tested) |
| 8 | Real machine bring-up (FoxAlien XE-Pro Ultra) | ✅ homing, probing, spindle and surfacing on the machine |
| 9 | **1.0** (tag `v1.0`): pause/resume, time-based progress, travel limits, start-up settings check | ✅ |

## 2.0: one native Swift app

1.0 stays in service until 2.0 matches it. The 2.0 app is a single app that asks on first launch
whether this Mac is the hub or the agent. Either Mac can drive the FoxAlien over USB, and the
library is kept fully in sync on both Macs, with conflicts resolved by asking. There's no browser.
The code is in `swift/`. Try the machine layer from the command line:

```sh
cd swift
swift run gcc ports                                   # serial ports (* = looks like GRBL)
swift run gcc stream --simulate ../samples/test-square.nc
swift run gcc stream ../samples/test-square.nc        # USB, port auto-detected (or --port PATH)
```

`gcc stream` prints the console and progress, and Ctrl-C stops the job (feed hold, then reset).

| Phase | What | Status |
|---|---|---|
| 1 | Core: G-code, GRBL protocol, state and commands, resume, progress, travel, surfacing, settings check (ported and checked identical to 1.0) | ✅ |
| 2 | Machine: serial port, simulator, streaming session (1.0's controller tests all ported), `gcc` command-line streamer. Real-machine air cut with `gcc stream` still to do | ✅ |
| 3 | Library on disk: content blobs, SQLite with a per-field change log, Finder folder kept in step both ways (moves keep their id), 5 versions / 30 days of history, a 30-day Trash, 1.0 import | ✅ |
| 4 | Network and sync: hub API (Swarf/Fretboard unchanged), Bonjour, inbox, link between the Macs with either-Mac machine ownership and command relay, library sync and conflicts (log compaction deferred) | ✅ |
| 5 | App shell: role picker, main window, panels, library UI with conflicts | ⬜ |
| 6 | Metal 3D view and every dialog | ⬜ |
| 7 | Build, install and self-update | ⬜ |
| 8 | Cut-over on both Macs, real-machine checks, tag v2.0 | ⬜ |
| 9 | Later: signed, notarized DMG | 💡 |

## Next up

### Machine bring-up (when the machine arrives)
- ⬜ Confirm the firmware with `$I` (GRBL 1.1 or a FoxAlien variant) and the RX buffer size it reports.
- ⬜ Read `$$` and set the machine travel from `$130`–`$132` (there's a **Read from GRBL** button in Settings).
- ⬜ Confirm the homing corner (`$23`) and draw the envelope in the right place. Today the envelope assumes
  GRBL's default (machine 0,0,0 at back-right-top).
- ⬜ Check spindle control: `M3 S…` against `$30`/`$31` with the 1.5 kW VFD.
- ⬜ Test Probe Z on the real plate: the probe pin (`Pn:P`) lights when the plate touches the bit, and a
  probe that misses raises ALARM 5.
- ⬜ First air cut of `samples/test-square.nc` with Z zeroed 20 mm above the stock.

### Workflow features (from UGS and WorkBee)
- ✅ **Progress by time, not lines.** The % and time left follow the line the machine is cutting (not the
  lines GRBL has queued), weighted by each line's estimated time and how far along it the tool is.
- ✅ **Z probe with a touch plate** (`G38.2`): a fast touch then a slow one, with plate thickness in Settings.
- ✅ **Run a job group in order**, stopping for a bit change and a Z re-probe between files.
- ⬜ Probe X/Y corners with the touch plate (corner-finding), as WorkBee's XYZ probe block does.
- ⬜ Remember the probe result per group, and warn on Start next if Z wasn't re-probed after the bit change.
- ⬜ **Continuous jog:** hold a button or key to jog, release to stop (`$J=` plus jog cancel).
- ✅ **Resume from line N** after a stop, with a safe preamble (modes, safe Z, XY, spindle on and spin-up, then down). Defaults to the line the cutter was on. Spindle stop/start while paused.
- ⬜ **Check mode** (`$C`) dry run, which streams the file through GRBL's parser without moving, to catch
  errors before cutting.
- ⬜ **Block a start** when the toolpath goes outside the machine travel. Today the UI only warns.
- ⬜ **Settings editor:** change `$` settings from the table instead of typing them in the console.

### Visualizer
- ⬜ Track the executing line exactly by adding `N` line numbers and reading `Ln:` from status reports.
  Today it's estimated from acknowledged lines minus the planner queue.
- ⬜ Depth-aware drawing. Later passes over the same XY at a lower Z draw over cut segments, which hides
  some of the gold. Draw finished segments on top, or add a "hide below current Z" slider.
- ⬜ Parse large files (3D finishing passes run to 1M+ lines) in a Web Worker so the UI never stutters.
- 💡 Stock box and simulated material removal, like Swarf's simulation.

### Comfort and safety
- ⬜ Browser notification and sound when a job finishes, pauses on an error or alarms.
- ⬜ Touch-friendly "garage mode": bigger buttons, full screen, wake lock so the display stays on.
- ⬜ Job history: what ran, when, how long, who started it, and how it ended.
- ⬜ Warn when hub and agent versions differ.
- ⬜ Replace the browser's delete confirmation with an in-app dialog.
- 💡 Optional PIN for starting jobs, in case other people use the home network.
- 💡 Webcam view of the machine in the UI.
- 💡 Height-map probing and auto-levelling for engraving on uneven stock.

### Engineering
- ⬜ Playwright end-to-end test with two real browsers. Today the same flows are covered by WebSocket
  integration tests and were checked by hand in Chrome.
- ⬜ Package the hub and agent as a single download (Node runtime included), so the garage Mac doesn't
  need Node installed.
- ⬜ Show machine and job status in the Mac app's window and Dock icon (progress badge, alarm colour).
- 💡 Bonjour discovery in the Swift apps, if the hub ever moves off the design Mac.
