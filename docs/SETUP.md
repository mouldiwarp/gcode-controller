# Setting up two Macs

This walks through the setup this project was built for: a **design Mac** indoors running the hub, and an
older **machine Mac** in the garage plugged into the CNC over USB. Until the machine arrives, the garage Mac
runs the built-in GRBL simulator, so you can test the whole loop between the two Macs.

Both Macs must be on the same Wi-Fi or LAN.

## 1. Both Macs: install Node.js and the app

1. Install **Node.js 22 LTS** from <https://nodejs.org> (the macOS installer). Node 22 supports macOS 11
   Big Sur and later, so it runs on a 2016-era Mac on Monterey. Node 24 needs macOS 13.5, so stay on 22
   for the garage Mac.
2. In Terminal:

   ```sh
   git clone https://github.com/mouldiwarp/gcode-controller.git
   cd gcode-controller
   npm install
   ```

## 2. Design Mac: run the hub

```sh
npm run hub
```

The first time, macOS asks whether `node` may accept incoming network connections. Click **Allow**,
or the garage Mac can't reach the hub.

The hub prints its addresses, for example:

```
  UI:      http://localhost:8080
           http://192.168.1.20:8080
```

Or double-click **`Start Hub.command`** in the project folder. It opens a Terminal window and the UI. Close the window to stop the hub.

## 3. Garage Mac: run the agent

### Before the machine arrives (simulator)

```sh
npm run agent -- --simulate
```

The agent finds the hub over Bonjour. If it doesn't (some routers block multicast), point it at the hub:

```sh
npm run agent -- --simulate --hub http://192.168.1.20:8080
```

Add `--sim-speed 5` to make simulated jobs run five times faster.

### With the machine

1. The FoxAlien controller uses a **CH340** USB-serial chip. The **CH341SER** driver from WCH is already
   installed on the garage Mac. With it, the machine appears as `/dev/cu.wchusbserial…`. Monterey's
   built-in driver names it `/dev/cu.usbserial-…`. The agent recognises both.
2. Plug in the machine, power it on, and check that it's found:

   ```sh
   npm run agent -- --list-ports
   ```

   The likely GRBL port is marked with `*`.
3. Run the agent without `--simulate`:

   ```sh
   npm run agent
   ```

   If more than one port is marked, choose one with `--serial /dev/cu.wchusbserial110` (use your port's name).

Or double-click **`Start Agent.command`** (or **`Start Agent (Simulator).command`** while testing). Close its Terminal window to stop the agent.

## 4. Open the UI

- **Garage Mac:** open <http://localhost:8081>. This page talks to the agent directly, so hold, stop,
  jog and zero keep working even if the design Mac is asleep.
- **Design Mac:** open <http://localhost:8080>.

Each browser asks for nothing. It names itself **Studio** (hub) or **Garage** (agent), and you can change
the name in Settings (gear icon). The name appears next to every command in the console and as
"started by …" on a job.

## 5. Test the sync

1. On the design Mac, drag `samples/demo-body.nc` onto the Library panel.
2. It appears in the garage library within a second.
3. In the garage, click **Unlock** (the simulator starts locked, like GRBL with homing enabled), jog to the
   middle of the bed, and click **Zero all**.
4. Start the job from either Mac. Both show the same gold progress in 3D and the same %.
5. Pause from one Mac and resume from the other.
6. Quit the hub on the design Mac (Ctrl-C) while the job runs. The garage keeps cutting and shows
   "Hub offline". Start the hub again and the design Mac catches up.

## Troubleshooting

| Problem | Fix |
|---|---|
| Garage says "Hub offline" | Check the hub is running. Try `--hub http://<design-mac-ip>:8080`. Allow `node` in System Settings → Network → Firewall. |
| "No USB GRBL controller found" | Run `--list-ports`. Check the cable (some are charge-only) and that the machine's controller is powered. |
| Machine shows **ALARM** at start | Normal for GRBL with homing enabled. Click **Home** (or **Unlock** if you know the position is safe). |
| Toolpath drawn outside the envelope | Set the machine travel in Settings, or click **Read from GRBL** to use `$130`–`$132`. |
