---
name: ask-on-streamdeck
description: Use when you need the user to choose between options and they have the Claude Deck Stream Deck plugin installed - puts the choices on the deck's keys and blocks until they press one. Triggers on "ask me on the deck", "put that on the stream deck", "deck question", or a user preference to answer on hardware.
---

# Ask on the Stream Deck

Put a multiple-choice question on the user's Stream Deck and wait for a keypress.
Use this in place of the normal question flow when the user has asked for questions
on the deck.

## How to ask

Pipe a JSON spec into `claude-ask`. It ships in this plugin's `bin/` and is **not** on
your PATH, so call it by its full path:

```bash
cat <<'JSON' | "${CLAUDE_PLUGIN_ROOT}/bin/claude-ask"
{
  "header": "Approach",
  "question": "Retries time out under load. Which fix?",
  "timeout": 180,
  "options": [
    {"label": "Add jitter", "description": "Smallest change. Fixes the retry pile-up."},
    {"label": "Token bucket", "description": "Fairer, but adds state to maintain."}
  ]
}
JSON
```

If `${CLAUDE_PLUGIN_ROOT}` is empty in your shell, use the installed copy:
`ls ~/.claude/plugins/cache/*/claude-deck/*/bin/claude-ask` (take the newest version).

Run it in the **background** so you are not blocked while the user walks to the deck,
then read the answer when the task completes.

| Field | Notes |
|---|---|
| `question` | Full text. Printed in the terminal, not on the keys. |
| `header` | 1-3 words. This is what the question key shows. |
| `options` | 1-8 entries. `label` goes on the key, `description` prints in the terminal. |
| `timeout` | Seconds, default 180. |
| `context` | Defaults to the current directory's name, shown on the top-left key. |

Answer arrives on stdout as `{"index":0,"label":"Add jitter","cancelled":false}`.

Exit codes: `0` answered, `2` the user chose to answer in the terminal, `3` timed out,
`4` another question already owns the deck.

## Writing labels that fit

A key is 72px. Labels are auto-sized and wrapped, but two or three short words is the
ceiling for comfortable reading.

- Good: `Add jitter`, `Token bucket`, `Skip it`
- Too long: `Add jitter to the retry backoff`

Keep the reasoning in `description` — the user reads that in the terminal while
deciding, and presses the key to answer.

## Rules

- **Always print the full question and all descriptions in your reply too.** The keys
  cannot hold enough text to decide from alone.
- **Fall back, never guess.** On exit code `2`, `3`, or `4`, ask the same question in the
  terminal instead. Do not pick an option on the user's behalf.
- **Do not use this for anything a label cannot convey** — approving a specific command,
  confirming a destructive action, or any choice where the exact wording matters. Ask in
  the terminal where the user can read it.
- One question at a time. The deck holds a lock; a second question gets exit code `4`.
