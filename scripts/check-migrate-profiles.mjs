// Self-check for scripts/migrate-profiles.mjs on a copied fixture shaped like a real
// ProfilesV3 folder: a dashboard profile with slot/usage/setup keys (one inside a
// multi-action) and the imported "Claude Ask" profile.
// Run: node scripts/check-migrate-profiles.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = new URL("./migrate-profiles.mjs", import.meta.url).pathname;
const tmp = mkdtempSync(path.join(tmpdir(), "claude-deck-migrate-profiles-"));
const run = (dir, ...args) =>
  execFileSync(process.execPath, [SCRIPT, "--profiles-dir", dir, ...args], { env: { ...process.env, HOME: tmp }, encoding: "utf8" });

const states = [{ FontFamily: "", FontSize: 12, FontStyle: "", FontUnderline: false, OutlineThickness: 2, ShowTitle: false, TitleAlignment: "middle", TitleColor: "#ffffff" }];
let ids = 0;
const sessions = (kind, name, settings = {}) => ({
  ActionID: `id-${ids++}`, LinkedTitle: false, Name: name,
  Plugin: { Name: "Claude Sessions", UUID: "com.julien.claudesessions", Version: "0.1.1.0" },
  Resources: null, Settings: settings, State: 0, States: states, UUID: `com.julien.claudesessions.${kind}`,
});
const ask = (kind, name, settings = {}) => ({
  ActionID: `id-${ids++}`, LinkedTitle: false, Name: name,
  Plugin: { Name: "Claude Ask", UUID: "com.claudeask.streamdeck", Version: "1.0.0.0" },
  Resources: null, Settings: settings, State: 0, States: states, UUID: `com.claudeask.streamdeck.${kind}`,
});
const hotkey = { ActionID: "hk", LinkedTitle: true, Name: "Hotkey", Plugin: { Name: "Activate a Key Command", UUID: "com.elgato.streamdeck.system.hotkey", Version: "1.0" }, Resources: null, Settings: { Coalesce: true }, State: 0, States: states, UUID: "com.elgato.streamdeck.system.hotkey" };
const page = (actions) => ({ Controllers: [{ Actions: actions, Type: "Keypad" }], Icon: "", Name: "" });

function write(file, json) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
}

/** A ProfilesV3-shaped folder; returns its path. */
function fixture(name) {
  const dir = path.join(tmp, name, "ProfilesV3");
  const dash = path.join(dir, "68A65C70-0784-47E2-8BA1-F99FEAA1B7F2.sdProfile");
  write(path.join(dash, "manifest.json"), { Device: { Model: "20GAT9901", UUID: "@(1)[4057/108/CL10K1A13942]" }, Name: "Default Profile", Pages: { Current: "c74a54b6", Default: "820ac9c2", Pages: ["45ad792a", "c74a54b6"] }, Version: "3.0" });
  const slots = {};
  for (let c = 0; c < 8; c++) slots[`${c},2`] = sessions("slot", "Claude Session Slot");
  slots["0,0"] = hotkey;
  write(path.join(dash, "Profiles", "45AD792A", "manifest.json"), page(slots));
  write(path.join(dash, "Profiles", "C74A54B6", "manifest.json"), page({
    "0,0": sessions("usage.session", "Claude Usage (pre-3.0 name)"),
    "1,0": sessions("usage.week", "Claude Usage: Week (all models)"),
    "2,0": sessions("usage.models", "Claude Usage: Week (per model)"),
    "7,0": sessions("setup", "Claude Setup"),
    "0,1": { ...hotkey, Name: "Multi Action", UUID: "com.elgato.streamdeck.multiactions", Plugin: { Name: "Multi Action", UUID: "com.elgato.streamdeck.multiactions", Version: "1.0" },
      Actions: [{ Actions: [sessions("slot", "Claude Session Slot"), hotkey] }] },
    "1,1": ask("option", "Option 1", { slot: 0 }),
  }));
  write(path.join(dash, "Profiles", "820AC9C2", "manifest.json"), page(null));
  writeFileSync(path.join(dash, "Profiles", "C74A54B6", "icon.png"), "png");

  const askProfile = path.join(dir, "05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile");
  write(path.join(askProfile, "manifest.json"), { Device: { Model: "20GAT9901", UUID: "" }, InstalledByPluginUUID: "com.claudeask.streamdeck", Name: "Claude Ask", Pages: { Current: "83d98f04", Default: "748509a8", Pages: ["83d98f04"] }, PreconfiguredName: "Claude Ask", ReadOnly: false, Version: "3.0" });
  write(path.join(askProfile, "Profiles", "83D98F04", "manifest.json"), page({ "0,0": ask("context", "Session Context"), "0,1": ask("option", "Option 1", { slot: 0 }) }));
  return dir;
}

