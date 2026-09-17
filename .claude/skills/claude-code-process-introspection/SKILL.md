---
name: claude-code-process-introspection
description: Use when building a tool that needs to detect or monitor live Claude Code CLI sessions on macOS — reading per-pid state from `~/.claude/sessions/<pid>.json`, checking process liveness, and deriving "awaiting permission" / "awaiting plan" from hook events. Covers the session schema, the in-process liveness check, and the append-only `<sessionId>.events.ndjson` hook log that surfaces the states the `status` field does not, without modifying Claude itself.
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

Confirmed values for `status`: only `"busy"` and `"idle"`. **There is no native `awaiting_permission` value** — see "Hook events → an append-only event log" below for how we derive one.

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

## Hook events → an append-only event log

There is no native "awaiting" status, and nothing announces a permission *answer*. What
does exist is a hook event for every point of the turn — so derive the state from that
stream rather than from sidecar files and mtimes.

Register every event **catch-all** (`"matcher": ""`), never scoped to a tool: the awaiting
flags below are cleared by the *next* tool event of the turn, whatever tool that is, so a
`"matcher": "ExitPlanMode"` entry would set a state it can never clear. The hook stdin is
JSON:

```json
{
  "session_id": "07cbcb21-23f8-450b-a03c-cdfac4316542",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "Notification",
  "notification_type": "permission_prompt",
  "message": "..."
}
```

### Bash — `claude-code/hooks/notification.sh`

One script for every event, with no mapping table: it reads stdin via `cat`, extracts
`session_id` / `hook_event_name` / `tool_name` / `notification_type` with `jq -r`, and
appends a single line — `{"ts","event","tool"?,"notifType"?,"todos"?,…}`, built with
`jq -nc` so a quote in a tool name cannot corrupt the log — to
`${HOME}/.claude/sessions/${SESSION_ID}.events.ndjson`. `SessionStart` truncates the file
first (clean reset, and it bounds a long-lived session); `SessionEnd` unlinks it. Echoes
`{}` to be polite to other hooks. Keep it cheap: it runs on every single tool call, and all
`SessionEnd` hooks share a 1.5 s budget.

### Replaying the log

The consumer replays the lines through a pure reducer every tick (`reduceEvents`,
`stream-deck/src/session-events.ts`). The rules that matter:

- `UserPromptSubmit` → busy, `Stop`/`StopFailure` → not busy. `StopFailure` also means the
  turn errored. Everything else is scoped to a turn, and `busy` stands in for Claude Code's
  own flag, which `<pid>.json` omits on some entrypoints (seen on `entrypoint: "sdk-ts"`).
- `Notification` **counts only while busy** — after `Stop`, Claude Code keeps firing it
  every ~60 s as an afk nudge. In-turn, `notification_type: "permission_prompt"` is "asking
  to use a tool"; anything else (`elicitation_dialog`, or an older log with no type) is a
  generic "needs input".
- `PreToolUse[ExitPlanMode]` → awaiting-plan, cleared by its `PostToolUse`, which fires on
  both Approve and Reject. `PreToolUse[AskUserQuestion]` likewise — its `PostToolUse` only
  fires once the user has answered, and `Notification` never fires for it.
- Any other `PreToolUse`/`PostToolUse` clears the awaiting flags: Claude Code emits no tool
  events while genuinely blocked on the user, so resumed tool activity *is* the answer.
  Ordering is safe — the `PreToolUse` that triggers a permission prompt fires before the
  `Notification` it raises.

This replaced a file-per-state design (a `PreToolUse` hook dropping `<sessionId>.notify.json`,
its `PostToolUse` removing it): the drop/rm pairs race, and a missed removal had to be papered
over with an mtime TTL. An append-only log has no pairs to miss.

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
- `Stop` / `StopFailure` / `SubagentStart` / `SubagentStop`
- `Notification`
- `PermissionRequest` — fires *before* the permission dialog, and its stdout can decide the call

All of the above except `PostToolUseFailure` and `PermissionRequest` feed the event log; `PermissionRequest` has its own handler (`claude-code/bin/claude-permission`).

There is still **no** `PermissionGranted` or `PermissionDenied` event, so nothing announces the answer. The awaiting state is cleared by the next `PreToolUse`/`PostToolUse` of the turn — which is why those two are registered catch-all rather than per tool.
