#!/usr/bin/env bash
# Prepare a git worktree (created for a parallel qa-fixer) to run tests, type checks and bots
# without reinstalling dependencies: symlink node_modules from the main checkout.
# Usage (from anywhere): qa/lab/worktree-setup.sh <worktree-path>
# If a fix adds or changes a dependency, replace the symlink in that package with a real
# `npm install` inside the worktree (and tell the orchestrator: lockfile changes merge last).
set -euo pipefail
WT="$(cd "${1:?worktree path}" && pwd)"
MAIN="$(git -C "$WT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
[ "$WT" != "$MAIN" ] || { echo "refusing: $WT is the main checkout" >&2; exit 1; }
for pkg in Server Client qa; do
  if [ -d "$MAIN/$pkg/node_modules" ] && [ ! -e "$WT/$pkg/node_modules" ]; then
    ln -s "$MAIN/$pkg/node_modules" "$WT/$pkg/node_modules"
    echo "linked $pkg/node_modules"
  fi
done
mkdir -p "$WT/qa/runs"
# Bot photos live in the main checkout's ignored qa/runs/photos
[ -e "$WT/qa/runs/photos" ] || ln -s "$MAIN/qa/runs/photos" "$WT/qa/runs/photos"
echo "worktree ready: $WT (main: $MAIN)"
