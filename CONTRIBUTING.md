# Contributing to Claude Deck

Thanks for taking the time. Issues, ideas and pull requests are all welcome — including
"this key is unreadable on my deck", which is the kind of thing only hardware in someone
else's hands can tell me.

## Code of Conduct

- Be respectful and assume good faith.
- Critique code, not people.
- No harassment, discrimination or personal attacks.
- Maintainers may edit, lock or remove contributions that break these rules.

## Before you open an issue

- **Hardware and versions matter here.** Say which Stream Deck you have, which Stream Deck
  app version, which macOS, and `claude --version`. The bundled profile is built for the
  XL (8 × 4) and nothing else works out of the box.
- For a stuck dashboard, attach the plugin log:
  `~/Library/Logs/ElgatoStreamDeck/com.phmatray.claudedeck.sdPlugin/`.
- For hooks that do not fire, run `sh scripts/probe-hooks.sh` and paste its output.
- For a deck that lags on page switches, run `sh scripts/probe-deck-link.sh` first — a
  desynced control channel looks exactly like a slow plugin.

## Development setup

```bash
git clone https://github.com/phmatray/claude-deck && cd claude-deck
cd stream-deck && corepack pnpm install
corepack pnpm build && corepack pnpm sd:validate
```

`scripts/package.sh` builds the installable `dist/com.phmatray.claudedeck.streamDeckPlugin`.
Install that once (only the installer imports the bundled profile), then
`stream-deck/scripts/link-plugin.sh` points the Stream Deck app at your build so
`corepack pnpm build && corepack pnpm sd:reload` is the whole loop.

[`docs/development.md`](docs/development.md) has the full command list, the SDK gotchas and
the verification checklist. [`CLAUDE.md`](CLAUDE.md) is the architecture tour.

## Tests

There is no test framework. Every piece of non-trivial logic leaves one runnable
`check-*` script behind, built on `node:assert`:

```bash
cd stream-deck && corepack pnpm exec tsx scripts/check-<name>.mts   # TypeScript checks
node scripts/check-<name>.mjs                                       # repo-root checks
```

Two rules keep them trustworthy:

- **`check-*` is hermetic.** It uses a temporary `HOME` and `CLAUDE_ASK_DIR` and never
  touches the real `~/.claude`, `~/.warp` or the Stream Deck app. These are what CI runs.
- **`probe-*` is not.** Those read the real deck or the real `~/.claude` and are for a
  human sitting at the hardware. Never add one to CI.

A new `check-*` must be named on a `run:` line in `.github/workflows/ci.yml` —
`scripts/check-ci-scripts.mjs` fails the build if you forget.

## Pull requests

- Branch off `main`.
- **Conventional Commits**, in English, lowercase subject, scope where it helps:
  `feat(ask): …`, `fix(stream-deck): …`, `docs: …`. The PR title becomes the squash
  subject and is linted by `.github/workflows/pr-title.yml`.
- Keep the diff to one concern.
- Say what you verified. "Built, validated, all checks green, pressed the key on my XL"
  is worth more than a paragraph of intent.
- Anything about the answer keys or the hooks: describe the Claude Code version you saw
  the behaviour on. That surface changes.

## Where things live

| Path | What |
|---|---|
| `stream-deck/src/` | the Stream Deck plugin (TypeScript, one bundled Node process) |
| `claude-code/` | the Claude Code plugin: hooks, `claude-ask`, `claude-permission`, the skill |
| `scripts/` | packaging, migrations, repo-level `check-*` and `probe-*` |
| `docs/` | architecture, development, Warp focus notes |

On-deck labels are French (`Autoriser`, `Refuser`, `Toujours`, `Retour`, `Terminal`).
Code, comments, docs and commit messages are English.
