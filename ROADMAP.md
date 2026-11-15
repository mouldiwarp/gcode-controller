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
| 8 | Real machine bring-up (FoxAlien XE-Pro Ultra) | ⬜ waiting for the machine |

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
- ✅ **Z probe with a touch plate** (`G38.2`): a fast touch then a slow one, with plate thickness in Settings.
- ✅ **Run a job group in order**, stopping for a bit change and a Z re-probe between files.
- ⬜ Probe X/Y corners with the touch plate (corner-finding), as WorkBee's XYZ probe block does.
- ⬜ Remember the probe result per group, and warn on Start next if Z wasn't re-probed after the bit change.
- ⬜ **Continuous jog:** hold a button or key to jog, release to stop (`$J=` plus jog cancel).
- ⬜ **Resume from line N** after a stop, with a safe preamble (spindle on, move to safe Z, then XY, then down).
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
