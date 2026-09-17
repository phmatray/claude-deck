#!/usr/bin/env bash
# Is the claude-deck Claude Code plugin wired up on THIS machine? Reads the real
# ~/.claude state, so it is a probe, not a CI check. Same rules as
# stream-deck/src/hook-check.ts (hermetic test: stream-deck/scripts/check-hook-check.mts):
#   1. settings.json enabledPlugins has claude-deck@<marketplace> = true
#   2. plugins/installed_plugins.json has that key (user scope preferred)
#   3. <installPath>/hooks/hooks.json registers the 10 status events catch-all on
#      .../hooks/notification.sh, and PermissionRequest on .../bin/claude-permission
#   4. the installed notification.sh exists and is executable
# Warns (does not fail) when settings.json still carries the pre-3.0 hooks.
#
# Exit code: 0 if everything is wired up, 1 otherwise, 2 without jq.
# Usage: bash scripts/probe-hooks.sh

set -euo pipefail

EVENTS=(SessionStart Notification PreToolUse PostToolUse Stop StopFailure UserPromptSubmit SubagentStart SubagentStop SessionEnd)
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
INSTALLED="${CLAUDE_DIR}/plugins/installed_plugins.json"

if [ -t 1 ]; then
  GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "${RED}error:${RESET} jq is required" >&2
  exit 2
fi

ALL_OK=1
ok()   { echo "  ${GREEN}✓${RESET} $1"; }
fail() { echo "  ${RED}✗${RESET} $1"; ALL_OK=0; }
warn() { echo "  ${YELLOW}!${RESET} $1"; }
summary() {
  echo
  if [ "$ALL_OK" -eq 1 ]; then
    echo "${GREEN}${BOLD}All hooks verified.${RESET}"
    exit 0
  fi
  echo "${RED}${BOLD}Hooks are missing or misconfigured.${RESET} Fix: claude plugin install claude-deck@phmatray"
  exit 1
}

echo "${BOLD}Claude Code plugin${RESET}"

if jq -e '[.hooks // {} | .[] | .[]? | .hooks[]? | .command // "" | test("(streamdeck-claude|claude-deck).*notification\\.(sh|ps1)")] | any' "$SETTINGS" >/dev/null 2>&1; then
  warn "legacy hooks in settings.json: every event is logged twice; run scripts/migrate-settings.mjs"
fi

KEY="$(jq -r '.enabledPlugins // {} | to_entries[] | select((.key | test("^claude-deck@")) and .value == true) | .key' "$SETTINGS" 2>/dev/null | head -1 || true)"
if [ -z "$KEY" ]; then
  fail "plugin claude-deck not enabled (${SETTINGS})"
  summary
fi
ok "$KEY enabled"

INSTALL_PATH="$(jq -r --arg k "$KEY" '(.plugins[$k] // []) as $e | (($e | map(select(.scope == "user")) | first) // ($e | first) // {}) | .installPath // empty' "$INSTALLED" 2>/dev/null || true)"
if [ -z "$INSTALL_PATH" ]; then
  fail "plugin $KEY not installed (${INSTALLED})"
  summary
fi
ok "installed at $INSTALL_PATH"

HOOKS_JSON="${INSTALL_PATH}/hooks/hooks.json"
if ! jq empty "$HOOKS_JSON" 2>/dev/null; then
  fail "installed plugin has no readable hooks/hooks.json"
  summary
fi

# True when .hooks[$e] has a catch-all group (matcher "" or absent) whose command matches $re.
registered() {
  jq -e --arg e "$1" --arg re "$2" '
    [.hooks[$e] // [] | .[] | select((.matcher // "") == "") | .hooks[]? | .command // "" | test($re)] | any
  ' "$HOOKS_JSON" >/dev/null
}

for event in "${EVENTS[@]}"; do
  if registered "$event" '/hooks/notification\.sh$'; then ok "$event"; else fail "$event not registered catch-all"; fi
done
if registered PermissionRequest '/bin/claude-permission$'; then ok "PermissionRequest"; else fail "PermissionRequest not registered"; fi

if [ -x "${INSTALL_PATH}/hooks/notification.sh" ]; then
  ok "hooks/notification.sh (executable)"
else
  fail "installed plugin has no executable hooks/notification.sh"
fi

summary
