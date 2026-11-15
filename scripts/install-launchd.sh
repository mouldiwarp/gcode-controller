#!/bin/zsh
# Start the hub or agent at login, and restart it if it stops.
#
#   scripts/install-launchd.sh hub                     # design Mac
#   scripts/install-launchd.sh agent                   # machine Mac
#   scripts/install-launchd.sh agent --simulate        # machine Mac, no machine yet
#   scripts/install-launchd.sh uninstall hub|agent
#
# Logs go to ~/Library/Logs/GCodeController/<role>.log

set -euo pipefail

if [[ "${1:-}" == "uninstall" ]]; then
  role="${2:?usage: install-launchd.sh uninstall hub|agent}"
  plist="$HOME/Library/LaunchAgents/com.gcodecontroller.$role.plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed $role login item."
  exit 0
fi

role="${1:?usage: install-launchd.sh hub|agent [extra args]}"
shift
[[ "$role" == "hub" || "$role" == "agent" ]] || { echo "role must be hub or agent"; exit 1; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || { echo "Node.js not found. Install Node 22 LTS from nodejs.org first."; exit 1; }
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || { echo "Node $node_major found; Node 22 or newer is required."; exit 1; }

echo "Building the web UI…"
(cd "$repo" && npm run build:web >/dev/null)

logdir="$HOME/Library/Logs/GCodeController"
mkdir -p "$logdir" "$HOME/Library/LaunchAgents"
plist="$HOME/Library/LaunchAgents/com.gcodecontroller.$role.plist"

args_xml=""
for a in "$@"; do args_xml+="    <string>${a}</string>"$'\n'; done

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gcodecontroller.$role</string>
  <key>WorkingDirectory</key>
  <string>$repo</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$repo/node_modules/tsx/dist/cli.mjs</string>
    <string>$repo/packages/$role/src/main.ts</string>
$args_xml  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$node_bin"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$logdir/$role.log</string>
  <key>StandardErrorPath</key>
  <string>$logdir/$role.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed: the $role starts at login. Log: $logdir/$role.log"
[[ "$role" == "hub" ]] && echo "Open http://localhost:8080" || echo "Open http://localhost:8081"
