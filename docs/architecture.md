# Architecture

How the plugin discovers Claude Code sessions, derives state, and renders icons. This is reference material — for what the plugin *does*, see the top-level [`README.md`](../README.md).

## Session discovery

Claude Code drops one JSON file per running CLI session under `~/.claude/sessions/<pid>.json`. The plugin reads that directory once per second, filters out stale files with an in-process `process.kill(pid, 0)` (`src/live-pids.ts`: no throw or `EPERM` = alive, `ESRCH` = dead), sorts the live sessions most-recent-event-first, and renders an SVG per Stream Deck slot via `setImage`. bg agents skip the pid check: their pid is a shared daemon, so a fresh `updatedAt` and a non-terminal status decide instead.

### Slot ordering

There are routinely more live sessions than keys on the deck — an editor hosting Claude Code over ACP keeps one `claude` process per open thread, restored ones included — so the order decides what you actually get to see. Two groups:

1. **Blocked on you.** `awaiting_plan`, `awaiting_permission`, `awaiting_question`, `awaiting`, `error`, `bg_awaiting_permission`, `bg_awaiting` (`ATTENTION_STATES` in `src/state-tracker.ts`).
2. **Everything else.**

Within each group, `lastActivityAt` descending — the `ts` of the newest line in the session's event log, falling back to `startedAt` when there is no log yet, and to the json's `updatedAt` for bg agents, which never fire hooks.

The group split is not cosmetic. A session's event log stops growing the instant it starts waiting, while a working session appends a `PreToolUse`/`PostToolUse` pair every second or so; on recency alone the working session would always bury the one that needs you. Answering a prompt is seamless in the other direction: clearing the flag drops the session into group 2, where its now-newest event holds it in the same place.

A session promoted into `recentlyFinished` gets its `lastActivityAt` re-stamped to the moment of death. Without that the 3s green check would sink: `SessionEnd`'s hook unlinks the event log, so a cleanly-exited session falls back to `startedAt` — hours old, and off the bottom of a short deck.

Ties break on `startedAt` descending, then `pid` ascending. The explicit tiebreak is load-bearing: sessions restored in one batch share a `SessionStart` ts to the millisecond, and relying on sort stability there would hand the order to `readSessionFiles`' `Promise.all` push order, which varies per tick and would repaint every key for nothing.

The keys then show the **head** of that list — `sortedEntries.slice(0, actionCount)`, each entry stamped with its 1-based `slotNumber` for the corner badge. There is no paging: on an XL the slots outnumber the sessions, and attention-first ordering already puts what needs you on the first key. `tick`'s log line carries `shown=<visible>/<total>` and `maybeLog` dedups on the whole string, so the log records exactly the ticks where that changed.

Because slot identity changes between two ticks as the ordering shifts, a key press pins the caption it was showing at `KeyDown` (`SlotState.pressedLabel` / `pressedBadge` / `pressedFocus` / `pressedSessionId`); the kill target's pid was already captured in `onKeyDown`'s locals.

### Press gestures (`src/slot-action.ts`)

One key, three lengths, two timers armed at `KeyDown` and cancelled by whichever `KeyUp` comes first:

| Held | Effect |
|---|---|
| < `LONG_PRESS_MS` (500 ms) | Short press: `focusSession` on the pinned target, plus `showQuestion` when that session has one waiting on the deck. |
| ≥ 500 ms | Wipes the session's event log and re-derives its state. Arms the kill ring — but only for a killable session. |
| ≥ `KILL_PRESS_MS` (3 s) | `killSession`: `SIGTERM`, then `SIGKILL` 2 s later if the pid is still there. |

`killArmingSince` drives the red progress ring in `render-loop.ts` and is what suppresses the green `showOk()` of the wipe: the ring is the confirmation, and a green flash on top of it would read as "done". Background agents are not killable — their pid is a shared daemon — so the second timer is never armed for them.

## State derivation

Every registered Claude Code hook event appends one JSON line to `~/.claude/sessions/<sessionId>.events.ndjson` — a single source of truth, no per-state sidecar files, no mtime heuristics. The plugin replays each log every tick through the pure state machine in `src/session-events.ts` (`reduceEvents`).

