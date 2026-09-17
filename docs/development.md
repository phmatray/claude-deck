# Development

There is no test framework and no lint script. Verify a change by running `pnpm build && pnpm sd:validate`, the `scripts/check-*.mts` self-checks (`pnpm exec tsx scripts/check-<name>.mts`), then `pnpm sd:reload` and watch the logs.

## pnpm scripts

| Script | What it does |
|---|---|
| `pnpm build` | Rollup → `com.julien.claudesessions.sdPlugin/bin/plugin.js` (terser in prod, sourcemaps in watch) |
| `pnpm watch` | `rollup -w`; auto-touches the reload trigger after each rebuild |
| `pnpm sd:reload` | Touch `~/.claude/.claude-deck.reload` → plugin self-exits → SD app respawns it (~1 s) |
| `pnpm sd:link` / `pnpm sd:unlink` | (Re)create / remove the symlink into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/` |
| `pnpm sd:validate` | `streamdeck validate` against the manifest + assets |
| `pnpm sd:pack` | Bundle `dist/com.julien.claudesessions.streamDeckPlugin` for distribution |
| `pnpm sd:dev` | Enable Stream Deck developer mode (one-time) |
| `pnpm install:hook` | Idempotently register the hook for every event into `~/.claude/settings.json` |
| `pnpm icons:render` | Regenerate `icons/*.svg` reference assets from `src/icons/` |
| `pnpm icons:static` | Rasterize manifest PNGs from `assets/svg/` via `@resvg/resvg-js` |
| `pnpm check:hooks` | Diff installed hooks against `scripts/install-hook.sh` to confirm the registration is current |

The plugin also runs this check at runtime (`src/hook-check.ts`): on startup it logs a warning, and the **Setup key** shows an amber `HOOKS` badge, whenever a required event isn't registered catch-all — so stale config (the classic "permission padlock never clears") surfaces instead of silently producing wrong icons.

Logs land at `~/Library/Logs/ElgatoStreamDeck/com.julien.claudesessions.sdPlugin/`.

## Reload flow

The plugin watches `~/.claude/.claude-deck.reload` once per second. On mtime change it calls `process.exit(0)` and the Stream Deck app respawns it — the SD app's normal crash-recovery behaviour, repurposed.

`pnpm sd:reload` just touches that file. `pnpm watch` triggers it automatically on each rebuild.

The first time after building, you still need to quit + relaunch the SD app once (the *currently-running* bundle doesn't yet know how to self-reload). After that, `pnpm sd:reload` is enough.

## End-to-end verification checklist

1. `pnpm build` produces `com.julien.claudesessions.sdPlugin/bin/plugin.js`.
2. `pnpm sd:validate` reports "Validation successful".
3. `pnpm install:hook` — `jq '.hooks.Notification' ~/.claude/settings.json` shows the new hook.
4. `pnpm sd:link` — output shows the `✓ symlink:` line.
5. Quit + relaunch the Stream Deck app. Drag **Claude Session Slot** onto whatever keys you want to dedicate to live sessions.
6. In a terminal, run `claude` somewhere. Slot 1 fills with the project name in amber while it works, blue while idle.
7. Trigger a permission prompt → slot flips to orange within ~1 s.
8. Open `claude` in another `cwd` → slot 2 lights up.
9. Exit one session → it shows green "finished" briefly, then empties.
10. Press a key → that session's terminal (Warp pane or VS Code window) comes to the front.

## Tweaks

- **Different icon designs:** edit `src/icons/`, then `pnpm icons:render` to refresh the reference SVGs in `icons/`. For the manifest PNGs, edit `assets/svg/` then `pnpm icons:static`.
- **Paths:** every per-user path lives in `src/env.ts`, derived from `os.homedir()`.

## Stream Deck SDK notes

### `@elgato/streamdeck` (SDK v2) quick reference

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

If an action's handlers never fire, a missing `registerAction` is the cause 90% of the time.

`tsconfig.json` must NOT set `experimentalDecorators: true` — the SDK uses TC39-stage-3 decorators (`ClassDecoratorContext`), not the legacy form. Leave both `experimentalDecorators` and `emitDecoratorMetadata` unset.

`setImage(image)` accepts an `imgs/foo.png` path inside the `.sdPlugin` folder, a raw `<svg …>` string, or a `data:image/svg+xml;base64,…` URL. The data-URL form is the most reliable across SD app versions and is what the plugin ships.

### manifest.json gotchas

- `States[].Image` and `Actions[].Icon` are paths **without** the file extension; SD picks PNG > SVG > GIF.
- The validator (`streamdeck validate`) **rejects SVG for `Icon` and `CategoryIcon`** — must be PNG. Each plugin/category PNG also needs an `@2x` variant (e.g. `marketplace.png` 144×144 + `marketplace@2x.png` 288×288). For action State `Image`, SVG is fine.
- `Category` must literally match `Name` (validator warning otherwise).
- If you set a `URL`, it must respond 2xx. Omit it during early development to skip an HTTP probe.
- `Nodejs.Version` must be `"20"` or `"24"`. `OS` is a tuple of `{Platform, MinimumVersion}`. `SDKVersion` is `2` or `3`.
- Add `"DisableAutomaticStates": true` whenever you drive state transitions yourself (otherwise the SD app toggles between the manifest States on every press).
- **Do not** name a script `pack` in `package.json` — it collides with `pnpm pack`. Namespace plugin commands as `sd:link`, `sd:pack`, `sd:validate`, etc.

### Build-info pattern

`rollup.config.mjs` emits `bin/build-info.json` with the build timestamp, and the slot property inspector (`ui/slot.html`) fetches it with cache-busting (`fetch("../bin/build-info.json?t=" + Date.now(), { cache: "no-store" })`) to show "Last build" and its age — a glance tells whether a reload actually picked up the new code. The sibling `emit-module-package-file` plugin drops `bin/package.json` (`{"type":"module"}`) so Node treats the bundle as ESM.
