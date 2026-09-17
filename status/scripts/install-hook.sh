#!/usr/bin/env bash
# Idempotently installs the streamdeck-claude hook into Claude Code's
# user-global settings.json (~/.claude/settings.json).
#
# The hook (hooks/notification.sh) appends one JSON line per
# fire to <sid>.events.ndjson. The plugin replays the log through the state
# machine in src/session-events.ts to derive the icon state. We register the
# hook for every CC event whose semantics that machine knows how to handle —
# adding a new state means registering its event here AND adding a case in
# session-events.ts.
#
# Usage:
#   bash scripts/install-hook.sh
#
# Safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS_PATH="${HOME}/.claude/settings.json"
HOOK_CMD="${ROOT}/hooks/notification.sh"
if [ ! -x "$HOOK_CMD" ]; then
  chmod +x "$HOOK_CMD"
fi

# --- Ensure settings.json exists, back it up, merge hooks ------------------
if [ ! -f "$SETTINGS_PATH" ]; then
  echo "{}" > "$SETTINGS_PATH"
fi

BACKUP="${SETTINGS_PATH}.bak.$(date +%Y%m%d)"
[ -f "$BACKUP" ] || cp "$SETTINGS_PATH" "$BACKUP"

# Strip every previous streamdeck-claude entry across all events. Matches
# anything whose command references our notification.sh (or the retired
# notification.ps1), regardless of quoting, slashes, or which install pattern
# wrote it. Empty matcher arrays are dropped, then empty event keys are dropped
# — so a clean uninstall would leave .hooks itself absent.
PRUNE_FILTER='
  .hooks //= {}
  | .hooks |= with_entries(
      .value |= map(
        .hooks |= map(
          select(
            (.command // "")
            | test("(streamdeck-claude|claude-deck).*notification\\.(ps1|sh)") | not
          )
        )
        | select(.hooks | length > 0)
      )
      | select(.value | length > 0)
    )
'

prune_existing() {
  local tmp
  tmp="$(mktemp)"
  jq "$PRUNE_FILTER" "$SETTINGS_PATH" > "$tmp"
  mv "$tmp" "$SETTINGS_PATH"
}

# jq filter that registers our command for one event/matcher pair. Run after
# prune_existing, so duplication is prevented by the prune step rather than
# a per-call check.
JQ_FILTER='
  .hooks //= {}
  | .hooks[$event] //= []
  | .hooks[$event] += [{"matcher": $matcher, "hooks": [{"type": "command", "command": $cmd}]}]
'

merge() {
  local event="$1" matcher="$2" tmp
  tmp="$(mktemp)"
  jq --arg event "$event" --arg matcher "$matcher" --arg cmd "$HOOK_CMD" "$JQ_FILTER" "$SETTINGS_PATH" > "$tmp"
  mv "$tmp" "$SETTINGS_PATH"
}

prune_existing

# PreToolUse / PostToolUse are registered catch-all (matcher="") rather than
# tool-specific, so we capture every tool invocation in one shot. The reducer
# in src/session-events.ts dispatches by `tool_name` — currently it cares about
# ExitPlanMode, TodoWrite, and AskUserQuestion; other tools are noop'd at the
# reducer level. Trade-off: bigger NDJSON per session (~1 line per tool call,
# but SessionStart truncates so it's bounded per CC run).
merge "SessionStart"     ""
merge "Notification"     ""
merge "PreToolUse"       ""
merge "PostToolUse"      ""
merge "Stop"             ""
merge "StopFailure"      ""
merge "UserPromptSubmit" ""
merge "SubagentStart"    ""
merge "SubagentStop"     ""
merge "SessionEnd"       ""

# --- Final summary ---------------------------------------------------------
echo "Hook command:"
echo "  $HOOK_CMD"
echo "Registered for: SessionStart, Notification, PreToolUse, PostToolUse, Stop, StopFailure, UserPromptSubmit, SubagentStart, SubagentStop, SessionEnd"
echo "Settings: $SETTINGS_PATH  (backup at $BACKUP)"
