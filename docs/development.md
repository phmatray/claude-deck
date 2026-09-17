# Development

macOS only, Node 20, pnpm through `corepack pnpm` (the version is pinned in `stream-deck/package.json`). There is no test framework and no lint script: a change is verified by `pnpm build`, `pnpm sd:validate` and the assert-based `check-*` scripts, then `pnpm sd:reload` and a look at the logs.

## pnpm scripts

Run these from `stream-deck/`.

| Script | What it does |
|---|---|
| `pnpm build` | Rollup → `com.phmatray.claudedeck.sdPlugin/bin/plugin.js`, then `scripts/build-profile.mjs` → the bundled `Claude Deck.streamDeckProfile` |
| `pnpm watch` | `rollup -w`; touches the reload trigger after each rebuild |
| `pnpm sd:reload` | Touch `~/.claude/.claude-deck.reload` → plugin self-exits → the SD app respawns it (~1 s) |
| `pnpm sd:link` / `pnpm sd:unlink` | (Re)create / remove the symlink into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/` |
| `pnpm sd:validate` | `streamdeck validate` against the manifest + assets |
| `pnpm sd:pack` | `../dist/com.phmatray.claudedeck.streamDeckPlugin` (or `scripts/package.sh` from the repo root, which installs and builds first) |
| `pnpm sd:dev` | Enable Stream Deck developer mode (one-time) |
| `pnpm icons:render` | Regenerate `icons/*.svg` reference assets from `src/icons/` |
| `pnpm icons:static` | Rasterize the manifest PNGs from `assets/svg/` via `@resvg/resvg-js` |
| `pnpm docs:render` | Regenerate `../docs/deck-{permission,plan,ask}.png` from the answer-key art |
| `pnpm drill` | Walk the running plugin through every state, for a visual check. Writes fake session files into the **real** `~/.claude/sessions/` — a live tool, like the `probe-*` scripts |

## Checks and probes

**`check-*` is hermetic and runs in CI.** Temp `HOME`, temp `CLAUDE_ASK_DIR`, temp cwd: nothing reads or writes the real user state, and nothing needs a deck. `.mts` ones run under tsx from `stream-deck/`, `.mjs` ones under plain node.

```bash
cd stream-deck
corepack pnpm exec tsx scripts/check-<name>.mts     # animation-budget, ask-controller, ask-detail,
                                                    # ask-keys, ask-render, env-paths, focus-stamp,
                                                    # hook-check, launcher, live-pids,
                                                    # pending-question, usage-projection
node scripts/check-profile.mjs                      # the generated profile's shape

cd ..                                               # repo root
node scripts/check-ask-input.mjs                    # claude-ask input validation
node scripts/check-ask-queue.mjs                    # two sessions, answered out of order
node scripts/check-migrate-profiles.mjs             # migrate-profiles against a fixture
node scripts/check-migrate-settings.mjs             # migrate-settings against a temp HOME
node scripts/check-permission.mjs                   # claude-permission's whole decision table
```

New logic gets one more `check-*` script — the smallest thing that fails if the logic breaks. `.github/workflows/ci.yml` lists every one of them by name; add yours there too.

**`probe-*` is the opposite** and is never run by CI:

| Probe | What it needs |
|---|---|
| `sh scripts/probe-hooks.sh` | The real `~/.claude`: is the installed `claude-deck` plugin registering every hook? Same rules as `src/hook-check.ts`. |
| `sh scripts/probe-deck-link.sh` | The real deck: forces a page switch and reads the Stream Deck log to tell a slow deck from a desynced one. |

## Reload flow

The plugin watches `~/.claude/.claude-deck.reload` once per second. On mtime change it calls `process.exit(0)` and the Stream Deck app respawns it — the SD app's normal crash-recovery behaviour, repurposed.

`pnpm sd:reload` just touches that file; `pnpm watch` does it after each rebuild. The first time after building you still need to quit + relaunch the SD app once, since the *currently-running* bundle doesn't yet know how to self-reload.

## End-to-end verification checklist

1. `pnpm build` produces `com.phmatray.claudedeck.sdPlugin/bin/plugin.js` and the `.streamDeckProfile` next to it.
2. `pnpm sd:validate` reports "Validation successful".
3. `scripts/package.sh && open dist/com.phmatray.claudedeck.streamDeckPlugin` — install it once for real. Only the installer imports the bundled profile, so the answer keys cannot work without this step.
4. `pnpm sd:link` — output shows the `✓ symlink:` line. (Replaces the installed copy with the repo build; the imported profile stays.)
5. Quit + relaunch the Stream Deck app. Drag **Claude Session Slot** onto the keys you want to dedicate to live sessions.
6. `claude plugin install claude-deck@phmatray` — `/hooks` in Claude Code lists them under Plugin Hooks, and the Setup key shows no `HOOKS` badge.
7. In a terminal, run `claude` somewhere. Slot 1 fills with the project name, amber while it works, blue while idle.
8. Trigger a permission prompt → the slot flips within ~1 s **and** the deck switches to the answer keys. Press **Autoriser**; the terminal dialog closes with it.
9. Open `claude` in another `cwd`, make both ask at once → the second question queues, the queue key reads `+1`.
10. Exit one session → it shows the green "finished" check briefly, then empties.
11. Short-press a key → that session's terminal (Warp pane or VS Code window) comes to the front. Hold past the red ring → the session dies.

## Releasing

`.github/workflows/ci.yml` runs build, validate and every check on ubuntu-latest for each push and pull request. `.github/workflows/release.yml` fires on a `v*` tag: it runs `scripts/package.sh` and attaches `dist/com.phmatray.claudedeck.streamDeckPlugin` to a GitHub release.

So cutting a release is: bump `version` in `.claude-plugin/marketplace.json`, `claude-code/.claude-plugin/plugin.json`, `stream-deck/package.json` and `Version` in the manifest (4-part there), commit, then `git tag v3.0.1 && git push --tags`.

## Tweaks

- **Icon designs:** edit `src/icons/`, then `pnpm icons:render` to refresh the reference SVGs in `icons/`. For the manifest PNGs, edit `assets/svg/` then `pnpm icons:static`.
- **Key layout:** `scripts/build-profile.mjs`. Its comments document the four things that make Stream Deck's profile importer fail *silently* — it accepts a broken profile without an error and hands you a page with no keys. A layout change means reinstalling the `.streamDeckPlugin`, since only the installer imports profiles.
- **Paths:** every per-user path lives in `src/env.ts`, derived from `os.homedir()`.
- **Logs:** `~/Library/Logs/ElgatoStreamDeck/com.phmatray.claudedeck.sdPlugin/`.
- **Doc images:** rendered from the plugin's own SVG key art with `@resvg/resvg-js` (`pnpm docs:render`), not photographed. They are accurate about layout, sizing and colour — but Stream Deck's renderer is stricter than resvg: it honours neither per-`tspan` positioning nor `text-anchor`, which is why every renderer here emits one `<text>` element per line with an explicit `x`.

## Stream Deck SDK notes

### `@elgato/streamdeck` quick reference

```ts
import streamDeck, { action, SingletonAction, KeyDownEvent, WillAppearEvent } from "@elgato/streamdeck";

@action({ UUID: "com.example.thing.action" })
export class ThingAction extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent) { /* ev.action.coordinates is your slot index */ }
  override async onKeyDown(ev: KeyDownEvent) { await ev.action.setImage(svgString); }
}

