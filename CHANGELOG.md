# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 3.0.0 belong to the two upstream projects this one merges; their history
is in this repository, but their release notes are not.

## [3.0.0] — 2026-09-18

The first release of Claude Deck as one project. Two Stream Deck plugins and a set of
hook commands copied into `settings.json` become **one Stream Deck plugin and one Claude
Code plugin**. Read [Upgrading from the two-plugin setup](README.md#upgrading-from-the-two-plugin-setup)
before installing over a 2.x install: two scripts move your keys and your settings over,
both backing up first, both with a `--dry-run`.

### Added

- **A "Toujours" key** on permission prompts, carrying Claude Code's own suggested rule —
  spelled out on the last detail line, so it is never a blind press.
- **Plan keys.** An `ExitPlanMode` prompt gets **Continuer à planifier** (which denies with
  a message, and Claude revises) and **Approuver au terminal**. A hook cannot approve a
  plan; see [Limitations](README.md#limitations).
- **A per-session question queue.** Several sessions can ask at once. The queue key steps
  through them, **Retour** puts one aside on its session key, and pressing a session key
  brings its question back.
- **The full 8 × 4 XL answer page.** Sixteen detail keys act as one text surface, so the
  command being approved is readable rather than guessed from three words.
- **A burn-rate projection on the usage keys** — `limite ~14:30` instead of only the
  countdown to the window reset.
- **A launcher key** that opens a project in Warp with `claude` already running.
- **A deck badge** on the dashboard key of any session with a question waiting.
- GitHub Actions running every hermetic check, plus a packed `.streamDeckPlugin` on a
  `v*` tag.

### Changed

- **One Stream Deck plugin**, `com.phmatray.claudedeck`, replacing `com.julien.claudesessions`
  and `com.claudeask.streamdeck`. `scripts/migrate-profiles.mjs` re-points keys you already
  placed.
- **The Claude Code plugin ships the hooks.** `claude plugin install` is the whole install;
  nothing is copied into `~/.claude/settings.json` any more. `scripts/migrate-settings.mjs`
  removes the old commands, which would otherwise log every event twice.
- A session key press now brings up that session's pending question as well as focusing its
  terminal.
- Only the states that need you are animated, so page switches stay fast.

### Removed

- **Windows and WSL support.** macOS only, by design: `open`, `osascript`, `~/Library/…`
  paths, and a workaround for launchd's `PATH`.
- **The global question lock** and its exit code `4`. A second question queues instead of
  being refused.
- The AGPL-licensed mascot art the dashboard's idle key used, replaced by an original
  motif. The project is MIT throughout.

### Fixed

- Page switches no longer lag behind a flood of animation frames.
- A question whose `claude-ask` died, or that timed out, drops off the deck by itself.

[3.0.0]: https://github.com/phmatray/claude-deck/releases/tag/v3.0.0