| Hook event | Effect on state |
|---|---|
| `SessionStart` | truncates the log + resets state |
| `Notification[permission_prompt]` | sets `awaitingPermission` (only in-turn) |
| `Notification[*]` other in-turn types | sets `awaiting` (catch-all for `elicitation_dialog` / unknown / older logs) |
| `Notification` post-Stop (`idle_prompt`) | ignored — filtered by reducer's `busy` guard |
| `Stop` | clears `busy` + `awaiting` / `awaitingPermission` / `awaitingQuestion` / `awaitingPlan` |
| `PreToolUse[ExitPlanMode]` | sets `awaitingPlan` |
| `PostToolUse[ExitPlanMode]` | clears `awaitingPlan` |
| `PreToolUse[AskUserQuestion]` | sets `awaitingQuestion` |
| `PostToolUse[AskUserQuestion]` | clears `awaitingQuestion` |
| `StopFailure` | sets `errored` |
| `UserPromptSubmit` | sets `busy`, clears all `awaiting*` flags + `errored` |
| `SubagentStart` / `SubagentStop` | bumps `subagentDepth` ±1 |
| `SessionEnd` | unlinks the log |

The `notification_type` discrimination requires hooks to capture CC's `notification_type` field into the NDJSON `notifType` column — `notification.sh` does this. Older logs without `notifType` fall through to plain `awaiting` (catch-all), so the regression risk is bounded.

`PreToolUse` and `PostToolUse` are registered with **empty matcher** (catch-all), so the NDJSON gets one line per tool call. The reducer dispatches by `tool_name` — only `ExitPlanMode`, `AskUserQuestion`, and `TodoWrite` produce state transitions; other tools are no-ops. The trade-off is bigger logs (~1 line per Bash/Edit/Read), but `SessionStart` truncates so it stays bounded per CC run.

The catch-all matcher is load-bearing: `awaitingPermission` is cleared by *any* `PreToolUse`/`PostToolUse` mid-turn (`session-events.ts`), so a permission padlock only clears once a normal tool runs after approval. Registered tool-specific instead, `PostToolUse[Bash]` never fires and the padlock stays stuck until the turn ends.

`src/hook-check.ts` guards against exactly that, at startup and whenever the Setup key appears. It judges the **installed** plugin, not the repo and not `settings.json`, since Claude Code runs a versioned copy: `~/.claude/settings.json` must have an `enabledPlugins` key matching `/^claude-deck@/` set to `true`, `~/.claude/plugins/installed_plugins.json` must carry that key, that install's `hooks/hooks.json` must register all ten events catch-all on a command ending in `/hooks/notification.sh` plus `PermissionRequest` on `/bin/claude-permission`, and the cached `notification.sh` must exist. Failures become an amber `HOOKS` badge on the Setup key; hooks left in `settings.json` by the pre-3.0 installer are only a *warning* (every event logs twice — `scripts/migrate-settings.mjs` removes them). Every path derives from a `home` parameter, which is how `scripts/check-hook-check.mts` runs it against fake `HOME`s; `scripts/probe-hooks.sh` applies the same rules to the real one.

To add a new state: register the event in `claude-code/hooks/hooks.json`, add a case in `src/session-events.ts`, and an entry in the `STATES` registry at `src/icons/states.ts`. State priority (see `deriveState()` in `src/sessions.ts`): `finished` > `error` > a question pending on the deck (`src/ask/queue.ts`, joined by session id each tick: `permission` → `awaiting_permission`, `plan` → `awaiting_plan`, `ask` → `awaiting_question`; the key also gets a deck badge) > `awaiting_plan` > `awaiting_permission` > `awaiting_question` > `awaiting` > `subagent` > `working` > `idle`. All `awaiting*` flags win over `busy` because CC keeps the session marked busy while waiting on the user.

