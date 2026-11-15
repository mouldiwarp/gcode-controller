# GCode Controller

**A networked GRBL sender for hobby CNC.** Design on one Mac, run the machine from another, and watch
the same job live on both. It is built for a FoxAlien XE-Ultra (GRBL 1.1 over USB) and works with any
GRBL 1.1, grblHAL or FluidNC machine that talks the standard serial protocol.

> [!WARNING]
> **This is experimental software that moves a machine with a spinning cutter. You use it at your
> own risk.** Keep a hardware emergency stop within reach. Air-cut new jobs with Z zeroed above the
> stock, and never leave a running machine unattended. Provided under the MIT License **without
> warranty of any kind**.

![A job running on the simulator, viewed from the machine-side browser](docs/screenshot-running.jpg)

## How it fits together

```
 Swarf / Fretboard ──HTTP POST──▶ ┌──────────── HUB (design Mac :8080) ────────────┐
 Browser upload ─────────────────▶│ file library · macros · state fan-out · UI      │◀── Browser (indoors)
                                  └───────────────▲─────────────────────────────────┘
                                                  │ WebSocket (agent dials out, reconnects, finds hub via Bonjour)
                                  ┌───────────────┴──── AGENT (garage Mac :8081) ───┐
 Browser (garage, localhost) ────▶│ GRBL streamer · machine state · same UI          │
                                  │ USB serial  |  built-in GRBL simulator           │
                                  └───────────────┬─────────────────────────────────┘
                                                  │ USB 115200 baud
                                              CNC machine (GRBL 1.1)
```

- **Hub** (design Mac): stores your G-code files and macros, serves the web UI, and relays live state to every browser.
- **Agent** (Mac next to the machine): owns the USB port. **It copies the whole file before a job starts and streams
  it to GRBL itself**, so a Wi-Fi dropout can't starve the machine mid-cut. It serves the same UI, so the browser next
  to the machine keeps hold, stop, jog and zero even if the design Mac is asleep.
- **Browsers**: any number. They all show the same machine position, job progress (3D and %), console and library.
  A job can be started, paused or stopped from any of them.

## Getting started

