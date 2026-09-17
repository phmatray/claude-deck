#!/usr/bin/env node
// Generates the "Claude Deck" profile that ships inside the Stream Deck plugin:
// com.phmatray.claudedeck.sdPlugin/<Profiles[0].Name>.streamDeckProfile. Runs as
// part of `pnpm build`, because `streamdeck validate` fails when the file named
// by the manifest's Profiles entry is missing.
//
// The format is fussy and fails quietly, so the details here are load-bearing:
//   * Version must be "3.0". A "2.0" profile is handed to a legacy importer that
//     rejects it outright ("no pages in umbrella").
//   * Every controller needs "Type": "Keypad". Without it the profile imports
//     but the importer silently discards every key and substitutes blank pages.
//   * The profile needs a second, hidden "Default" page distinct from "Current".
//     Pointing both at the same page id fails with "duplicate".
//   * The archive holds <UUID>.sdProfile/ at its root — no wrapper directory.
//     (A Profiles/ + Resources/ wrapper is the *backup* format, not this one.)
// Reference for all of the above: the app's own export in
// ~/Library/Application Support/com.elgato.StreamDeck/BackupV3/
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.phmatray.claudedeck.sdPlugin");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
const PROFILE_NAME = manifest.Profiles[0].Name;
// Name, UUID and Version come from the manifest so a version bump can't leave the profile behind.
const PLUGIN = { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version };
const DEVICE_MODEL = "20GAT9901"; // Stream Deck XL — the 5x3 layout sits in its top-left corner
const COLUMNS = 5;
const OPTION_ROWS = [1, 2];
const outFile = path.join(PLUGIN_DIR, `${PROFILE_NAME}.streamDeckProfile`);

function state() {
  return {
    FontFamily: "", FontSize: 10, FontStyle: "", FontUnderline: false,
    OutlineThickness: 2, ShowTitle: false, TitleAlignment: "middle",
    TitleColor: "#ffffff",
  };
}

function action(suffix, settings, name) {
  const uuid = `${PLUGIN.UUID}.${suffix}`;
  const declared = manifest.Actions.find((a) => a.UUID === uuid);
  if (!declared) throw new Error(`${uuid} is not declared in manifest.json`);
  return {
    ActionID: randomUUID(),
    LinkedTitle: false,
    Name: name ?? declared.Name,
    Plugin: PLUGIN,
    Resources: null,
    Settings: settings,
    State: 0,
    States: [state()],
    UUID: uuid,
  };
}

const actions = {
  "0,0": action("ask.context", {}),
  "1,0": action("ask.header", {}),
  "4,0": action("ask.terminal", {}),
};
let slot = 0;
for (const y of OPTION_ROWS) {
  for (let x = 0; x < COLUMNS; x++) {
    actions[`${x},${y}`] = action("ask.option", { slot }, `Option ${slot + 1}`);
    slot++;
  }
}

const profileId = randomUUID().toUpperCase();
const pageId = randomUUID();
const defaultPageId = randomUUID();

const staging = mkdtempSync(path.join(tmpdir(), "claude-deck-profile-"));
const root = path.join(staging, `${profileId}.sdProfile`);

function writePage(id, acts) {
  const dir = path.join(root, "Profiles", id.toUpperCase());
  mkdirSync(path.join(dir, "Images"), { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ Controllers: [{ Actions: acts, Type: "Keypad" }], Icon: "", Name: "" })
  );
}

writePage(pageId, actions);
writePage(defaultPageId, null);
writeFileSync(
  path.join(root, "manifest.json"),
  JSON.stringify({
    Device: { Model: DEVICE_MODEL, UUID: "" },
    InstalledByPluginUUID: PLUGIN.UUID,
    Name: PROFILE_NAME,
    PreconfiguredName: PROFILE_NAME,
    Pages: { Current: pageId, Default: defaultPageId, Pages: [pageId] },
    Version: "3.0",
  })
);

// The `zip` tool writes real directory entries; archives built with naive
// zip libraries can extract without them and lose the Profiles/ subtree.
rmSync(outFile, { force: true });
execFileSync("zip", ["-qry", outFile, ".", "-x", "*.DS_Store"], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

console.log(`built ${path.basename(outFile)} — ${Object.keys(actions).length} keys, ${slot} option slots`);