`busy` itself is `rawStatus === "busy"` (the json's own `status` field) OR the reducer's in-turn projection. The fallback matters because `status` is absent from `<pid>.json` on some entrypoints — observed on `entrypoint: "sdk-ts"`, i.e. every SDK/ACP-hosted session — which would otherwise pin those sessions to the `idle` icon for their whole lifetime.

## Path resolution

Every per-user path lives in `src/env.ts`, derived from `os.homedir()` (which honours `HOME` when set, so checks can run against a temp home): `~/.claude/sessions`, `~/.claude/settings.json`, `~/.claude.json`, the reload trigger `~/.claude/.claude-deck.reload` and the usage refresher's cwd `~/.claude/.claude-deck-usage`. Don't re-derive them elsewhere.

## Tick loop

`src/plugin.ts` runs two intervals against the same `state-tracker.ts` instance:

- **Slow tick (1s):** `tracker.tick()` re-reads sessions + liveness + event logs, computes the sorted `DisplayEntry[]`, and `renderAll()`s every slot. It then calls `renderUsage()` for the plan-usage keys — a no-op that costs nothing when none of them are on the deck. Re-entrancy guarded by `slowTickRunning`.
- **Animation tick (120ms):** advances `frame`, then renders only if `tracker.needsAnimation()` is true (an animated motif, or a pulsing in-progress todo — text never moves). Same guard pattern.

`createStateTracker()` owns the cross-tick bookkeeping: `prevLiveIds` (so a session is promoted to `finished` only when it was alive *last tick* — stale junk files from previous CC runs never appear) and `recentlyFinished` (carry-over for `FINISHED_TTL_MS = 3000`ms after death).

## Render pipeline

`SlotAction.orderedActions()` sorts visible action instances by Stream Deck `(row, column)` — that's what defines slot 1..N. `renderAll()` zips slots with `DisplayEntry[]`, calls `renderIcon()` to produce an SVG, base64-encodes a `data:image/svg+xml;base64,…` URL, and only calls `setImage` when the URL changed (per-slot dedup via `slotState.lastSvg`).

A key shows one meaning per line: the repo name on top (or the session name the user pinned, when `nameSource` isn't `"derived"`), the current branch below — a short SHA when HEAD is detached, nothing at all outside a repo. The repo name is truncated with an ellipsis when it overflows the 124px viewport — nothing scrolls, because a key is glanced at rather than read and a moving line makes you wait for the part you need. The branch gets one more option first: if it doesn't fit on one line at 17px but does at 15px, it renders whole at the smaller size; only if it still overflows does it wrap onto two 15px lines (breaking after `/` or `-`, never mid-word), with the motif shrinking to make room. `overflows()` is the single width check all three paths share, so they can't disagree; `fitText()` then cuts flush to the band, since `approxWidth()` is a per-char estimate that underruns on wide glyphs. A clip on each line is the backstop for that estimate: on a pathological string (`WWWW…`) the text is cut at both ends and the ellipsis falls off-screen, which is the intended degradation. Claude Code's own derived name is `<cwd basename>-<suffix>`; the suffix is demoted to a top-left badge, sharing that corner with the `bg` tag, because it's the only thing distinguishing two sessions running in the same worktree.

Repo and branch come from `src/git-info.ts`, which reads git's plumbing (`.git/HEAD`, plus `gitdir:`/`commondir` for linked worktrees) instead of spawning `git` — the slow tick runs once a second across every live session. Both the cwd→repo resolution and the parsed HEAD are memoised, the latter gated on (mtime, size) like the caches in `sessions.ts`, and pruned against the live session set. Anything unreachable degrades to "no branch line" rather than throwing.

Icon code is split per concern across `src/icons/`:
- `theme.ts` — palette / dimension constants
- `motifs.ts` — animated SVG fragments per state
- `states.ts` — the single `STATES` registry mapping each `SessionState` to palette + motif + animation flag
- `text.ts` — width estimation + wrapping + truncation
- `render.ts` — composes the final SVG

The plan-usage keys are a second, much simpler path through the same idea:
`usage.ts` parses `~/.claude.json` → `cachedUsageUtilization` (mtime-gated, so
re-parsing the ~250KB blob is rare), `usage-refresh.ts` keeps that cache from
going stale by spawning `claude -p "/usage"` off the slow tick, detached and
throttled on the snapshot's own age (Claude Code only refetches when something
asks to see usage, which an SDK-hosted session never does) or forced past that
throttle by a key press, `icons/usage-icon.ts` draws a static tile per window —
its footer showing `projectLimit()`'s stateless burn-rate estimate of when the
window runs out, rather than only the countdown to the reset — and
`usage-action.ts` dedups by SVG exactly as `renderAll()` does.
No motif, no animation — the brief was a quiet stepped colour scale. See the
"Plan usage keys" section of `CLAUDE.md` for the payload's sharp edges (ISO vs
epoch resets, `utilization` vs `percent`, model- vs surface-scoped entries).

