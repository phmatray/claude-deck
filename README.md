# Answer Claude on a Stream Deck

Claude Code asks you a lot of multiple-choice questions. This puts them on your Stream Deck so you answer with one keypress instead of reaching for the keyboard.

![A question on the deck](docs/deck-question.png)

Top-left tells you which directory is asking — useful when several sessions are running. Next to it is the question. The numbered keys are the options. Top-right bails out to the terminal. Press a key and the deck goes straight back to whatever profile you were on.

## How it works

There are two halves, and they talk through two files in `~/.claude-ask/`:

1. Claude runs `claude-ask` with a JSON question. It writes `question.json` and waits.
2. The Stream Deck plugin sees the file, draws the keys, and switches your deck to its own profile.
3. You press a key. The plugin writes `answer.json` and switches the deck back.
4. `claude-ask` prints the answer and exits.

No network, no daemon, no polling service. Two files and a file watcher.

## Requirements

- A 5x3 Stream Deck (Stream Deck / MK.2, model `20GBA9901`). Other sizes are not supported yet — see [Limitations](#limitations).
- Stream Deck app 6.4 or newer, macOS 12+.
- Claude Code.

## Install

### 1. The Stream Deck plugin

Download `ClaudeAsk.streamDeckPlugin` from the [latest release](https://github.com/hardkoded/streamdeck-claude-answer/releases/latest) and double-click it. Stream Deck will ask you to confirm.

**Install it this way even if you plan to hack on it.** The installer is the only thing that imports the bundled `Claude Ask` profile, and without that profile the plugin cannot switch your deck. Copying the folder into the plugins directory by hand gives you a plugin that loads, registers, and then silently does nothing.

### 2. The Claude Code plugin

```bash
claude plugin install hardkoded/streamdeck-claude-answer
```

That installs the `ask-on-streamdeck` skill and puts `claude-ask` on your PATH.

### 3. Tell Claude to use it

Once per session, or put it in your `CLAUDE.md`:

> Ask me questions on the Stream Deck.

## Usage

Claude does this for you, but the CLI is plain enough to use directly:

```bash
cat <<'JSON' | claude-ask
{
  "header": "Approach",
  "question": "Retries time out under load. Which fix?",
  "timeout": 180,
  "options": [
    {"label": "Add jitter", "description": "Smallest change. Fixes the retry pile-up."},
    {"label": "Token bucket", "description": "Fairer, but adds state to maintain."},
    {"label": "Leave it", "description": "Not worth the churn right now."}
  ]
}
JSON
```

Prints `{"index":0,"label":"Add jitter","cancelled":false}`.

| Field | Meaning |
|---|---|
| `question` | Full text. Goes to the terminal, not the keys. |
| `header` | 1-3 words. This is what the question key shows. |
| `options` | 1-10 items. `label` on the key, `description` in the terminal. |
| `timeout` | Seconds, default 180. |
| `context` | Top-left key. Defaults to the current directory's name. |

| Exit | Meaning |
|---|---|
| 0 | Answered. |
| 2 | You pressed "Use terminal". |
| 3 | Timed out. |
| 4 | Another question already owns the deck. |

Anything other than 0 means *ask in the terminal instead* — never assume an answer.

### Key layout

|  | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| **row 0** | context | question | — | — | Use terminal |
| **row 1** | option 1 | option 2 | option 3 | option 4 | option 5 |
| **row 2** | option 6 | option 7 | option 8 | option 9 | option 10 |

Unused option keys go dark. With no question pending the whole page is idle:

![The idle page](docs/deck-idle.png)

### Stuck deck

If a session is killed hard enough to skip its cleanup, the deck can stay on the ask profile. This releases it:

```bash
rm -f ~/.claude-ask/question.json
```

## Writing good labels

A key is 72px. Labels are measured against real font metrics and auto-sized between 18px and 48px, wrapping onto up to three lines, but the honest ceiling is two or three short words.

![Two options](docs/deck-two-options.png)

Put the reasoning in `description`. You read that in the terminal while deciding; the key is just the button you press.

Do not use the deck for choices where exact wording matters — approving a specific shell command, confirming a destructive action. Three words cannot distinguish `git push` from `git push --force origin main`. Ask in the terminal for those.

## Configuring the Elgato MCP server in Stream Deck

Separate from this plugin, Stream Deck can expose itself to an AI assistant over MCP. It is worth setting up, and it is worth knowing what it does *not* do.

**Enable MCP in the Stream Deck app.** In Stream Deck 7.5's settings, turn on the MCP/AI feature. It adds a virtual **MCP Deck** device (8x4) alongside your hardware. You can confirm it stuck:

```bash
defaults read com.elgato.StreamDeck MCP_enabled   # 1 when enabled
```

**Add the server to Claude Code.** Elgato ships it on npm as [`@elgato/mcp-server`](https://www.npmjs.com/package/@elgato/mcp-server):

```bash
claude mcp add elgato --scope user -- npx --yes @elgato/mcp-server@latest
```

Or by hand in `~/.claude.json`:

```json
{
  "mcpServers": {
    "elgato": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@elgato/mcp-server@latest"],
      "env": {}
    }
  }
}
```

Restart Claude Code and ask it to check `bridge_status`. It should report `Connected Elgato apps: streamdeck`. If the tools are missing, the Stream Deck app is not running or MCP is off.

**What you get.** Five tools: `bridge_status`, `streamdeck__list_actions`, `streamdeck__get_context`, `streamdeck__get_executable_actions`, `streamdeck__invoke_plugin_method`.

**Why this project does not use it.** The MCP server can enumerate the actions your installed plugins provide and call methods on plugins that opt in by publishing an AI schema. It cannot create a page, place a key, draw a key, or tell you that a key was pressed. `get_executable_actions` returns an empty list unless an installed plugin is explicitly AI-ready. So MCP is a fine way to let Claude *inspect* your Stream Deck setup, and no way to build an input device out of it — which is why the question flow here is a real Stream Deck plugin rather than a few MCP calls.

## Development

```bash
scripts/package.sh        # build dist/ClaudeAsk.streamDeckPlugin
scripts/install-local.sh  # sync source into the installed plugin, restart the app
```

Code changes need a Stream Deck restart, which `install-local.sh` does. Changes to the **key layout** mean rebuilding the profile and reinstalling the `.streamDeckPlugin`, because only the installer imports profiles.

```
.claude-plugin/         Claude Code plugin + marketplace manifests
bin/claude-ask          the CLI Claude calls
skills/                 the ask-on-streamdeck skill
streamdeck/             Stream Deck plugin source
scripts/                build + local install
docs/                   rendered key art for this README
```

`scripts/build-profile.mjs` generates the bundled profile. Its comments document the four things that make Stream Deck's profile importer fail silently — worth reading before you touch it, since it accepts a broken profile without an error and hands you a page with no keys.

### About the images

The images in this README are rendered from the plugin's own SVG key art with `rsvg-convert`, not photographed off the hardware. They are accurate about layout, sizing, and colour. Be aware that Stream Deck's renderer is stricter than `rsvg`: it honours neither per-`tspan` positioning nor `text-anchor`, which is why the renderer emits one `<text>` element per line with an explicit `x`.

## Limitations

- **5x3 decks only.** The bundled profile targets model `20GBA9901`. An XL or Mini will install the plugin but get no usable profile. Adding sizes means another profile per device type.
- **Ten options max.** That is how many option keys the page has.
- **One question at a time.** A lock file means a second question gets exit code 4 rather than stealing the deck.
- **macOS only**, because that is all this has been tested on. Nothing in it is deeply mac-specific except the paths.

## License

MIT
