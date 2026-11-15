# Roadmap

Status key: ✅ done · 🚧 in progress · ⬜ planned · 💡 idea

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold: monorepo, README, roadmap, CI | ✅ |
| 2 | Shared library and GRBL simulator | ✅ |
| 3 | Agent: serial streamer, machine state, job control | ✅ |
| 4 | Hub: library, upload API, inbox, Bonjour, sync | ✅ |
| 5 | Web UI: DRO, jog, zero, 3D progress, library, console, overrides, macros | ⬜ |
| 6 | Sync hardening: restart mid-job, multi-browser tests | ⬜ |
| 7 | "Send to GRBL Controller" in Swarf and Fretboard Modeller | ⬜ |
| 8 | Real machine bring-up (FoxAlien XE-Ultra) | ⬜ |

## Backlog

### Machine bring-up (when the XE-Ultra arrives)
- ⬜ Confirm the firmware with `$I` (GRBL 1.1 vs a FoxAlien variant) and the RX buffer size.
- ⬜ Read `$$` and set the machine envelope from `$130`–`$132` automatically.
- ⬜ Confirm the homing corner and direction (`$23`) and draw the envelope in the right place.
- ⬜ First air cut with Z zeroed 20 mm above the stock.