## Answer keys and the question queue (`src/ask/`)

One pair of files per question in `$CLAUDE_ASK_DIR` (default `~/.claude-ask`), no lock: `claude-ask` writes `questions/<id>.json` (tmp file + rename) and polls for `answers/<id>.json`.

- `queue.ts` watches `questions/` with `fs.watch` **plus** a 500 ms poll, because `fs.watch` drops events. It parses each file, drops malformed ones (logged once), drops questions whose `pid` is gone (`process.kill(pid, 0)` → `ESRCH`) or whose `expiresAt` passed more than 5 s ago, and orders what is left by `createdAt`.
- `controller.ts` is the state machine: which question is active, which ids the user set aside (`dismissed`), whether the answer profile is showing and on which device. A new question activates and switches the deck to "Claude Deck"; an answered, withdrawn or expired one activates the next pending question, or switches the deck back when there is none. It imports nothing from the SDK — `switchTo` and `focus` are injected — which is what lets `scripts/check-ask-controller.mts` drive it under tsx.
- `ask.ts` binds that machine to the SDK; `actions.ts` holds the seven key classes; `render.ts` draws them (ported from the upstream answer plugin, Helvetica-Bold advance table and all).
- `detail.ts` is pure layout: the text is wrapped once at `KEYS_PER_ROW × COLS_PER_KEY` columns, then each key takes its own columns of each line, spaces turned into U+00A0 so the columns line up across the gaps between keys. Its size constants sit together at the top of the file — they are tuned by looking at the hardware.

The dashboard joins the two: `tick()` asks `pendingQuestion(sessionId)` for every session, and `deriveState` turns a pending `permission` / `plan` / `ask` into `awaiting_permission` / `awaiting_plan` / `awaiting_question` (never over `error`), which also sorts the session into the attention group and adds the deck badge to its key.

`claude-code/bin/claude-permission` is the other producer: it turns a `PermissionRequest` payload into the same question file (options built from Claude Code's own `permission_suggestions`), maps the answer back **by `optionId`**, and watches the session event log to withdraw the question when the terminal answers first.

## Launcher key (`src/launcher/`)

`tab-config.ts` is pure or `home`-parameterised: it expands `~`, refuses anything still relative, derives `claude_deck_<basename>_<6 hex of the path>` and renders the TOML. The action writes `~/.warp/tab_configs/<stem>.toml` on `willAppear` and on every settings change, but only when the content actually differs, and a press re-checks the file before `open warp://tab_config/<stem>` (`?new_window=true` when asked). A key with no usable directory paints "Dossier ?" and alerts on press rather than guessing a path.

## Reload trigger

`pnpm watch` and `pnpm sd:reload` both `touch ~/.claude/.claude-deck.reload`. The plugin polls the file's mtime each second; when it changes, the plugin calls `process.exit(0)` and the Stream Deck app respawns it (this is the SD app's normal crash-recovery behaviour, repurposed). `PROCESS_START_MS` guards against looping on startup if the trigger file already exists.

The first time after building you still need to quit + relaunch the SD app once, since the *currently-running* bundle doesn't yet know how to self-reload.

## Hook pipeline

`claude-code/hooks/notification.sh` does exactly one thing: read the hook payload from stdin, extract `session_id` + `hook_event_name` (+ optional `tool_name`), and append a single JSON line — `{"ts":…,"event":…,"tool":…?}` — to `<sessionId>.events.ndjson` next to the session JSON files. `SessionStart` truncates the log first; `SessionEnd` unlinks it.