// REQUIRED — the @action decorator only stamps `manifestId`. It does NOT register the
// instance with the SDK. Without this line, every event handler is silently ignored.
streamDeck.actions.registerAction(new ThingAction());
await streamDeck.connect();
```

If an action's handlers never fire, a missing `registerAction` is the cause 90 % of the time.

`tsconfig.json` must NOT set `experimentalDecorators: true` — the SDK uses TC39-stage-3 decorators (`ClassDecoratorContext`), not the legacy form. Leave both `experimentalDecorators` and `emitDecoratorMetadata` unset.

`setImage(image)` accepts an `imgs/foo.png` path inside the `.sdPlugin` folder, a raw `<svg …>` string, or a `data:image/svg+xml;base64,…` URL. The data-URL form is the most reliable across SD app versions and is what the plugin ships.

Profiles are switched with `streamDeck.profiles.switchToProfile(deviceId, "Claude Deck", 0)` and switched back by omitting the name. Only a profile declared in `Profiles[]` **and** imported by a real install can be switched to.

### manifest.json gotchas

- `States[].Image` and `Actions[].Icon` are paths **without** the file extension; SD picks PNG > SVG > GIF.
- The validator (`streamdeck validate`) **rejects SVG for `Icon` and `CategoryIcon`** — must be PNG. Each plugin/category PNG also needs an `@2x` variant (e.g. `marketplace.png` 144×144 + `marketplace@2x.png` 288×288). For an action State `Image`, SVG is fine.
- `Category` must literally match `Name` (validator warning otherwise).
- If you set a `URL`, it must respond 2xx. Omit it during early development to skip an HTTP probe.
- `Nodejs.Version` must be `"20"` or `"24"`. `OS` is a tuple of `{Platform, MinimumVersion}`. `SDKVersion` is `2` or `3`.
- Add `"DisableAutomaticStates": true` whenever you drive state transitions yourself (otherwise the SD app toggles between the manifest States on every press).
- `streamdeck pack` rewrites `manifest.json`'s `Version` to four parts on disk. Keeping it 4-part already is what stops a pack from dirtying the tree.
- **Do not** name a script `pack` in `package.json` — it collides with `pnpm pack`. Namespace plugin commands as `sd:link`, `sd:pack`, `sd:validate`, etc.

### Build-info pattern

`rollup.config.mjs` emits `bin/build-info.json` with the build timestamp, and the slot property inspector (`ui/slot.html`) fetches it with cache-busting (`fetch("../bin/build-info.json?t=" + Date.now(), { cache: "no-store" })`) to show "Last build" and its age — a glance tells whether a reload actually picked up the new code. The sibling `emit-module-package-file` plugin drops `bin/package.json` (`{"type":"module"}`) so Node treats the bundle as ESM.

Property inspectors use a raw WebSocket against the Elgato bridge (`connectElgatoStreamDeckSocket`): the SDK's TypeScript API is plugin-side only.

## The Elgato MCP server

Separate from this plugin, Stream Deck can expose itself to an AI assistant over MCP. It is worth setting up, and it is worth knowing what it does *not* do.

**Enable MCP in the Stream Deck app.** In Stream Deck 7.5's settings, turn on the MCP/AI feature. It adds a virtual **MCP Deck** device (8×4) alongside your hardware. You can confirm it stuck:

```bash
defaults read com.elgato.StreamDeck MCP_enabled   # 1 when enabled
```

**Add the server to Claude Code.** Elgato ships it on npm as [`@elgato/mcp-server`](https://www.npmjs.com/package/@elgato/mcp-server):

```bash
claude mcp add elgato --scope user -- npx --yes @elgato/mcp-server@latest
```

Restart Claude Code and ask it to check `bridge_status`. It should report `Connected Elgato apps: streamdeck`. If the tools are missing, the Stream Deck app is not running or MCP is off.

**What you get.** Five tools: `bridge_status`, `streamdeck__list_actions`, `streamdeck__get_context`, `streamdeck__get_executable_actions`, `streamdeck__invoke_plugin_method`.

**Why this project does not use it.** The MCP server can enumerate the actions your installed plugins provide and call methods on plugins that opt in by publishing an AI schema. It cannot create a page, place a key, draw a key, or tell you that a key was pressed. `get_executable_actions` returns an empty list unless an installed plugin is explicitly AI-ready. So MCP is a fine way to let Claude *inspect* your Stream Deck setup, and no way to build an input device out of it — which is why the question flow here is a real Stream Deck plugin rather than a few MCP calls.
