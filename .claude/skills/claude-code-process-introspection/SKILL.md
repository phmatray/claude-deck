---
name: claude-code-process-introspection
description: Use when building a tool that needs to detect or monitor live Claude Code CLI sessions on macOS — reading per-pid state from `~/.claude/sessions/<pid>.json`, checking process liveness, and installing Notification hooks idempotently. Covers the session schema, the in-process liveness check, and the `<sessionId>.notify.json` pattern for surfacing "awaiting permission" state without modifying Claude itself.
---

# Claude Code process introspection

Built and validated while shipping `streamdeck-claude`. Everything below is observed behaviour against Claude Code 2.1.x — there's no public spec, treat the schema as best-effort and don't rely on undocumented fields.

## Where Claude Code stores live session state

Every running `claude` CLI writes a JSON file to `<HOME>/.claude/sessions/<pid>.json`:

```json
{
  "pid": 234003,
  "sessionId": "07cbcb21-23f8-450b-a03c-cdfac4316542",
  "cwd": "/Users/me/dev/streamdeck-claude",
  "startedAt": 1778324147749,
  "procStart": "31768035",
  "version": "2.1.138",
  "peerProtocol": 1,
  "kind": "interactive",
  "entrypoint": "cli",
  "status": "busy",
  "updatedAt": 1778324166394,
  "name": "html-effectiveness-doc",
  "nameSource": "derived",
  "bridgeSessionId": "session_01ER..."
}
```

Confirmed values for `status`: only `"busy"` and `"idle"`. **There is no native `awaiting_permission` value** — see "Notification hook" below for our workaround.

`name` used to appear only when the user set a custom title (`/title`) or for managed-agent sessions. **From 2.1.x it is always present**: absent a title, Claude Code derives one as `<cwd basename>-<2-char suffix>` (`streamdeck-claude-b7`) and tags it `"nameSource": "derived"`. So a non-empty `name` no longer means a human chose it — check `nameSource` before treating it as a label, or you'll show a meaningless suffix. The suffix is still worth keeping somewhere: it is the only field distinguishing two sessions running in the same directory. Older builds omit `nameSource` entirely, so fall back to matching the derived shape. `bridgeSessionId` indicates a managed/remote agent session. Both remain best-effort; `basename(cwd)` is the safe fallback for a label.

**Files persist after the process exits.** They are not cleaned up. Always combine the file scan with a liveness check; a session file alone tells you nothing.

## Liveness check

Check each candidate pid in-process with `process.kill(pid, 0)`: it delivers no signal, only the existence/permission check. No throw → alive; `EPERM` → alive but owned by another user; `ESRCH` → gone. No spawn per tick, nothing to cache. Reference: `src/live-pids.ts`.

## Stale-file handling

`~/.claude/sessions/` accumulates dead-pid `.json` files indefinitely. A naive consumer that treats every dead session as "just finished" will spam the UI with months-old leftovers.

Rule we ship: a session enters the "finished" bucket **only** when it was alive in the previous tick AND is dead in this one. Sessions that are dead-on-arrival (never seen alive in this run) are silently dropped.

```ts
// pseudo
let prevLive = new Set<string>();
function tick(sessions, live) {
  for (const s of sessions) {
    if (prevLive.has(s.sessionId) && !live.has(s.sessionId)) {
      finished.set(s.sessionId, { ttl: 3000, ...s });
    }
  }
  prevLive = live;
}
```

## Plan-approval hook — surfacing `ExitPlanMode` waits

Claude's `ExitPlanMode` tool pauses the assistant until the user clicks Approve or Reject. There is no dedicated event for "plan presented to user" — but the `PreToolUse`/`PostToolUse` hooks fire for every tool call, including this one, and accept a `matcher` field to scope by tool name:

```json
"PreToolUse":  [{ "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "..." }]}],
"PostToolUse": [{ "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "..." }]}]
```

We use the same notify-file pattern: PreToolUse drops `<sessionId>.plan.json`, PostToolUse removes it. PostToolUse fires both on Approve (when Claude resumes and processes the tool result) and on Reject (when Claude iterates on the plan), so the file always gets cleared. The consumer treats `status=idle` + plan file present (mtime within ~30 min as a safety TTL) as the awaiting-plan state, and prioritises it over the simpler awaiting-permission state.

The hook script is the same one used for `Notification` — it routes by `hook_event_name` (and, for tool events, `tool_name`) read from the JSON stdin payload. One installed command, three settings entries (`Notification`, `PreToolUse[ExitPlanMode]`, `PostToolUse[ExitPlanMode]`). Reference: `claude-code/hooks/notification.sh`.

## Notification hook — surfacing "awaiting permission"

Claude Code fires the `Notification` hook event when it needs the user (permission prompts, idle prompt). The hook stdin is JSON:

```json
{
  "session_id": "07cbcb21-23f8-450b-a03c-cdfac4316542",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "Notification",
  "message": "..."
}
```

Pattern we use to surface awaiting state without modifying Claude: **the hook drops a tiny `<sessionId>.notify.json` next to the session JSON.** The consumer then treats `status=idle` + notify-mtime within 60 s as "awaiting", and `status=busy` (or stale notify) as "no longer awaiting" — no explicit clear-hook needed.

### Bash — `claude-code/hooks/notification.sh`

Reads stdin via `cat`, extracts `session_id` with `jq -r '.session_id // empty'`, writes `${HOME}/.claude/sessions/${SESSION_ID}.notify.json` with a millisecond timestamp. Echoes `{}` to be polite to other hooks.

## Idempotent settings.json merge

`~/.claude/settings.json` uses this schema:

```json
{
  "hooks": {
    "Notification": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "..." }] },
      ...
    ]
  }
}
```

Multiple Notification entries are fine — Claude fires them all. Idempotent installer pattern (from the pre-3.0 `install-hook.sh`; 3.0 ships the hooks in the plugin's `hooks.json` and `scripts/migrate-settings.mjs` removes these entries):

```sh
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {}
  | .hooks.Notification //= []
  | if any(.hooks.Notification[]?; (.hooks // []) | any(.command == $cmd))
    then .
    else .hooks.Notification += [{
      "matcher": "",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
    end
' settings.json > tmp && mv tmp settings.json
```

The merge keys on the exact `command` string, so re-running is a no-op. Take a daily backup first: `cp settings.json settings.json.bak.$(date +%Y%m%d)`.

## Bash watch-out — `cp -i` aliases

Many shells alias `cp` to `cp -i`. When an installer runs `cp src dst` with the destination already present, the prompt has no terminal to answer on, and the copy silently no-ops while the script continues happily. **Use `command cp -f`** (or `\cp -f`) in installer scripts to bypass the alias. We hit this exact failure mode while shipping a hook installer — the hook script appeared "installed" but was the wrong version.

## Hook events you might want besides Notification

Confirmed firing in current Claude Code:
- `SessionStart` — startup, clear, compact
- `SessionEnd` — session ends
- `UserPromptSubmit` — user submits a prompt
- `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
- `Stop` / `SubagentStart` / `SubagentStop`
- `Notification` — what we use

There is **no** `PermissionGranted` or `PermissionDenied` event — that's why we rely on the status-flip from `idle` → `busy` to clear the awaiting state instead of an explicit clear hook.
