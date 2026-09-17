// Self-check: the bundled "Claude Deck" profile has the 8x4 XL answer layout, and the
// manifest's action list matches the @action classes in src/ — registerAction throws
// at startup on a UUID the manifest lacks, which build and validate never notice.
// Run: node scripts/check-profile.mjs (builds the profile first)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const pluginDir = path.join(root, "com.phmatray.claudedeck.sdPlugin");
const manifest = JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));

// --- manifest actions == @action UUIDs -------------------------------------
const decorated = readdirSync(path.join(root, "src"), { recursive: true })
  .filter((f) => f.endsWith(".ts"))
  .flatMap((f) => [...readFileSync(path.join(root, "src", f), "utf8").matchAll(/@action\(\{\s*UUID:\s*"([^"]+)"\s*\}\)\s*export class (\w+)/g)]);
assert.deepEqual(decorated.map((m) => m[1]).sort(), manifest.Actions.map((a) => a.UUID).sort(), "manifest Actions and @action UUIDs agree");
// ...and plugin.ts instantiates each one for registerAction: a dropped class builds,
// validates and starts fine, its key just shows the manifest image and does nothing.
const pluginTs = readFileSync(path.join(root, "src", "plugin.ts"), "utf8");
for (const [, uuid, cls] of decorated) assert.ok(pluginTs.includes(`new ${cls}(`), `plugin.ts registers ${cls} (${uuid})`);

// --- the built profile --------------------------------------------------------
execFileSync(process.execPath, [path.join(root, "scripts", "build-profile.mjs")], { stdio: "ignore" });
const archive = path.join(pluginDir, `${manifest.Profiles[0].Name}.streamDeckProfile`);
const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n");
const read = (name) => JSON.parse(execFileSync("unzip", ["-p", archive, name], { encoding: "utf8" }));

const [umbrella] = entries.filter((e) => /^[0-9A-F-]+\.sdProfile\/manifest\.json$/.test(e));
assert.ok(umbrella, "<UUID>.sdProfile/ at the archive root, no wrapper directory");
const top = read(umbrella);
assert.deepEqual([top.Version, top.Device.Model, top.Name], ["3.0", "20GAT9901", "Claude Deck"]);
assert.notEqual(top.Pages.Current, top.Pages.Default, "a distinct hidden Default page");
const page = read(umbrella.replace("manifest.json", `Profiles/${top.Pages.Current.toUpperCase()}/manifest.json`));
assert.equal(page.Controllers[0].Type, "Keypad");

const plugin = { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version };
const got = {};
for (const [pos, a] of Object.entries(page.Controllers[0].Actions)) {
  assert.deepEqual(a.Plugin, plugin, `${pos}: plugin from the manifest`);
  got[pos] = [a.UUID.slice(plugin.UUID.length + 1), a.Settings];
}
const want = { "0,0": ["ask.context", {}], "1,0": ["ask.header", {}], "5,0": ["ask.queue", {}], "6,0": ["ask.back", {}], "7,0": ["ask.terminal", {}] };
for (let c = 0; c < 8; c++) {
  want[`${c},1`] = ["ask.detail", { segment: c }];
  want[`${c},2`] = ["ask.detail", { segment: 8 + c }];
  want[`${c},3`] = ["ask.option", { slot: c }];
}
assert.deepEqual(got, want);

console.log("ok: profile + manifest actions");
