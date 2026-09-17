# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Stream Deck plugin that mirrors live Claude Code CLI session state on up to N keys. Code paths below (`src/`, `scripts/`, `icons/`, the `.sdPlugin` folder) are relative to `stream-deck/`, the Stream Deck plugin; `claude-code/` (the Claude Code plugin: hooks, `claude-ask`, `claude-permission`, skill), `docs/` and `.claude/` sit at the repo root. The runtime is a single Node process (`com.phmatray.claudedeck.sdPlugin/bin/plugin.js`) launched by the host Stream Deck app. **macOS only**: the plugin folder is symlinked into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`. README.md covers setup and the user-visible behaviour — read it before changing anything in `scripts/` or `claude-code/hooks/`.

## Common commands

Use **pnpm** (not npm/npx) — see global memory.

```bash
pnpm build              # rollup → com.phmatray.claudedeck.sdPlugin/bin/plugin.js (terser in prod, sourcemaps in watch)
pnpm watch              # rollup -w + auto-touches the reload trigger after each rebuild
pnpm sd:reload          # touch ~/.claude/.claude-deck.reload → plugin self-exits → SD app respawns it (~1s)
pnpm sd:validate        # @elgato/cli validate manifest + assets
pnpm sd:link / sd:unlink           # (re)create the symlink into Plugins/
bash ../scripts/probe-hooks.sh     # is the installed claude-deck Claude Code plugin registering every hook? (reads the real ~/.claude)
pnpm icons:render       # regenerate icons/*.svg reference assets from src/icons/
pnpm icons:static       # rasterize manifest PNGs from assets/svg/ via @resvg/resvg-js
```

There is **no test framework and no lint script**. Verify by `pnpm build && pnpm sd:validate`, the assert-based `scripts/check-*.mts` (`pnpm exec tsx scripts/check-<name>.mts`), then `pnpm sd:reload` and watch logs at `~/Library/Logs/ElgatoStreamDeck/com.phmatray.claudedeck.sdPlugin/`.

First time after building, you still need to quit + relaunch the SD app once so the new bundle picks up the reload-watcher.

## Architecture

### Sessions and liveness

Claude Code drops `~/.claude/sessions/<pid>.json` per running CLI session. `src/sessions.ts` reads that one directory; `src/live-pids.ts` checks each pid in-process with `process.kill(pid, 0)` (no throw or `EPERM` = alive, `ESRCH` = dead). bg agents skip the pid check (shared daemon pid) and are judged on `updatedAt` freshness.

### Path resolution (`src/env.ts`)

Every per-user path is derived from `os.homedir()` in `env.ts` (sessions dir, settings.json, `~/.claude.json`, reload trigger, usage refresher cwd) — don't re-derive them elsewhere. `homedir()` honours `HOME`, so check scripts run against a temp home.

### Tick loop (`src/plugin.ts`)

Two intervals share the same `state-tracker.ts` instance:

- **Slow tick (1s):** `tracker.tick()` re-reads sessions + liveness + notify/plan files, computes the sorted `DisplayEntry[]`, and `renderAll()`s every slot. Re-entrancy guarded by `slowTickRunning`.
- **Animation tick (120ms):** advances `frame`, then renders only if `tracker.needsAnimation()` is true (an animated motif, or a pulsing in-progress todo — text never moves). Same guard pattern.

`createStateTracker()` owns the cross-tick bookkeeping: `prevLiveIds` (so a session is promoted to `finished` only when it was alive *last tick* — stale junk files from previous CC runs never appear) and `recentlyFinished` (carry-over for `FINISHED_TTL_MS = 3000`ms after death).

State priority for an idle session: `awaiting_plan` > `awaiting` > plain `idle`. See `deriveState()` in `sessions.ts`.

### Render pipeline (`src/render-loop.ts` + `src/icons/`)

`SlotAction.orderedActions()` sorts visible action instances by Stream Deck `(row, column)` — that's what defines slot 1..N. `renderAll()` zips slots with `DisplayEntry[]`, calls `renderIcon()` to produce an SVG, base64-encodes a `data:image/svg+xml;base64,…` URL, and only calls `setImage` when the URL changed (per-slot dedup via `slotState.lastSvg`). The focus target a press uses (`cwd`, Warp pane, terminal program) is refreshed every tick regardless.

Icon code is split per concern across `src/icons/`: `theme.ts` (constants), `motifs.ts` (animated SVG fragments per state), `states.ts` (the single `STATES` registry mapping each `SessionState` to palette + motif + animated flag), `text.ts` (width estimation + wrapping + truncation), `render.ts` (compose the final SVG). Adding a new state = one entry in `STATES` + plumb it through `deriveState`.