PID liveness handles the case where a CC process dies hard (no `SessionEnd`): the session disappears from display via `state-tracker.ts`'s `prevLiveIds` check, and the orphan event log is cleaned the next time CC reuses that sessionId (`SessionStart` truncate).

## Project layout

```
.claude-plugin/marketplace.json     the "phmatray" marketplace → claude-code/
claude-code/                        the Claude Code plugin (small: Claude Code copies it into its cache)
├── .claude-plugin/plugin.json
├── hooks/hooks.json                10 status events + PermissionRequest
├── hooks/notification.sh           one NDJSON line per hook fire
├── bin/claude-ask                  the question CLI
├── bin/claude-permission           the PermissionRequest hook
└── skills/ask-on-streamdeck/       teaches Claude when to use claude-ask
scripts/                            repo-level
├── package.sh                      build + pack the .streamDeckPlugin
├── migrate-settings.mjs            drop the pre-3.0 hooks from ~/.claude/settings.json
├── migrate-profiles.mjs            re-point old dashboard keys at the merged plugin
├── check-*.mjs                     hermetic self-checks (CI runs these)
└── probe-*.sh                      live probes, real deck / real ~/.claude (never CI)
stream-deck/
├── com.phmatray.claudedeck.sdPlugin/   the Elgato plugin folder
│   ├── manifest.json                   13 actions, the bundled profile, mac-only
│   ├── bin/plugin.js                   built bundle (gitignored)
│   ├── Claude Deck.streamDeckProfile   generated by pnpm build (gitignored)
│   ├── imgs/                           static manifest icons
│   └── ui/                             property inspectors (slot, setup, launcher)
├── src/
│   ├── plugin.ts                       entry: registers actions, owns both ticks
│   ├── slot-action.ts                  per-slot action + the three press gestures
│   ├── setup-action.ts                 maintenance key (wipe logs, hook badge)
│   ├── usage-action.ts                 the three plan-usage keys
│   ├── sessions.ts                     reads ~/.claude/sessions/
│   ├── live-pids.ts                    process.kill(pid, 0) liveness
│   ├── session-events.ts               pure state machine over the event log
│   ├── state-tracker.ts                cross-tick bookkeeping + ordering
│   ├── render-loop.ts                  zip slots → setImage (deduped)
│   ├── git-info.ts                     repo + branch from git's plumbing
│   ├── hook-check.ts                   is the Claude Code plugin registering the hooks?
│   ├── kill-session.ts                 SIGTERM → SIGKILL
│   ├── usage.ts                        ~/.claude.json snapshot + burn-rate projection
│   ├── usage-refresh.ts                spawns `claude -p "/usage"` to keep it fresh
│   ├── env.ts                          every per-user path + the CLI's PATH
│   ├── reload-watcher.ts               mtime-driven self-restart
│   ├── spawn-capture.ts                spawn with a timeout and captured output
│   ├── warp-focus.ts                   warp://session, VS Code, cwd fallback
│   ├── warp-focus-mac.ts               osascript keystrokes
│   ├── warp-db.ts                      read-only sqlite3 → (window, tab_index)
│   ├── ask/                            queue, controller, key actions, detail strip, art
│   ├── launcher/                       Warp tab config, key art, the action
│   └── icons/                          theme, motifs, states, text, render, usage-icon
├── icons/                              reference SVGs, one per state (pnpm icons:render)
├── assets/svg/                         sources for the manifest PNGs (pnpm icons:static)
└── scripts/
    ├── build-profile.mjs               the bundled profile (run by pnpm build)
    ├── link-plugin.sh / unlink-plugin.sh / reload-plugin.sh
    ├── render-icons.mjs / render-static-pngs.mjs / render-deck-docs.mts
    ├── drill-states.ts                 paint every state on a real deck
    └── check-*.mts|mjs                 hermetic self-checks (CI runs these)
docs/                                   this file, development.md, warp-focus.md, deck-*.png
.github/workflows/                      ci.yml (every check) and release.yml (tags v*)
```
