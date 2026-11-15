#!/bin/zsh
# Double-click to start the agent with the built-in GRBL simulator instead of USB,
# for testing the two-Mac setup before the machine arrives.
cd "$(dirname "$0")"
exec "./Start Agent.command" --simulate "$@"
