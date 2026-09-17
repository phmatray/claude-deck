# Architecture

How the plugin discovers Claude Code sessions, derives state, and renders icons. This is reference material — for what the plugin *does*, see the top-level [`README.md`](../README.md).

## Session discovery

Claude Code drops one JSON file per running CLI session under `~/.claude/sessions/<pid>.json`. The plugin reads that directory once per second, batches a `kill -0 <pid>` check to filter out stale files, sorts the live sessions most-recent-event-first, and renders an SVG per Stream Deck slot via `setImage`.

When the plugin runs on a Windows host, two session directories are scanned in parallel:

- WSL sessions, read over a `\\wsl.localhost\<distro>\…` UNC path. PIDs are checked with `wsl.exe -d <distro> -- kill -0 <pid>`, batched into a single bash invocation.
- Windows-native sessions, read at `%USERPROFILE%\.claude\sessions`. PIDs are checked with one `tasklist.exe /NH /FO CSV` dump intersected in-process. (Per-PID `/FI "PID eq N"` filters AND together in tasklist — they don't OR — so per-PID filtering is impossible; one big dump is cheaper than N spawns.)

Each `SessionInfo` carries an `origin: "wsl" | "windows"` tag so the right liveness check is applied. A 10s `CACHE_FALLBACK_MS` absorbs transient empty/errored spawns without flickering keys to "finished".

### Slot ordering

There are routinely more live sessions than keys on the deck — an editor hosting Claude Code over ACP keeps one `claude` process per open thread, restored ones included — so the order decides what you actually get to see. Two groups:

1. **Blocked on you.** `awaiting_plan`, `awaiting_permission`, `awaiting_question`, `awaiting`, `error`, `bg_awaiting_permission`, `bg_awaiting` (`ATTENTION_STATES` in `src/state-tracker.ts`).
2. **Everything else.**

Within each group, `lastActivityAt` descending — the `ts` of the newest line in the session's event log, falling back to `startedAt` when there is no log yet, and to the json's `updatedAt` for bg agents, which never fire hooks.

The group split is not cosmetic. A session's event log stops growing the instant it starts waiting, while a working session appends a `PreToolUse`/`PostToolUse` pair every second or so; on recency alone the working session would always bury the one that needs you. Answering a prompt is seamless in the other direction: clearing the flag drops the session into group 2, where its now-newest event holds it in the same place.

A session promoted into `recentlyFinished` gets its `lastActivityAt` re-stamped to the moment of death. Without that the 3s green check would sink: `SessionEnd`'s hook unlinks the event log, so a cleanly-exited session falls back to `startedAt` — hours old, and off the bottom of a short deck.

Ties break on `startedAt` descending, then `pid` ascending.

### The view window

There are usually more sessions than keys, so the keys render a *window* onto the sorted list rather than its head. `createStateTracker` owns `viewOffset`; a short press calls `advanceView()`, which pages down by the visible slot count and wraps at the end. Each entry in the sliced window carries its absolute `slotNumber`, which is what the corner badge draws — the badge is the only feedback that a press landed, which is also why the short press does *not* call `showOk()` (the green overlay would cover the icon it is confirming).

The window resets to 0 when a session **newly** enters an `ATTENTION_STATES` state. Edge-triggered, not level-triggered: a session that simply keeps waiting must not re-snap the view every tick, because being able to page past it is exactly what you want while it waits. It also resets when `viewOffset` would fall past the end of a shrinking list. Nothing else moves it — page away from the top and the deck stays there until something needs you.

`tick`'s log line carries `view=<offset>/<total>`, and `maybeLog` dedups on the whole string, so the log records exactly the ticks where the window moved. The explicit tiebreak is load-bearing: sessions restored in one batch share a `SessionStart` ts to the millisecond, and relying on sort stability there would hand the order to `readOneSource`'s `Promise.all` push order, which varies per tick and would repaint every key for nothing.

Because slot identity can now change between two ticks, a key press pins the caption it was showing at `KeyDown` (`SlotState.pressedLabel` / `pressedBadge`); the kill target's pid was already captured in `onKeyDown`'s locals.

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

The `notification_type` discrimination requires hooks to capture CC's `notification_type` field into the NDJSON `notifType` column — both `notification.sh` and `notification.ps1` already do this. Older logs without `notifType` fall through to plain `awaiting` (catch-all), so the regression risk is bounded.

`PreToolUse` and `PostToolUse` are registered with **empty matcher** (catch-all), so the NDJSON gets one line per tool call. The reducer dispatches by `tool_name` — only `ExitPlanMode`, `AskUserQuestion`, and `TodoWrite` produce state transitions; other tools are no-ops. The trade-off is bigger logs (~1 line per Bash/Edit/Read), but `SessionStart` truncates so it stays bounded per CC run.

The catch-all matcher is load-bearing: `awaitingPermission` is cleared by *any* `PreToolUse`/`PostToolUse` mid-turn (`session-events.ts`), so a permission padlock only clears once a normal tool runs after approval. If a stale `settings.json` registers these tool-specific (the pre-`9dc606c` `ExitPlanMode`/`TodoWrite` matchers) instead, `PostToolUse[Bash]` never fires and the padlock stays stuck until the turn ends. `src/hook-check.ts` guards against exactly this: it verifies the catch-all registration at startup (and on Setup-key appear) and surfaces a warning rather than letting the plugin degrade silently.

To add a new state: register the event in `scripts/install-hook.sh`, add a case in `src/session-events.ts`, and an entry in the `STATES` registry at `src/icons/states.ts`. State priority (see `deriveState()` in `src/sessions.ts`): `finished` > `error` > `awaiting_plan` > `awaiting_permission` > `awaiting_question` > `awaiting` > `subagent` > `working` > `idle`. All `awaiting*` flags win over `busy` because CC keeps the session marked busy while waiting on the user.

`busy` itself is `rawStatus === "busy"` (the json's own `status` field) OR the reducer's in-turn projection. The fallback matters because `status` is absent from `<pid>.json` on some entrypoints — observed on `entrypoint: "sdk-ts"`, i.e. every SDK/ACP-hosted session — which would otherwise pin those sessions to the `idle` icon for their whole lifetime.

## Path / environment resolution

The plugin runs inside the Stream Deck app on Windows where neither `HOME` nor `WSL_DISTRO_NAME` is set. Rollup's `inject-build-env` plugin (in `rollup.config.mjs`) replaces two sentinels — `__BUILD_WSL_HOME__` and `__BUILD_WSL_DISTRO__` — at build time with whatever was live in the WSL build shell. At runtime, real env vars take precedence; the baked values are the fallback. `assertResolved` in `src/env.ts` throws if a sentinel survived (e.g. running an unbuilt module).

**All UNC and path math lives in `src/env.ts` — don't re-derive UNC paths inline elsewhere.**

| Env var | Used for | Override knob |
|---|---|---|
| `WSL_DISTRO_NAME` | UNC distro segment + `wsl.exe -d <distro>` | Set in the WSL build shell before `pnpm build` |
| `HOME` | WSL session dir, baked into UNC path | Set in the WSL build shell before `pnpm build` |
| `USERPROFILE` | Windows session dir + reload trigger | Provided by Windows; no override |

## Tick loop

`src/plugin.ts` runs two intervals against the same `state-tracker.ts` instance:

- **Slow tick (1s):** `tracker.tick()` re-reads sessions + liveness + event logs, computes the sorted `DisplayEntry[]`, and `renderAll()`s every slot. It then calls `renderUsage()` for the plan-usage keys — a no-op that costs nothing when none of them are on the deck. Re-entrancy guarded by `slowTickRunning`.
- **Animation tick (120ms):** advances `frame`, then renders only if `tracker.needsAnimation()` is true (an animated motif, or a pulsing in-progress todo — text never moves). Same guard pattern.

`createStateTracker()` owns the cross-tick bookkeeping: `prevLiveIds` (so a session is promoted to `finished` only when it was alive *last tick* — stale junk files from previous CC runs never appear) and `recentlyFinished` (carry-over for `FINISHED_TTL_MS = 3000`ms after death).

## Render pipeline

`SlotAction.orderedActions()` sorts visible action instances by Stream Deck `(row, column)` — that's what defines slot 1..N. `renderAll()` zips slots with `DisplayEntry[]`, calls `renderIcon()` to produce an SVG, base64-encodes a `data:image/svg+xml;base64,…` URL, and only calls `setImage` when the URL changed (per-slot dedup via `slotState.lastSvg`).

A key shows one meaning per line: the repo name on top (or the session name the user pinned, when `nameSource` isn't `"derived"`), the current branch below — a short SHA when HEAD is detached, nothing at all outside a repo. The repo name is truncated with an ellipsis when it overflows the 124px viewport — nothing scrolls, because a key is glanced at rather than read and a moving line makes you wait for the part you need. The branch gets one more option first: if it doesn't fit on one line at 17px but does at 15px, it renders whole at the smaller size; only if it still overflows does it wrap onto two 15px lines (breaking after `/` or `-`, never mid-word), with the motif shrinking to make room. `overflows()` is the single width check all three paths share, so they can't disagree; `fitText()` then cuts flush to the band, since `approxWidth()` is a per-char estimate that underruns on wide glyphs. A clip on each line is the backstop for that estimate: on a pathological string (`WWWW…`) the text is cut at both ends and the ellipsis falls off-screen, which is the intended degradation. Claude Code's own derived name is `<cwd basename>-<suffix>`; the suffix is demoted to a top-left badge, sharing that corner with the `bg` tag, because it's the only thing distinguishing two sessions running in the same worktree.

Repo and branch come from `src/git-info.ts`, which reads git's plumbing (`.git/HEAD`, plus `gitdir:`/`commondir` for linked worktrees) instead of spawning `git` — the slow tick runs once a second across every live session. Both the cwd→repo resolution and the parsed HEAD are memoised, the latter gated on (mtime, size) like the caches in `sessions.ts`, and pruned against the live session set. Every path first goes through `localPathForOrigin()` in `env.ts`: a WSL session records `/home/u/proj`, which the Windows-side plugin can only open as `\\wsl.localhost\<distro>\home\u\proj`. Anything unreachable degrades to "no branch line" rather than throwing.

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
throttle by a key press, `icons/usage-icon.ts` draws a static tile per window, and
`usage-action.ts` dedups by SVG exactly as `renderAll()` does.
No motif, no animation — the brief was a quiet stepped colour scale. See the
"Plan usage keys" section of `CLAUDE.md` for the payload's sharp edges (ISO vs
epoch resets, `utilization` vs `percent`, model- vs surface-scoped entries).

## Reload trigger

`pnpm watch` and `pnpm sd:reload` both `touch ~/.claude/.streamdeck-claude.reload`. The plugin polls the file's mtime each second; when it changes, the plugin calls `process.exit(0)` and the Stream Deck app respawns it (this is the SD app's normal crash-recovery behaviour, repurposed). `PROCESS_START_MS` guards against looping on startup if the trigger file already exists.

The Elgato `streamdeck restart` / `streamdeck list` commands fail from WSL with `EIO` because they `readlink` a UNC-targeted symlink — use `pnpm sd:reload` instead. The first time after building you still need to quit + relaunch the SD app once, since the *currently-running* bundle doesn't yet know how to self-reload.

## Hook pipeline

Two thin hook scripts mirror each other:

- `hooks/notification.sh` — Bash, called by Claude Code on Linux/macOS/WSL.
- `hooks/notification.ps1` — PowerShell, called by Claude Code on Windows.

Both do exactly one thing: read the hook payload from stdin, extract `session_id` + `hook_event_name` (+ optional `tool_name`), and append a single JSON line — `{"ts":…,"event":…,"tool":…?}` — to `<sessionId>.events.ndjson` next to that side's session JSON files. `SessionStart` truncates the log first; `SessionEnd` unlinks it.

The Windows hook is **not copied** — `scripts/install-hook.sh --target=windows` registers a PowerShell command that runs `hooks/notification.ps1` directly over `\\wsl.localhost\<distro>\…\hooks\notification.ps1`, so a single repo edit propagates to both sides. PID liveness handles the case where a CC process dies hard (no `SessionEnd`): the session disappears from display via `state-tracker.ts`'s `prevLiveIds` check, and the orphan event log is cleaned the next time CC reuses that sessionId (`SessionStart` truncate).

## Project layout

```
.
├── com.julien.claudesessions.sdPlugin/   # canonical Elgato plugin folder
│   ├── manifest.json
│   ├── bin/plugin.js                     # built bundle
│   ├── imgs/                             # static manifest icons
│   ├── ui/                               # property inspector HTML
│   └── assets/clawd/                     # AGPL-3.0 mascot SVGs (see NOTICE.md)
├── src/
│   ├── plugin.ts                         # entry, polling loop
│   ├── slot-action.ts                    # per-slot SingletonAction
│   ├── setup-action.ts                   # maintenance key (wipe logs + refresh)
│   ├── sessions.ts                       # reads ~/.claude/sessions/
│   ├── live-pids.ts                      # batched kill -0 / tasklist liveness
│   ├── session-events.ts                 # pure state machine
│   ├── state-tracker.ts                  # cross-tick bookkeeping
│   ├── render-loop.ts                    # zip slots → setImage
│   ├── usage.ts                          # reads ~/.claude.json usage snapshot
│   ├── usage-action.ts                   # the three plan-usage keys
│   ├── usage-refresh.ts                  # spawns `claude -p "/usage"` to refresh it
│   ├── env.ts                            # all path/UNC math + the CLI's PATH (single source)
│   ├── reload-watcher.ts                 # mtime-driven self-restart
│   ├── warp-focus.ts                     # platform dispatcher
│   ├── warp-focus-mac.ts                 # osascript activate + Cmd+digit / cycle
│   ├── warp-focus-win.ts                 # PowerShell + AttachThreadInput + SendInput
│   ├── warp-db.ts                        # read-only sqlite3 → (window, tab_index)
│   ├── warp-cwd.ts                       # Windows UNC / drive normalizer for WSL paths
│   └── icons/                            # render pipeline (theme/motifs/states/text/render/usage-icon)
├── icons/                                # standalone reference SVGs (one per state)
├── hooks/
│   ├── notification.sh                   # Bash hook (Linux/macOS/WSL)
│   └── notification.ps1                  # PowerShell hook (Windows)
└── scripts/
    ├── install-hook.sh                   # merge hook into ~/.claude/settings.json
    ├── link-plugin.sh                    # Windows symlink (mklink /D over UNC target)
    ├── unlink-plugin.sh                  # remove the symlink
    ├── reload-plugin.sh                  # touch the reload trigger
    ├── render-icons.mjs                  # regenerate icons/*.svg from src/icons/
    └── render-static-pngs.mjs            # rasterize manifest PNGs from assets/svg/
```
