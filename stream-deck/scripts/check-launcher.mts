// Self-check: the launcher key — the Warp Tab Config it writes (src/launcher/tab-config.ts),
// the art it paints (src/launcher/render.ts) and the action that wires the two to the deck
// (src/launcher/launcher-action.ts). Hermetic: every write goes to a temp HOME, so the real
// ~/.warp is never touched, and the press gets a recorder instead of the real openUrl, which
// shells out to `/usr/bin/open warp://…` and would take over the user's Warp.
// Run: pnpm exec tsx scripts/check-launcher.mts
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COMMAND,
  expandHome,
  tabConfigPath,
  tabConfigSlug,
  tabConfigStem,
  tabConfigToml,
  tabConfigUri,
  writeTabConfig,
} from "../src/launcher/tab-config.ts";
import { launcherKey, launcherKeyUrl, UNSET_LABEL } from "../src/launcher/render.ts";

const home = mkdtempSync(join(tmpdir(), "claude-deck-launcher-"));
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const svg = (dataUrl: string) => {
  assert.ok(dataUrl.startsWith("data:image/svg+xml;base64,"), "setImage takes a base64 data URL, not raw SVG");
  return Buffer.from(dataUrl.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
};

// ── the typed directory → an absolute path ───────────────────────────────────
assert.equal(expandHome("~/repo/x", home), join(home, "repo/x"), "~ is the user's home, not a folder called ~");
assert.equal(expandHome("~", home), home, "a bare ~ too");
assert.equal(expandHome("  /a/b/  ", home), "/a/b", "typed whitespace and a trailing slash are noise");
assert.equal(expandHome("/a/b/../c", home), "/a/c", "…and so is a detour through ..");
assert.equal(expandHome("", home), "", "nothing typed stays nothing — the key is unconfigured");
assert.equal(expandHome("   ", home), "", "…spaces included");
// Anything still relative is a typo, and resolving it would silently mint a path
// inside the Stream Deck app's own folder that the key would then look configured for.
assert.equal(expandHome("~notauser/x", home), "", "only ~/ expands: ~user is the shell's trick, not ours");
assert.equal(expandHome("repo/x", home), "", "a relative path is not a project");
assert.equal(expandHome("Users/me/repo/x", home), "", "…nor is one that just lost its leading slash");
assert.notEqual(expandHome("repo/x", home), resolve("repo/x"), "and it is certainly not cwd/repo/x");

// ── slug: readable, filename-safe, and collision-free ────────────────────────
assert.match(tabConfigSlug("/Users/p/repo/My Project"), /^my_project_[0-9a-f]{6}$/, "basename lowercased, punctuation to _, 6 hex of the path");
assert.equal(tabConfigStem("/Users/p/repo/x"), `claude_deck_${tabConfigSlug("/Users/p/repo/x")}`, "the stem is the slug behind our prefix");
assert.match(tabConfigStem("/a/Été-2026"), /^claude_deck_[a-z0-9_]+$/, "non-ASCII never reaches the filename");
const twins = ["/Users/p/work/api", "/Users/p/perso/api"].map(tabConfigStem);
assert.notEqual(twins[0], twins[1], "two checkouts named api get two configs, not one overwritten");
assert.equal(tabConfigStem("/Users/p/work/api"), twins[0], "…and the same path always maps to the same one");
assert.equal(tabConfigPath(home, "claude_deck_x"), join(home, ".warp", "tab_configs", "claude_deck_x.toml"), "Warp's folder, our stem");

// ── TOML: what Warp reads ────────────────────────────────────────────────────
const toml = tabConfigToml("/Users/p/repo/deck");
assert.match(toml, /^name = "Claude Deck · deck"$/m, "the name Warp lists in its + menu");
assert.match(toml, /^\[\[panes\]\]$/m, "one pane");
assert.match(toml, /^type = "terminal"$/m);
assert.match(toml, /^directory = "\/Users\/p\/repo\/deck"$/m);
assert.match(toml, /^commands = \["claude"\]$/m, `the default command is ${DEFAULT_COMMAND}`);
// is_focused belongs to Launch Configs (map/warp-launch.md §1) and Warp's own generated
// tab config has none. A field its deserialiser rejects would kill every press silently:
// `open` still exits 0, so the key would show no alert and log nothing.
assert.ok(!/is_focused/.test(toml), "no field Warp's tab-config parser has not been seen to accept");
assert.match(tabConfigToml("/a/b", "claude --resume"), /^commands = \["claude --resume"\]$/m, "a custom command is honoured");
assert.match(tabConfigToml("/a/b", ""), /^commands = \["claude"\]$/m, "an empty command field is not a command");
// A path a user can actually create, and which would otherwise end the TOML string early.
const nasty = '/Users/p/re"po\\x';
const nastyToml = tabConfigToml(nasty);
assert.match(nastyToml, /^directory = "\/Users\/p\/re\\"po\\\\x"$/m, 'quotes and backslashes are escaped, not emitted raw');
assert.equal(JSON.parse(nastyToml.match(/^directory = (.*)$/m)![1]), nasty, "…and they round-trip to the path we meant");

// ── the URI that runs it ─────────────────────────────────────────────────────
assert.equal(tabConfigUri("claude_deck_x_abc123"), "warp://tab_config/claude_deck_x_abc123", "a tab in the focused window");
assert.equal(tabConfigUri("claude_deck_x_abc123", true), "warp://tab_config/claude_deck_x_abc123?new_window=true", "…or a window of its own");

// ── the writer, against a temp HOME ──────────────────────────────────────────
const dir = join(home, "repo", "deck");
const first = await writeTabConfig(home, dir);
assert.ok(first.path.startsWith(home + "/"), "nothing is ever written outside the home we were handed");
assert.equal(first.path, tabConfigPath(home, first.stem), "Warp's own folder, our own stem");
assert.equal(first.written, true, "a missing file is written");
assert.equal(readFileSync(first.path, "utf8"), tabConfigToml(dir), "on disk is exactly what tabConfigToml says");

const mtime = statSync(first.path).mtimeMs;
const again = await writeTabConfig(home, dir);
assert.equal(again.written, false, "an unchanged key does not churn the file Warp lists");
assert.equal(again.path, first.path);
// The flag is a report; the mtime is the thing Warp's + menu sorts by.
assert.equal(statSync(first.path).mtimeMs, mtime, "…and the file on disk is genuinely untouched");

const changed = await writeTabConfig(home, dir, "claude --continue");
assert.equal(changed.written, true, "a new command rewrites it");
assert.equal(changed.path, first.path, "…in place: the stem depends on the directory alone");
assert.match(readFileSync(first.path, "utf8"), /^commands = \["claude --continue"\]$/m);

// ── key art ──────────────────────────────────────────────────────────────────
const key = launcherKey("deck");
assert.match(key, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="144" height="144"/, "a 144x144 key");
assert.ok(key.includes(">deck</text>"), "the label is on the key");
assert.ok(launcherKey("").includes(`>${UNSET_LABEL}</text>`), "an unconfigured key says so, in French");
assert.ok(launcherKey("  ").includes(`>${UNSET_LABEL}</text>`), "…and whitespace is not a label");
const escaped = launcherKey("a<b&c");
assert.ok(escaped.includes("a&lt;b&amp;c"), "a repo name with markup characters cannot break the SVG");
assert.ok(!/>a<b/.test(escaped));
// setImage takes a data URL: un-encoded SVG renders a blank key on the deck.
assert.equal(svg(launcherKeyUrl("deck")), key, "the data URL decodes back to the art");

// ── the property inspector saves what the action reads ───────────────────────
const pi = src("../com.phmatray.claudedeck.sdPlugin/ui/launcher.html");
const actionSrc = src("../src/launcher/launcher-action.ts");
const fields = [...actionSrc.match(/type LauncherSettings = \{([\s\S]*?)\n\};/)![1].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
const saved = [...pi.match(/settings = \{\n([^{}]*)\}/)![1].matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
assert.deepEqual(saved.sort(), fields.sort(), "the PI's setSettings keys are exactly the settings LauncherSettings declares");
// A renamed key there is a permanently dead field here, and validate never notices.
assert.ok(fields.length >= 4, "…and there are four of them, not a regex that matched nothing");
// The action reads `newWindow === true`: saved as a string, the checkbox would be stuck off.
assert.match(pi, /newWindow: document\.getElementById\("newWindow"\)\.checked,/, "the checkbox is saved as a boolean");
// And the panel only ever opens if the manifest names it. Dropped, the key is unconfigurable
// for good — `streamdeck validate` checks the file a path points at, never that there is one.
const manifest = JSON.parse(src("../com.phmatray.claudedeck.sdPlugin/manifest.json"));
const launcherManifest = manifest.Actions.find((a: { UUID: string }) => a.UUID === "com.phmatray.claudedeck.launcher");
assert.equal(launcherManifest?.PropertyInspectorPath, "ui/launcher.html", "the manifest wires the launcher key to this property inspector");
// The panel is torn down with the field still focused: neither change nor blur fires then.
assert.ok(/addEventListener\("input"/.test(pi), "typing is saved on its own, not only on blur");
assert.ok(/addEventListener\("pagehide"/.test(pi), "…and flushed when the panel goes away mid-word");

// ── the action: willAppear / didReceiveSettings / an unconfigured press ───────
// HOME first: env.ts reads homedir() at load, and the SDK reads manifest.json from cwd
// and logs into cwd/logs.
const tmp = mkdtempSync(join(tmpdir(), "claude-deck-launcher-home-"));
process.env.HOME = tmp;
copyFileSync(fileURLToPath(new URL("../com.phmatray.claudedeck.sdPlugin/manifest.json", import.meta.url)), join(tmp, "manifest.json"));
process.chdir(tmp);
// Everything above is imported statically, hoisted above `process.env.HOME = tmp`, and env-free
// for exactly that reason. Assert it before loading the action rather than discover a stray
// claude_deck_*.toml in the real ~/.warp: a static import reaching env.ts would capture the
// user's home instead. Before, too, because past this line the SDK swallows what we throw
// until the handler below is installed.
assert.equal((await import("../src/env.ts")).HOME, tmp, "the action's HOME is the temp one, not the user's");
const { LauncherAction } = await import("../src/launcher/launcher-action.ts");
// The SDK only logs uncaught exceptions: fail loudly instead.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});

const images = new Map<string, string>();
const alerts = new Map<string, number>();
const fakeKey = (id: string, isKey = true) => ({
  id,
  isKey: () => isKey,
  setImage: async (img: string) => void images.set(id, img),
  showAlert: async () => void alerts.set(id, (alerts.get(id) ?? 0) + 1),
});
const ev = (action: object, settings: object) => ({ action, payload: { settings } }) as any;
const configs = () => readdirSync(join(tmp, ".warp", "tab_configs")).sort();
// Stands in for openUrl: same shape, no `/usr/bin/open`.
const opened: string[] = [];
let openResult = { matched: true, reason: "ok" };
const launcher = new LauncherAction(async (url: string) => {
  opened.push(url);
  return openResult;
});

const alpha = join(tmp, "repo", "alpha");
const alphaKey = fakeKey("alpha-key");
await launcher.onWillAppear(ev(alphaKey, { directory: alpha }));
// The file exists long before the press: Warp has to have read it by then.
const alphaToml = tabConfigPath(tmp, tabConfigStem(alpha));
assert.ok(existsSync(alphaToml), "willAppear puts the Tab Config on disk, not only the press");
assert.equal(readFileSync(alphaToml, "utf8"), tabConfigToml(alpha), "…with exactly what tabConfigToml says");
assert.ok(svg(images.get("alpha-key")!).includes(">alpha</text>"), "the key takes the folder's name");

await launcher.onDidReceiveSettings(ev(alphaKey, { directory: `~/repo/alpha`, label: " Alpha ", command: "claude --resume" }));
assert.match(readFileSync(tabConfigPath(tmp, tabConfigStem(alpha)), "utf8"), /^commands = \["claude --resume"\]$/m, "a settings change refreshes the file");
assert.ok(svg(images.get("alpha-key")!).includes(">Alpha</text>"), "a label beats the basename");

// Retargeting: the old entry leaves Warp's + menu instead of sitting there forever.
const beta = join(tmp, "repo", "beta");
await launcher.onDidReceiveSettings(ev(alphaKey, { directory: beta }));
assert.ok(existsSync(tabConfigPath(tmp, tabConfigStem(beta))), "the new directory gets its own config");
assert.ok(!existsSync(tabConfigPath(tmp, tabConfigStem(alpha))), "…and the old one is taken back out");

// …unless a second key still points there: the stem comes from the directory alone.
const shared = join(tmp, "repo", "shared");
const oneKey = fakeKey("one");
const twoKey = fakeKey("two");
await launcher.onWillAppear(ev(oneKey, { directory: shared }));
await launcher.onWillAppear(ev(twoKey, { directory: shared, command: "claude --continue" }));
await launcher.onDidReceiveSettings(ev(oneKey, { directory: beta }));
assert.ok(existsSync(tabConfigPath(tmp, tabConfigStem(shared))), "a key still pointing there keeps its config");

// Clearing the field takes it out too, and the key admits it is unconfigured.
await launcher.onDidReceiveSettings(ev(twoKey, { directory: "  ", label: "Shared" }));
assert.ok(!existsSync(tabConfigPath(tmp, tabConfigStem(shared))), "the last key to leave turns out the light");
assert.ok(svg(images.get("two")!).includes(`>${UNSET_LABEL}</text>`), "a cleared key says so, whatever the label field holds");
await launcher.onDidReceiveSettings(ev(twoKey, { directory: "repo/typo" }));
assert.ok(svg(images.get("two")!).includes(`>${UNSET_LABEL}</text>`), "…and so does a relative path");
assert.deepEqual(configs(), [`${tabConfigStem(beta)}.toml`], "nothing was written for a path that isn't one");

const dialSettings = { directory: join(tmp, "repo", "dial") };
await launcher.onWillAppear(ev(fakeKey("dial", false), dialSettings));
await launcher.onDidReceiveSettings(ev(fakeKey("dial", false), dialSettings));
assert.equal(images.has("dial"), false, "a dial is not a launcher key");
assert.deepEqual(configs(), [`${tabConfigStem(beta)}.toml`], "…and writes nothing either");

// The press, with nothing configured: an alert, not a Warp tab.
const emptyKey = fakeKey("empty");
await launcher.onKeyDown(ev(emptyKey, { directory: " " }));
assert.equal(alerts.get("empty"), 1, "pressing an unconfigured key alerts");
assert.deepEqual(configs(), [`${tabConfigStem(beta)}.toml`], "…and opens nothing");
assert.deepEqual(opened, [], "…nothing at all");

// The press, configured. alphaKey points at beta since the retargeting above.
const betaToml = tabConfigPath(tmp, tabConfigStem(beta));
rmSync(betaToml); // the user emptied ~/.warp between two presses
await launcher.onKeyDown(ev(alphaKey, { directory: beta }));
assert.equal(readFileSync(betaToml, "utf8"), tabConfigToml(beta), "the press puts the config back before opening it");
assert.deepEqual(opened, [tabConfigUri(tabConfigStem(beta), false)], "…and opens that stem, as a tab in the focused window");
assert.equal(alerts.get("alpha-key"), undefined, "a press that worked does not alert");

await launcher.onKeyDown(ev(alphaKey, { directory: beta, newWindow: true, command: "claude --resume" }));
assert.equal(opened.at(-1), tabConfigUri(tabConfigStem(beta), true), "the newWindow checkbox reaches the URI");
assert.match(readFileSync(betaToml, "utf8"), /^commands = \["claude --resume"\]$/m, "…and the settings reach the file");

// Warp missing, or `open` refusing the scheme: the key says so rather than swallowing it.
openResult = { matched: false, reason: "open-failed: Unable to find application" };
await launcher.onKeyDown(ev(alphaKey, { directory: beta }));
assert.equal(alerts.get("alpha-key"), 1, "an open that failed alerts on the key");
assert.deepEqual(configs(), [`${tabConfigStem(beta)}.toml`], "…and wrote the config first anyway, for the next try");

rmSync(home, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
console.log("check-launcher: OK");
process.exit(0); // the SDK's connection attempt keeps the loop alive