/** path → content for every file under `dir`. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
const countActions = (text) => (text.match(/"ActionID"/g) ?? []).length;
const backupOf = (dir) => readdirSync(path.dirname(dir)).filter((n) => /^ProfilesV3\.bak-\d{8}-claude-deck-v3$/.test(n));

// --- dry run: reports, touches nothing -------------------------------------
const dir = fixture("a");
const before = snapshot(dir);
const dry = run(dir, "--dry-run");
assert.match(dry, /dry run: 13 action\(s\) in 2 page\(s\) would be migrated, 0 profile\(s\) removed/);
assert.match(dry, /old answer-keys profile "Claude Ask": 05430350-AE6C-4636-8F07-9FF7D5A991CA\.sdProfile \(pass --remove-old-ask-profile/);
assert.deepEqual(snapshot(dir), before);
assert.deepEqual(backupOf(dir), []);

// --- real run ---------------------------------------------------------------
assert.match(run(dir), /13 action\(s\) in 2 page\(s\) migrated, 0 profile\(s\) moved out/);
const [backup] = backupOf(dir);
assert.ok(backup, "backup folder created");
assert.deepEqual(snapshot(path.join(path.dirname(dir), backup)), before, "backup is a full copy of the original");

const after = snapshot(dir);
assert.deepEqual(Object.keys(after), Object.keys(before), "no file added or removed");
for (const [file, text] of Object.entries(after)) {
  if (!file.endsWith("manifest.json")) continue;
  assert.equal(countActions(text), countActions(before[file]), `${file}: action count unchanged`);
  assert.equal(text, JSON.stringify(JSON.parse(text)), `${file}: compact, no trailing newline`);
  assert.ok(!text.includes("com.julien.claudesessions"), `${file}: no old UUID left`);
}
// Read from the manifest the migration itself reads, rather than pinning a literal: the
// Version there is stamped from the release version on every build, so a hard-coded copy
// turns every release PR red for a reason that has nothing to do with the migration.
const manifest = JSON.parse(
  readFileSync(new URL("../stream-deck/com.phmatray.claudedeck.sdPlugin/manifest.json", import.meta.url), "utf8"),
);
const newPlugin = { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version };
const usagePage = JSON.parse(after["68A65C70-0784-47E2-8BA1-F99FEAA1B7F2.sdProfile/Profiles/C74A54B6/manifest.json"]).Controllers[0].Actions;
assert.deepEqual(
  { ...usagePage["7,0"], States: undefined },
  { ActionID: usagePage["7,0"].ActionID, LinkedTitle: false, Name: "Claude Setup", Plugin: newPlugin, Resources: null, Settings: {}, State: 0, States: undefined, UUID: "com.phmatray.claudedeck.setup" },
);
assert.deepEqual([usagePage["0,0"].UUID, usagePage["0,0"].Name], ["com.phmatray.claudedeck.usage.session", "Claude Usage: Session (5h)"], "Name follows the new manifest");
const [child, hotkeyChild] = usagePage["0,1"].Actions[0].Actions;
assert.deepEqual([child.UUID, child.Plugin], ["com.phmatray.claudedeck.slot", newPlugin], "multi-action child migrated");
assert.deepEqual(hotkeyChild, hotkey, "other plugins untouched");
assert.equal(usagePage["0,1"].UUID, "com.elgato.streamdeck.multiactions");
assert.deepEqual(usagePage["1,1"].Plugin.UUID, "com.claudeask.streamdeck", "old answer-key actions untouched");
assert.equal(
  after["05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile/Profiles/83D98F04/manifest.json"],
  before["05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile/Profiles/83D98F04/manifest.json"],
);
assert.ok(existsSync(path.join(dir, "05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile")), "old ask profile kept without the flag");

// --- second run: nothing left to rewrite; the flag moves the old ask profile out, backup untouched
assert.match(run(dir), /nothing to migrate/);
assert.match(run(dir, "--remove-old-ask-profile"), /backup kept[\s\S]*0 action\(s\) in 0 page\(s\) migrated, 1 profile\(s\) moved out/);
assert.ok(!existsSync(path.join(dir, "05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile")));
assert.deepEqual(snapshot(path.join(path.dirname(dir), backup)), before, "existing backup never overwritten");

// --- an earlier same-day backup that predates the ask profile still receives it
const dir2 = fixture("b");
mkdirSync(path.join(path.dirname(dir2), backup));
run(dir2, "--remove-old-ask-profile");
assert.ok(existsSync(path.join(path.dirname(dir2), backup, "05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile", "manifest.json")));
assert.ok(!existsSync(path.join(dir2, "05430350-AE6C-4636-8F07-9FF7D5A991CA.sdProfile")));

// --- the app's own folder is refused while "Stream Deck" runs, even through a symlink
const fakeBin = path.join(tmp, "bin");
mkdirSync(fakeBin);
writeFileSync(path.join(fakeBin, "pgrep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // "the app is running"
const appProfiles = fixture("Library/Application Support/com.elgato.StreamDeck");
symlinkSync(appProfiles, path.join(tmp, "alias"));
const appBefore = snapshot(appProfiles);
for (const spelling of [appProfiles, path.join(tmp, "alias")]) {
  const r = spawnSync(process.execPath, [SCRIPT, "--profiles-dir", spelling], {
    env: { ...process.env, HOME: tmp, PATH: `${fakeBin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, `${spelling}: refused`);
  assert.match(r.stderr, /Stream Deck is running/);
}
assert.deepEqual(snapshot(appProfiles), appBefore);
assert.deepEqual(backupOf(appProfiles), []);

rmSync(tmp, { recursive: true, force: true });
console.log("ok: migrate-profiles");
