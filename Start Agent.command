#!/bin/zsh
# Double-click in Finder to start the agent on the Mac connected to the machine.
# It runs until you close this Terminal window (or press Ctrl-C).
#
# Until the machine arrives, use "Start Agent (Simulator).command" instead.
cd "$(dirname "$0")"
[[ -d node_modules ]] || npm install
npm run build:web >/dev/null || exit 1
(sleep 3 && open "http://localhost:8081") &
# Exit code 75 means "updated, start me again" (Update now in the UI).
export GCC_SUPERVISED=1
while true; do
  npx tsx packages/agent/src/main.ts "$@"
  [[ $? -eq 75 ]] || break
  echo "\nUpdated. Restarting the agent…\n"
done
