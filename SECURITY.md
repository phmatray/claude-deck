# Security Policy

## Supported Versions

Claude Deck ships as a Stream Deck plugin and a Claude Code plugin, released together.
Fixes go to the latest release on `main`; there is no LTS branch.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## What this software can do on your machine

Worth knowing before you report, and before you install:

- The Claude Code plugin registers a **`PermissionRequest` hook**. It can answer Claude
  Code's permission prompts — including allowing a tool call and writing an allow-rule
  into your project's `.claude/settings.local.json` when you press **Toujours**. It only
  ever echoes back a rule Claude Code itself proposed, and it only acts on a key press.
- The status hooks run on **every** Claude Code event and append to
  `~/.claude/sessions/<id>.events.ndjson`: timestamps, event names, tool names, todo
  text, and the Warp pane id. No prompt text, no file contents, no credentials.
- The plugin reads `~/.claude.json` for the usage snapshot Claude Code caches there. It
  parses the rate-limit slice only, and never touches the OAuth token.
- Nothing leaves the machine. No network calls, no telemetry, no daemon. The one process
  spawned is `claude -p "/usage"`, to make Claude Code refresh its own snapshot.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report privately with GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/phmatray/claude-deck/security) of this
   repository.
2. Click **"Report a vulnerability"**.
3. Include as much detail as you can:
   - What the vulnerability is and what it lets an attacker do
   - Steps to reproduce
   - Your macOS version, Stream Deck app version and `claude --version`
   - The relevant hook payload or question file, with anything sensitive redacted

If you cannot use private reporting, open a regular issue asking for a private contact
channel — without any vulnerability details in it.

### Response Time

I aim to acknowledge a report within **7 days** and to give an initial assessment
(severity, affected versions, and a fix plan or timeline) in that same window. This is a
side project maintained by one person: a fix timeline depends on severity and on how much
of it lives in Claude Code's or the Stream Deck app's surface rather than in this code.
