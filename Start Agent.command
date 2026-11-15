#!/bin/zsh
# Double-click in Finder to start the agent on the Mac connected to the machine.
# It runs until you close this Terminal window (or press Ctrl-C).
#
# Until the machine arrives, use "Start Agent (Simulator).command" instead.
cd "$(dirname "$0")"
[[ -d node_modules ]] || npm install
npm run build:web >/dev/null || exit 1
(sleep 3 && open "http://localhost:8081") &
exec npx tsx packages/agent/src/main.ts "$@"
