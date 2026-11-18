#!/bin/bash
# Run the CI checks (.github/workflows/ci.yml) on this Mac, in a clean checkout of HEAD, so a push
# doesn't have to wait for a GitHub runner. A clean checkout catches what a working tree hides:
# files that were never committed, and dependencies that only resolve here.
#
#   scripts/ci.sh            node + swift, from a clean checkout of HEAD
#   scripts/ci.sh swift      just the Swift package
#   scripts/ci.sh node       just 1.0 (typecheck, tests, web build)
#   CI_DIRTY=1 scripts/ci.sh  test the working tree as it is instead (faster, less faithful)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
what="${1:-all}"

if [[ "${CI_DIRTY:-}" == 1 ]]; then
  dir="$repo"
else
  dir="$(mktemp -d "${TMPDIR:-/tmp}/gcc-ci.XXXXXX")"
  trap 'git -C "$repo" worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"' EXIT
  git -C "$repo" worktree add --detach --quiet "$dir" HEAD
  echo "== clean checkout of $(git -C "$repo" rev-parse --short HEAD) in $dir"
fi
cd "$dir"

start=$SECONDS
if [[ "$what" == all || "$what" == node ]]; then
  echo "== node: npm ci"; npm ci --no-audit --no-fund --loglevel=error
  echo "== node: typecheck"; npm run --silent typecheck
  echo "== node: test"; npm test --silent
  echo "== node: build:web"; npm run --silent build:web >/dev/null
fi
if [[ "$what" == all || "$what" == swift ]]; then
  echo "== swift: test"
  log="$(mktemp)"
  if ! swift test --package-path swift >"$log" 2>&1; then
    sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -E "✘|error:|Test run with" | head -40
    echo "== swift tests FAILED (full log: $log)"; exit 1
  fi
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -E "Test run with"
fi
echo "== CI passed locally in $((SECONDS - start))s"
