# Warp: focusing a tab, and opening one

macOS only, like the rest of the plugin. Two things go through Warp: a slot press
brings an existing session's tab to the front (below), and the launcher key opens a
new one ([at the end](#opening-a-tab-the-launcher-key)).

## Focusing the session's tab

Pressing a slot brings the session's terminal to the front. When the hook recorded the Warp pane (`WARP_TERMINAL_SESSION_UUID`) the plugin opens `warp://session/<uuid>`; VS Code sessions get their window. Otherwise it falls back to the cwd → Warp tab heuristic described here — best-effort, silent on failure.

### Why it's "best-effort"

Warp exposes no public API for focusing a tab by cwd: no AppleScript dictionary ([warpdotdev/Warp#3364](https://github.com/warpdotdev/Warp/issues/3364)), no URL action verb yet ([warpdotdev/Warp#8611](https://github.com/warpdotdev/Warp/issues/8611)), no CLI subcommand. Its accessibility tree is empty too. So the plugin reads Warp's local SQLite DB to map `cwd → (window_id, tab_index)`, then synthesises a per-tab keystroke (`Cmd+<digit>`) to land on the right tab.

This works for ~95 % of single-window setups. Multi-window setups are best-effort: the keystroke goes to whichever Warp window the OS raises first.

### Matching algorithm

For each pane row in the DB, score it against the requested `cwd`:

- exact match → highest priority
- `cwd` is a prefix of `paneCwd` → next
- shared path components → fallback (token overlap)

The highest-scoring pane wins. Ties at the **exact (1000)** and **prefix/parent (500)** levels resolve deterministically to the lowest `(window_id, tab_index)` — i.e. the leftmost matching tab — rather than giving up. (This matters for monorepo subdirs: when a session sits in `…/repo/sub` but Warp hasn't yet flushed that pane's exact cwd, only the parent `…/repo` may be in the DB, open in several tabs; refusing there caused intermittent silent no-ops.) Only pure **token-overlap** ties have no canonical winner and are dropped silently. If nothing scores above zero, the plugin gives up silently.

**Tab order is not a concern:** Warp renumbers tab `id`s on every drag-reorder so `id` order always tracks the visual tab strip — `tab_index` (derived from `ROW_NUMBER() OVER (ORDER BY id)`) therefore matches `Cmd+<digit>` positions even after reordering.

**Same dir in two tabs is ambiguous:** Warp exposes no link between an OS process and a pane (no inherited `WARP_SESSION_ID`, no PID in the DB), so cwd is the only join key. When a dir is open in 2+ tabs, the plugin picks the leftmost — it cannot know which one runs *your* session.

Implementation: `src/warp-db.ts` (read + score), `src/warp-focus-mac.ts` (keystrokes), `src/warp-focus.ts` (entry point).

### macOS

**DB path:** `~/Library/Group Containers/2BBY89MBSN.dev.warp/Data/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` (read-only via `sqlite3` CLI).

**Tab keystroke:**
- Tabs 1–9: `Cmd+<digit>` via `osascript` + System Events.
- Tabs 10+: `Cmd+Option+→` / `Cmd+Option+←` cycling, computing the shorter direction from the currently active tab.

**Permissions:** macOS prompts on the first call to allow **Stream Deck** under *System Settings → Privacy & Security → Accessibility*. If you decline, only this cwd fallback is skipped; `warp://session/<uuid>` needs no permission.

### Failure modes

All of the following are silent — focus is just skipped:

| Reason | What it looks like in logs |
|---|---|
| Warp not running | `db-empty` or `warp-not-running` |
| Accessibility denied | `keystroke-failed: …(-1719)` |
| No matching pane | `no-match (rows=N, top=[w1t2@500:"…", …])` — the `top=` list shows the best-scoring panes + scores to diagnose ties / stale cwds |
| Multi-window, tab > 9 | succeeds but may target the wrong window — the plugin warns in the log |

## Opening a tab: the launcher key

The other direction, and a different mechanism. Warp reads **Tab Configs** from
`~/.warp/tab_configs/<stem>.toml`, and `warp://tab_config/<stem>` opens a tab in the
focused window with that config's directory and commands — which is what lets the key
actually run `claude`, where `warp://action/new_tab?path=…` only changes directory.

The launcher key owns the file. It writes
`~/.warp/tab_configs/claude_deck_<basename>_<6 hex of the absolute path>.toml` whenever
its settings change (and re-checks it on press), rewriting only when the content
differs:

```toml
# Written by Claude Deck (Stream Deck launcher key). Edits are overwritten.
name = "Claude Deck · claude-deck"

[[panes]]
id = "main"
type = "terminal"
directory = "/Users/me/repo/claude-deck"
commands = ["claude"]
```

There is no `is_focused`: that field belongs to Warp's *Launch Config* schema, and
Warp's own generated tab configs do not carry it.

The hash in the stem keeps two checkouts of the same repo name from overwriting each
other's config. `newWindow` appends `?new_window=true` to the URI. Everything is escaped
through `JSON.stringify`: TOML basic strings and JSON strings agree on `\"`, `\\` and
`\uXXXX`, which covers every path and command a user can type.

Failure is quiet by design on Warp's side — a config it cannot deserialise is ignored
and `open` still exits 0 — so the writer keeps the file to the fields Warp's own
generated configs carry, and the key alerts on anything it *can* see: no directory
configured, a relative path, a failed write, a non-zero `open`.
