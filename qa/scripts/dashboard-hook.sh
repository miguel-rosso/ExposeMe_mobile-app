#!/usr/bin/env bash
# Claude Code hook: keeps the QA dashboard from going stale and the fixer slots full.
# Stop: block when qa/backlog.json has unpublished changes, or when fewer than 3 qa-fixers are running
#   while open issues remain (qa/scripts/slots-check.mjs).
# PostToolUse (Agent): after starting a subagent, remind about both.
# Only active while a QA loop is running in this repo (qa/backlog.json exists).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$ROOT/qa/backlog.json" ] || exit 0
event="$(cat)"
name="$(printf '%s' "$event" | jq -r '.hook_event_name // empty' 2>/dev/null)"
# Avoid loops: a Stop already continued by this hook is let through
[ "$(printf '%s' "$event" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0
stale="$(node "$ROOT/qa/scripts/export-dashboard.mjs" --status 2>/dev/null | jq -r '.stale | join(", ")' 2>/dev/null)"
slots="$(node "$ROOT/qa/scripts/slots-check.mjs" 2>/dev/null | jq -r 'select(.short) | .msg' 2>/dev/null)"
msg=""
[ -n "$stale" ] && msg="QA dashboard is stale ($stale changed in qa/backlog.json but not published). Publish now as in exposeme-qa-loop step 6: upload only these JSON files as assets, one ArtifactData batch for those datasets, then run: node qa/scripts/export-dashboard.mjs --mark-published"
[ -n "$slots" ] && msg="${msg:+$msg }$slots"
[ -n "$msg" ] || exit 0
case "$name" in
  Stop) jq -n --arg r "$msg" '{decision: "block", reason: $r}';;
  PostToolUse) jq -n --arg c "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}';;
esac
exit 0
