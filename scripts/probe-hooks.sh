#!/usr/bin/env bash
# Verify that the streamdeck-claude hook is registered in Claude Code's
# ~/.claude/settings.json — every event the state machine cares about, with
# the right matcher, pointing at the right script. Run after `pnpm install:hook`
# to confirm the install actually took.
#
# Exit code: 0 if everything is wired up, 1 otherwise.
#
# Usage:
#   bash scripts/check-hooks.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# event|matcher pairs — must stay in sync with scripts/install-hook.sh
EXPECTED_EVENTS=(
  "SessionStart|"
  "Notification|"
  "PreToolUse|"
  "PostToolUse|"
  "Stop|"
  "StopFailure|"
  "UserPromptSubmit|"
  "SubagentStart|"
  "SubagentStop|"
  "SessionEnd|"
)

HOOK="${ROOT}/hooks/notification.sh"
HOOK_REGEX="(streamdeck-claude|claude-deck).*notification\\.sh"

if [ -t 1 ]; then
  GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; RED=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "${RED}error:${RESET} jq is required" >&2
  exit 2
fi

ALL_OK=1
ok()   { echo "  ${GREEN}✓${RESET} $1"; }
fail() { echo "  ${RED}✗${RESET} $1"; ALL_OK=0; }
warn() { echo "  ${YELLOW}!${RESET} $1"; }

check_settings() {
  local label="$1" settings="$2" hook_regex="$3"
  echo
  echo "${BOLD}${label}${RESET} ${DIM}— ${settings}${RESET}"

  if [ ! -f "$settings" ]; then
    fail "settings.json missing — run the matching install:hook script"
    return
  fi
  if ! jq empty "$settings" 2>/dev/null; then
    fail "settings.json is not valid JSON"
    return
  fi

  for entry in "${EXPECTED_EVENTS[@]}"; do
    local event="${entry%%|*}"
    local matcher="${entry#*|}"
    local label_matcher="${matcher:-no matcher}"

    # Find every streamdeck-claude command registered for (event, matcher).
    # Treat empty/missing matcher as "" — install-hook.sh writes "" explicitly.
    local cmds
    cmds="$(jq -r --arg e "$event" --arg m "$matcher" --arg re "$hook_regex" '
      .hooks[$e] // []
      | map(select((.matcher // "") == $m))
      | map(.hooks[]?.command // empty)
      | map(select(test($re)))
      | .[]
    ' "$settings" 2>/dev/null || true)"

    if [ -z "$cmds" ]; then
      fail "${event}[${label_matcher}] — not registered"
    else
      local count
      count="$(printf '%s\n' "$cmds" | wc -l)"
      if [ "$count" -gt 1 ]; then
        warn "${event}[${label_matcher}] — registered ${count}× (duplicate); first: $(printf '%s\n' "$cmds" | head -1)"
      else
        ok "${event}[${label_matcher}]"
      fi
    fi
  done
}

# --- Hook scripts on disk -------------------------------------------------
echo "${BOLD}Hook scripts${RESET}"
if [ -f "$HOOK" ] && [ -x "$HOOK" ]; then
  ok "$HOOK (executable)"
else
  fail "$HOOK (missing or not executable)"
fi

# --- Settings -------------------------------------------------------------
check_settings "Hooks (${USER:-?})" "${HOME}/.claude/settings.json" "$HOOK_REGEX"

# --- Summary --------------------------------------------------------------
echo
if [ "$ALL_OK" -eq 1 ]; then
  echo "${GREEN}${BOLD}All hooks verified.${RESET}"
  exit 0
else
  echo "${RED}${BOLD}Some hooks are missing or misconfigured.${RESET} Re-run pnpm install:hook."
  exit 1
fi
