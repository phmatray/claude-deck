# Warp tab focus

Pressing a slot brings the session's terminal to the front. When the hook recorded the Warp pane (`WARP_TERMINAL_SESSION_UUID`) the plugin opens `warp://session/<uuid>`; VS Code sessions get their window. Otherwise it falls back to the cwd → Warp tab heuristic described here — best-effort, silent on failure.

## Why it's "best-effort"

Warp exposes no public API for focusing a tab by cwd: no AppleScript dictionary ([warpdotdev/Warp#3364](https://github.com/warpdotdev/Warp/issues/3364)), no URL action verb yet ([warpdotdev/Warp#8611](https://github.com/warpdotdev/Warp/issues/8611)), no CLI subcommand. Its accessibility tree is empty too. So the plugin reads Warp's local SQLite DB to map `cwd → (window_id, tab_index)`, then synthesises a per-tab keystroke (`Cmd+<digit>`) to land on the right tab.

This works for ~95 % of single-window setups. Multi-window setups are best-effort: the keystroke goes to whichever Warp window the OS raises first.

## Matching algorithm

For each pane row in the DB, score it against the requested `cwd`:

- exact match → highest priority
- `cwd` is a prefix of `paneCwd` → next
- shared path components → fallback (token overlap)

The highest-scoring pane wins. Ties at the **exact (1000)** and **prefix/parent (500)** levels resolve deterministically to the lowest `(window_id, tab_index)` — i.e. the leftmost matching tab — rather than giving up. (This matters for monorepo subdirs: when a session sits in `…/repo/sub` but Warp hasn't yet flushed that pane's exact cwd, only the parent `…/repo` may be in the DB, open in several tabs; refusing there caused intermittent silent no-ops.) Only pure **token-overlap** ties have no canonical winner and are dropped silently. If nothing scores above zero, the plugin gives up silently.

**Tab order is not a concern:** Warp renumbers tab `id`s on every drag-reorder so `id` order always tracks the visual tab strip — `tab_index` (derived from `ROW_NUMBER() OVER (ORDER BY id)`) therefore matches `Cmd+<digit>` positions even after reordering.

**Same dir in two tabs is ambiguous:** Warp exposes no link between an OS process and a pane (no inherited `WARP_SESSION_ID`, no PID in the DB), so cwd is the only join key. When a dir is open in 2+ tabs, the plugin picks the leftmost — it cannot know which one runs *your* session.

Implementation: `src/warp-db.ts` (read + score), `src/warp-focus-mac.ts` (keystrokes), `src/warp-focus.ts` (entry point).

## macOS

**DB path:** `~/Library/Group Containers/2BBY89MBSN.dev.warp/Data/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` (read-only via `sqlite3` CLI).

**Tab keystroke:**
- Tabs 1–9: `Cmd+<digit>` via `osascript` + System Events.
- Tabs 10+: `Cmd+Option+→` / `Cmd+Option+←` cycling, computing the shorter direction from the currently active tab.

**Permissions:** macOS prompts on the first call to allow **Stream Deck** under *System Settings → Privacy & Security → Accessibility*. If you decline, only this cwd fallback is skipped; `warp://session/<uuid>` needs no permission.

## Failure modes

All of the following are silent — focus is just skipped:

| Reason | What it looks like in logs |
|---|---|
| Warp not running | `db-empty` or `warp-not-running` |
| Accessibility denied | `keystroke-failed: …(-1719)` |
| No matching pane | `no-match (rows=N, top=[w1t2@500:"…", …])` — the `top=` list shows the best-scoring panes + scores to diagnose ties / stale cwds |
| Multi-window, tab > 9 | succeeds but may target the wrong window — the plugin warns in the log |