Each key carries one meaning per section: repo name on top (truncated with an ellipsis when it overflows — nothing scrolls), current branch below (truncated the same way, or wrapped onto two lines first if a smaller size alone won't fit it), plus a top-left badge holding the `bg` tag and/or Claude Code's derived name suffix (`b7`) — the only thing telling apart two sessions in the same worktree. Repo/branch come from `src/git-info.ts`, which reads `.git/HEAD` directly (no `git` spawn) and caches on (mtime, size) like the session caches.

### Plan usage keys (`src/usage.ts`, `src/usage-refresh.ts`, `src/icons/usage-icon.ts`, `src/usage-action.ts`)

Three optional keys mirror the Claude subscription's rate-limit windows: the 5-hour
session window, the weekly all-models window, and the per-model weekly windows
(whatever buckets the server emits — "Fable", "Opus", … — never hardcoded).

The data source is **`~/.claude.json` → `cachedUsageUtilization`**, where Claude Code
parks the verbatim `/api/oauth/usage` payload it fetched. Reading that file means no
credentials, no network call and no undocumented HTTP from the plugin.
`readUsageSnapshot()` gates re-parsing on the file's mtime — the blob is ~250KB and
only the usage slice matters.

**That cache does not refresh itself.** Claude Code refetches only when something asks
to *see* usage (startup, `/usage`, the status line, a limit warning); an SDK/GUI-hosted
session asks for none of those, and the snapshot was measured sitting untouched through
25+ minutes of continuous work. So `usage-refresh.ts` asks on our behalf: it spawns
`claude -p "/usage"` whenever the snapshot is older than 5½ minutes, which runs the
slash command locally (no model turn, ~3s) and writes the refreshed snapshot back.
The 5½ is deliberate — Claude Code refuses to rewrite a snapshot under 5 minutes old,
and landing exactly on that floor would no-op every other round. It only runs when a
usage key is actually on the deck.

**The child gets its PATH from `envWithCliPath()`, not from the plugin's own.** The
Stream Deck app is launched by launchd, which hands it the bare system PATH — no
shell rc has ever run in that process — so the native installer's `~/.local/bin` is
simply absent and the spawn dies with `spawn claude ENOENT`. That was live on macOS
for days: `warnOnce` said it once and then nothing, while the keys sat on a snapshot
45 minutes old and the press path (below) had no way to say so either. `CLI_DIRS` in
`env.ts` prepends `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. An
npm-global install under a node version manager (mise, nvm, fnm, volta) lands in a
version-scoped directory none of those can guess, so an ENOENT retries once through
`$SHELL -ilc`, asking the user's own shell where the binary is. The `-i` is load-
bearing: zsh sources `.zshrc` only for interactive shells, and `.zshrc` is where a
PATH export overwhelmingly lives — `-lc` alone was measured returning "not found" on
a machine where `-ilc` resolves it. It costs the rc's startup (~2.9s), paid only on a
path that is otherwise a guaranteed failure.

Two things about *how* it is driven. It rides the slow tick rather than owning an
interval, because action instances are filled in by `willAppear`, which arrives after
`connect()` resolves — anything checking "is a usage key on the deck?" at startup reads
an empty list and skips, so the first refresh would be a whole cycle late. And the tick
does not await it: the child takes ~3s, which would hold `slowTickRunning` and freeze
every session key for that long.

Both gates matter *for the tick*: the snapshot's age decides whether a refresh is
*worth* asking for, and the time of the last spawn decides whether we are *allowed*
to ask. Without the second, an account with no snapshot at all — or a child that
exits 0 without refreshing — leaves the age gate permanently open, and the tick
relaunches the moment the previous child exits: a spawn every ~3s, forever.

A key press is the one caller that skips the attempt gate — `refreshUsageCache()`
with `force` — and it skips only that one. The tick runs every second, so it claims the
attempt slot within ~1s of the snapshot ageing past 5½ minutes — which leaves a human
press a sub-second window to land in, i.e. none in practice; before this the press
path was unreachable. Skipping the attempt gate makes the press useful exactly where
the tick is useless: after a failed or wedged refresh, where the key would otherwise
sit on a frozen number for the next 5½ minutes. It does **not** skip the age gate —
under Claude Code's rewrite floor a refetch could only no-op, and forcing one would
make the "exited 0 but untouched" check below cry wolf. The single exception is the
no-snapshot account above: the age gate cannot close there, so the press honours the
attempt throttle instead, which is the only bound left on it.

Because a press often cannot legitimately move the number, it always answers on the
key. `refreshUsageCache()` returns `"refreshed" | "current" | "failed"` rather than a
boolean, and `usage-action.ts` turns that into `showOk()` / `showAlert()` — without
it the tile renders byte-identical, the SVG dedup swallows the repaint, and the press
looks broken, which is the whole reason the flag exists. A caller landing on top of
an in-flight attempt is handed that attempt's promise, so it reports what actually
happened rather than guessing. The press stops waiting after `VERDICT_TIMEOUT_MS`
(12s) and says so, but never cancels the child: killing it would make a merely slow
`claude` fail permanently, since the attempt throttle would then hold the tick off
for 5½ minutes as well.

Exit code 0 is not proof of a refresh. `claude -p "/usage"` returns 0 even when it never
reaches the API (reproduced with a stripped environment: "Total duration (API): 0s",
snapshot untouched). Since we only spawn past Claude Code's rewrite floor, a
`fetchedAtMs` that has not moved means the refresh did not happen — that is the success
signal, and it warns instead of leaving the keys on a frozen number in silence.

The refresher's own session file is the catch: the CLI writes it as
`kind:"interactive"` like any other, and with `lastActivityAt` of "now" it would sort
to the top of the non-attention group and shove every key down a slot for ~3s. It runs
in `USAGE_REFRESH_DIR` (`~/.claude/.claude-deck-usage`) purely so `sessions.ts` can
recognise its `cwd` and drop it (the pre-rename `~/.claude/.streamdeck-usage` is
still hidden for one release).

Staleness on the tile: `fetchedAtMs` past 15 minutes raises a corner dot, warning that
the *percentage* may lag. The reset countdown is never suppressed for age — `resets_at`
is an absolute timestamp and stays true — so the footer only states the snapshot's age
when there is no future reset left to count down to.

Note the shape differences that bite: `resets_at` is an **ISO string** here (the
statusLine payload uses epoch seconds), named windows carry `utilization` while
`limits[]` entries carry `percent`, and `limits[]` entries may be scoped to a
`surface` rather than a `model` — only model-scoped ones belong on the per-model key.
Windows that don't apply to the account come back as `null`, so every field is
optional and unknown/renamed windows fall out silently.

### Terminal focus on slot press (`src/warp-focus*.ts`, `src/warp-db.ts`)

A short press on a slot brings the session's terminal forward (`focusSession` in `warp-focus.ts`): `warp://session/<uuid>` when the hook recorded the Warp pane, the VS Code window for VS Code sessions, else the cwd → Warp tab fallback (`warp-db.ts` reads Warp's SQLite DB, `warp-focus-mac.ts` sends the tab keystroke through osascript). See `docs/warp-focus.md`.

### Reload trigger (`src/reload-watcher.ts`)

`pnpm watch` and `pnpm sd:reload` both `touch ~/.claude/.claude-deck.reload`. The plugin polls the file's mtime each second; when it changes, the plugin calls `process.exit(0)` and the SD app respawns it (this is the SD app's normal crash-recovery behaviour, repurposed). `PROCESS_START_MS` guards against looping on startup if the trigger file already exists.

