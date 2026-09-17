// Self-check: the launcher key's pure half — the Warp Tab Config it writes
// (src/launcher/tab-config.ts) and the art it paints (src/launcher/render.ts).
// Hermetic: every write goes to a temp HOME, so the real ~/.warp is never touched.
// Run: pnpm exec tsx scripts/check-launcher.mts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COMMAND,
  expandHome,
  tabConfigSlug,
  tabConfigStem,
  tabConfigToml,
  tabConfigUri,
  writeTabConfig,
} from "../src/launcher/tab-config.ts";
import { launcherKey, UNSET_LABEL } from "../src/launcher/render.ts";

const home = mkdtempSync(join(tmpdir(), "claude-deck-launcher-"));

// ── the typed directory → an absolute path ───────────────────────────────────
assert.equal(expandHome("~/repo/x", home), join(home, "repo/x"), "~ is the user's home, not a folder called ~");
assert.equal(expandHome("~", home), home, "a bare ~ too");
assert.equal(expandHome("  /a/b/  ", home), "/a/b", "typed whitespace and a trailing slash are noise");
assert.equal(expandHome("/a/b/../c", home), "/a/c", "…and so is a detour through ..");
assert.equal(expandHome("", home), "", "nothing typed stays nothing — the key is unconfigured");
assert.equal(expandHome("   ", home), "", "…spaces included");
assert.ok(!expandHome("~notauser/x", home).startsWith(home), "only ~/ expands: ~user is the shell's trick, not ours");

// ── slug: readable, filename-safe, and collision-free ────────────────────────
assert.match(tabConfigSlug("/Users/p/repo/My Project"), /^my_project_[0-9a-f]{6}$/, "basename lowercased, punctuation to _, 6 hex of the path");
assert.equal(tabConfigStem("/Users/p/repo/x"), `claude_deck_${tabConfigSlug("/Users/p/repo/x")}`, "the stem is the slug behind our prefix");
assert.match(tabConfigStem("/a/Été-2026"), /^claude_deck_[a-z0-9_]+$/, "non-ASCII never reaches the filename");
const twins = ["/Users/p/work/api", "/Users/p/perso/api"].map(tabConfigStem);
assert.notEqual(twins[0], twins[1], "two checkouts named api get two configs, not one overwritten");
assert.equal(tabConfigStem("/Users/p/work/api"), twins[0], "…and the same path always maps to the same one");

// ── TOML: what Warp reads ────────────────────────────────────────────────────
const toml = tabConfigToml("/Users/p/repo/deck");
assert.match(toml, /^name = "Claude Deck · deck"$/m, "the name Warp lists in its + menu");
assert.match(toml, /^\[\[panes\]\]$/m, "one pane");
assert.match(toml, /^type = "terminal"$/m);
assert.match(toml, /^directory = "\/Users\/p\/repo\/deck"$/m);
assert.match(toml, /^commands = \["claude"\]$/m, `the default command is ${DEFAULT_COMMAND}`);
assert.match(toml, /^is_focused = true$/m);
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
assert.equal(first.path, join(home, ".warp", "tab_configs", `${first.stem}.toml`), "Warp's own folder, our own stem");
assert.equal(first.written, true, "a missing file is written");
assert.equal(readFileSync(first.path, "utf8"), tabConfigToml(dir), "on disk is exactly what tabConfigToml says");

const again = await writeTabConfig(home, dir);
assert.equal(again.written, false, "an unchanged key does not churn the file Warp lists");
assert.equal(again.path, first.path);

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

rmSync(home, { recursive: true, force: true });
console.log("check-launcher: OK");