Both Macs need **Node.js 22 LTS** (from [nodejs.org](https://nodejs.org); it supports macOS 11 Big Sur and later).

```sh
git clone https://github.com/mouldiwarp/gcode-controller.git
cd gcode-controller
npm install
```

### Design Mac: run the hub

```sh
npm run hub
```

Open <http://localhost:8080>. On the same network the hub is also at `http://<this-mac-name>.local:8080`.

### Machine Mac: run the agent

Without a machine (built-in GRBL simulator):

```sh
npm run agent -- --simulate
```

With the machine plugged in over USB (the port is found automatically, including the CH340 as
`/dev/cu.wchusbserial*` with the CH341SER driver or `/dev/cu.usbserial-*` without it):

```sh
npm run agent
```

Open <http://localhost:8081> on the machine Mac. The agent finds the hub over Bonjour. To point it at a hub
yourself, pass `--hub http://design-mac.local:8080`.

See **[docs/SETUP.md](docs/SETUP.md)** for the full two-Mac walkthrough, including testing the sync with the
simulator before the machine arrives.

### The Mac app (launch from Spotlight)

Build it once on each Mac:

```sh
scripts/build-mac-app.sh
```

This compiles **GCode Controller.app** for that Mac and installs it in `~/Applications`, where Spotlight
finds it. Press ⌘Space and type "GCode". It needs the Command Line Tools (`xcode-select --install`),
which git already uses, and Node 22 or later.

- **First launch** asks what the Mac does: **Hub**, **Agent**, or **Agent with simulator**. Change it later
  from the **Server** menu.
- **Launching** builds the web UI if it's out of date, starts the server and opens the controller in your browser.
  The app window shows status, the address, **Open in Browser**, **Restart** and the server log.
- **Quitting** (⌘Q) stops the server. On the agent, it warns you first if a job is running. Even a force quit
  stops the server, so the USB port is never left open.
- **Closing the window** keeps the server running. Click the Dock icon to bring the window back.
- **Local network prompt:** the first time it runs, macOS asks to let GCode Controller find devices on local
  networks. Click **Allow**, or the agent can't reach the hub. To change it later, go to System Settings ▸ Privacy &
  Security ▸ Local Network.
- The app runs the code in this checkout. After a `git pull`, just relaunch. If you move the folder, use
  **Server ▸ Choose Folder…**. Rerun the build script only when `mac/` changes.

Nothing starts at login.

### Launching by double-click

To launch without the app, double-click:

- **`Start Hub.command`** on the design Mac
- **`Start Agent.command`** on the machine Mac, or **`Start Agent (Simulator).command`** to test without the machine

Each opens a Terminal window, starts the server and opens the UI in your browser. Close the window to stop it.

## The library

Your G-code lives in ordinary folders under **`~/Documents/GCode Controller`** on the design Mac, one folder per
project. Swarf groups (one file per tool, side A / side B) arrive in a folder named after the group; single files land
at the top level. Re-sending a file with the same name replaces it, and the old copy goes to the Trash.

- **Library panel**: a folder tree beside the job controls. Drop files on a folder to upload into it.
- **Manage** opens the library manager: make, rename and delete folders, rename files, and move files with the
  **Move to** menu or by dragging them onto a folder. Deleted files and folders go to the macOS Trash.
- **Finder** works too: add, move, rename or delete files and folders there, and the library follows within a few
  seconds. Moved files keep their history.

Use `--library <dir>` to keep the library somewhere else. The first time the hub starts with the folder library, it
copies files from the old flat store in Application Support into the folders (the originals are kept as a backup).

## Sending G-code

- **Drag and drop** files onto the Library panel (or onto a folder in it), or click **Upload**.
- **Drop files in `~/GCode Inbox`** on the design Mac. The hub imports them and moves them into `~/GCode Inbox/imported`.
- **From an app or script**, POST the file to the hub:

  ```sh
  curl -X POST --data-binary @part.nc \
       -H 'X-Filename: part.nc' -H 'X-Source: Swarf' \
       http://design-mac.local:8080/api/jobs
  ```

  Optional headers: `X-Group` (a name that groups related files, such as side A and side B) and `X-Group-Index`
  (their order). The hub advertises itself over Bonjour as `_gcodehub._tcp`.

## The UI

| Area | What's there |
|---|---|
| Top bar | Hub, agent and machine status, who sent the last command, Home, Unlock, and big Hold / Stop buttons |
| Left | Position readout (work and machine), zero per axis, zero XY / Z, go to zero, **Probe Z** with a touch plate, jog pad with step and feed presets (arrow keys and Page Up / Down also jog) |
| Centre | 3D toolpath: remaining cuts in steel, finished cuts in gold, live tool position, work zero and machine envelope. Progress bar with %, line count, elapsed time and time left |
| Right | Job controls (including running a file group in order, with a bit-change stop between files) and feed / spindle / rapid overrides, the file library, console with manual G-code entry, and macros |

## Probing Z and running file groups

**Probe Z** (under the position readout) sets work Z with a touch plate, as WorkBee Control did:

1. Measure the plate with calipers and enter its thickness in **Settings ▸ Touch plate**. Probing is
   refused until you do.
2. Jog the bit within 25 mm of the plate (the search distance can be changed in Settings), put the plate on the stock
   under it and clip the lead to the bit. The dialog shows the probe input live, so you can test the circuit first.
3. Press **Probe**. The bit touches down fast, lifts 2 mm and touches again slowly. Z0 is then set to the stock surface
   and the bit lifts clear. If nothing is touched, GRBL stops with ALARM 5 and nothing is changed.

**File groups.** Swarf sends one file per tool (and side A / side B) as a group. When you start a grouped file, the
start dialog offers to run the rest of the group in order. After each file the spindle is turned off and the job
waits in **Bit change**: fit the next bit, re-probe Z, then press **Start next** (or **End group** to stop there). All
the files are copied to the machine Mac before the first one starts, so a Wi-Fi dropout can't strand the group.

## Development

```sh
npm test            # unit + integration tests (simulator-backed)
npm run typecheck
npm run dev:web     # Vite dev server for the UI on :5173 (proxies to a hub on :8080)
```

Packages: `packages/shared` (protocol, G-code parser, GRBL parser), `packages/agent` (serial streamer and
simulator), `packages/hub` (library and sync server), `packages/web` (React + three.js UI).

See [ROADMAP.md](ROADMAP.md) for what's planned.

## License

MIT