### Hook pipeline (`claude-code/hooks/`)

Every registered Claude Code event runs the same hook script (`claude-code/hooks/notification.sh`, registered by `claude-code/hooks/hooks.json`). It does exactly one thing: append a single JSON line — `{"ts":…,"event":…,"tool":…?}` — to `~/.claude/sessions/<sid>.events.ndjson`. There is no mapping table. `SessionStart` truncates the log first (clean reset, bounds long-lived sessions); `SessionEnd` unlinks it.

The plugin reads each session's event log every tick and replays it through the pure state machine in `src/session-events.ts` (`reduceEvents`). That function is the single source of truth for state transitions — adding a new state means one new case there plus registering the event in `claude-code/hooks/hooks.json`. No `events.json`, no per-state sidecar files, no mtime/TTL/grace heuristics.

PID liveness still handles the case where a CC process dies hard (no `SessionEnd`): the session disappears from display via `state-tracker.ts`'s `prevLiveIds` check, and the orphan event log is cleaned the next time CC reuses that sessionId (`SessionStart` truncate).

## Conventions worth knowing

- TypeScript ESM (`"type": "module"`), Node 20, `strict: true`. Source is `src/**/*.ts`, output is `com.phmatray.claudedeck.sdPlugin/bin/plugin.js` (single bundled file via rollup).
- Imports use the `.js` extension even for `.ts` files (NodeNext-style). Don't drop the extension.
- Stream Deck actions (all declared in the manifest, registered in `src/plugin.ts` in manifest order) include `com.phmatray.claudedeck.slot` (one key per live CC session, in `src/slot-action.ts`), `com.phmatray.claudedeck.setup` (a single maintenance key, in `src/setup-action.ts`), and `com.phmatray.claudedeck.usage.{session,week,models}` (the plan-usage keys, three thin subclasses in `src/usage-action.ts`); the answer keys `ask.*` live in `src/ask/`, the launcher in `src/launcher/`. All use the `@action({ UUID: "..." })` decorator AND must be passed to `streamDeck.actions.registerAction(...)` — the decorator alone is not enough.
- The Setup action's key press (and its property inspector "Refresh States" button) calls `refreshNow()` in `plugin.ts`, which `wipeAllEventLogs()` (deletes every `<sid>.events.ndjson` in the sessions dir) then runs an immediate `runSlowTick()`. The PI uses raw WebSocket against the Elgato bridge (`connectElgatoStreamDeckSocket`) — the SDK's TS API is plugin-side only.
- Stream Deck SDK notes (registration, manifest gotchas, build-info) live in `docs/development.md`; session-introspection internals (the `<pid>.json` schema, liveness, hook patterns) are in the local skill `claude-code-process-introspection` (`.claude/skills/`). Invoke it via the `Skill` tool when relevant.
- `docs/` holds reference notes (`architecture.md`, `development.md`, `warp-focus.md`).
