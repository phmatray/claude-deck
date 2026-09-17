# streamdeck-claude

> A Stream Deck plugin that mirrors live [Claude Code](https://github.com/anthropics/claude-code) CLI session state on as many keys as you assign it.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#compatibility)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)
[![Stream Deck](https://img.shields.io/badge/Stream%20Deck-%E2%89%A56.5-black.svg)](https://www.elgato.com/stream-deck)

Each running `claude` CLI session lights up one key on your deck — project name, current state, animated when it's working, pulsing when it needs you. Sessions are ordered so whatever needs you sits on the first key; press a key to page through the rest when there are more sessions than keys.

## State gallery

| | State | Meaning |
|---|---|---|
| <img src="icons/working.svg" width="64" alt="working"> | `working` | Claude is generating / running tools |
| <img src="icons/subagent.svg" width="64" alt="subagent"> | `subagent` | Claude has delegated to a subagent (parent waiting) |
| <img src="icons/idle.svg" width="64" alt="idle"> | `idle` | Claude is waiting for your next prompt |
| <img src="icons/awaiting.svg" width="64" alt="awaiting"> | `awaiting` | Permission prompt — your turn |
| <img src="icons/awaiting_plan.svg" width="64" alt="awaiting_plan"> | `awaiting_plan` | `ExitPlanMode` was called — plan approval pending |
| <img src="icons/error.svg" width="64" alt="error"> | `error` | Last turn failed (rate limit / auth / server error) |
| <img src="icons/finished.svg" width="64" alt="finished"> | `finished` | Session just ended (visible ~3 s, then drops) |
| <img src="icons/empty.svg" width="64" alt="empty"> | `empty` | No session in this slot |

## Features

- **Live per-session state** — sessions auto-fill the slots in start-time order; excess sessions beyond the slot count are simply not displayed.
- **Press → bring that session's terminal to the front.** The hook records the Warp pane each CLI runs in (`WARP_TERMINAL_SESSION_UUID`), so the press opens `warp://session/<uuid>` — the exact pane, even for `claude --worktree` sessions that share a tab cwd, and without Accessibility permission. VS Code sessions get their window. Logs written before the uuid was recorded fall back to the cwd → Warp tab heuristic. Keys are ordered "needs you first, then most recently active" (see [`docs/architecture.md`](../docs/architecture.md#slot-ordering)); give the plugin more slots than you run sessions.
- **Repo and branch on the key** — top line is the repository, bottom line the branch it's checked out on (a short SHA if HEAD is detached); the repo name is truncated with an ellipsis when too long, and a branch that doesn't fit wraps onto two lines instead. Sessions sharing a worktree are told apart by a small top-left suffix badge.
- **Long-press (≥500 ms) → reset that session's state log** — useful if a stuck `awaiting` lingers.
- **Plan usage keys** — three optional keys mirror your Claude subscription's rate limits: the 5-hour session window, the weekly all-models window, and whatever per-model weekly buckets the server reports (labelled with the server's own names). Colour steps quietly green → amber → orange → red, and the footer counts down to the reset. Read straight from the usage snapshot Claude Code caches in `~/.claude.json` — no credentials, no network call. The plugin keeps that snapshot fresh by running `claude -p "/usage"` every few minutes (a local slash command, no model turn) since Claude Code otherwise only refetches when something asks to see usage. Press any of them to force a refresh.
- **Setup key** — wipes all event logs and re-renders every slot in one press. Also self-checks the hook registration: if it's stale or missing (icons would silently break — e.g. a permission padlock that never clears), the key shows an amber **HOOKS** warning. Fix with `claude plugin install claude-deck@phmatray`, then reload.

## Compatibility

| | Support |
|---|---|
| **Stream Deck app** | macOS 12+ (Stream Deck app ≥ 6.5) |
| **Claude CLI host** | the same Mac |
| **Node.js** | ≥ 20 (bundled into the plugin runtime by the Stream Deck app) |
| **Terminal integration** | Warp exact pane via `warp://session/<uuid>`; VS Code window; cwd → Warp tab fallback |

## Install

Prereqs: [pnpm](https://pnpm.io), `jq`, `perl`, Node.js 20+, an Elgato Stream Deck with the SD app installed.

```bash
pnpm install
pnpm build
claude plugin install claude-deck@phmatray   # the hooks ship in the Claude Code plugin (see ../README.md)
pnpm sd:link             # symlink .sdPlugin into ~/Library/Application Support/com.elgato.StreamDeck/Plugins/
pnpm sd:validate
# Quit + relaunch the Stream Deck app so it picks up the new plugin.
```

A short press focuses the session's terminal. For Warp, the `warp://session` path needs no extra permission; the cwd-to-tab fallback sends a System Events keystroke, which needs Stream Deck.app under System Settings → Privacy & Security → Accessibility.

The "Claude Sessions" category appears in the action list.

## Usage

Drag **Claude Session Slot** onto as many keys as you want to dedicate to live sessions. The plugin orders them by deck position (top-to-bottom, left-to-right). Optionally, drag the **Claude Setup** action onto one more key as a maintenance button.

Run `claude` in a terminal — the first slot fills with the project name, amber while working, blue when idle. Open `claude` in another `cwd` and slot 2 lights up.

For plan limits, drag **Claude Usage: Session (5h)**, **Claude Usage: Week (all models)** and **Claude Usage: Week (per model)** onto up to three more keys. The numbers come from the snapshot Claude Code caches in `~/.claude.json`. That cache is refetched only when something asks to see usage, which a GUI- or SDK-hosted session never does, so the plugin refreshes it itself every 5½ minutes by running `claude -p "/usage"` in a directory of its own (`~/.claude/.claude-deck-usage`) — that dedicated path is how the plugin recognises and hides the ~3-second session the refresh creates, instead of flashing a phantom key. Refreshing only happens while at least one usage key is on the deck. The plugin adds the usual install directories to that child's `PATH`, and falls back to your login shell if that still doesn't find the binary — the Stream Deck app inherits launchd's environment, not your shell's, so a `claude` in `~/.local/bin` (or under a node version manager) is otherwise invisible to it. An amber dot in the corner flags a reading older than 15 minutes. The reset countdown is unaffected by that (it is an absolute timestamp) and keeps ticking; the footer only falls back to stating the snapshot's age when there is no future reset left to show. Pressing any of the three forces a refresh of all of them, past that 5½-minute throttle — which is what you want once a reading has gone stale. The key answers back: a tick means you are looking at the freshest reading obtainable (Claude Code refuses to rewrite a snapshot under five minutes old, so a press inside that window legitimately cannot move the number), an alert means the refetch failed or is taking too long to wait for.

## Development

```bash
pnpm watch                    # rebuild + auto-reload the plugin on each change
pnpm sd:reload                # touch the reload trigger to respawn the plugin (~1 s)
```

Logs land at `~/Library/Logs/ElgatoStreamDeck/com.phmatray.claudedeck.sdPlugin/`. Full script reference and verification checklist in [`docs/development.md`](../docs/development.md).

## Documentation

- [`docs/architecture.md`](../docs/architecture.md) — session discovery, hook event → state machine, path resolution, render pipeline
- [`docs/development.md`](../docs/development.md) — full pnpm scripts, end-to-end verification, tweaks
- [`docs/warp-focus.md`](../docs/warp-focus.md) — Warp focus internals (the cwd → tab fallback behind a short press) and failure modes

## License

Code is MIT — see [`LICENSE`](../LICENSE).
