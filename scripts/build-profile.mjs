#!/usr/bin/env node
// Generates the "Claude Ask" profile that ships inside the Stream Deck plugin.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const PLUGIN_UUID = "com.claudeask.streamdeck";
const PROFILE_NAME = "Claude Ask";
const PLUGIN_VERSION = "1.0.0.0";
const DEVICE_MODEL = "20GBA9901"; // 5x3 Stream Deck / MK.2
const COLUMNS = 5;
const OPTION_ROWS = [1, 2];

const outFile = process.argv[2];
if (!outFile) {
  console.error("usage: build-profile.mjs <output.streamDeckProfile>");
  process.exit(1);
}

function state() {
  return {
    FontFamily: "", FontSize: 10, FontStyle: "", FontUnderline: false,
    OutlineThickness: 2, ShowTitle: false, TitleAlignment: "middle",
    TitleColor: "#ffffff",
  };
}

function action(uuid, name, settings) {
  return {
    ActionID: randomUUID(),
    LinkedTitle: false,
    Name: name,
    Plugin: { Name: PROFILE_NAME, UUID: PLUGIN_UUID, Version: PLUGIN_VERSION },
    Resources: null,
    Settings: settings,
    State: 0,
    States: [state()],
    UUID: uuid,
  };
}

const actions = {
  "0,0": action(`${PLUGIN_UUID}.context`, "Session Context", {}),
  "1,0": action(`${PLUGIN_UUID}.question`, "Question", {}),
  "4,0": action(`${PLUGIN_UUID}.cancel`, "Answer in Terminal", {}),
};
let slot = 0;
for (const y of OPTION_ROWS) {
  for (let x = 0; x < COLUMNS; x++) {
    actions[`${x},${y}`] = action(`${PLUGIN_UUID}.option`, `Option ${slot + 1}`, { slot });
    slot++;
  }
}

const profileId = randomUUID().toUpperCase();
const pageId = randomUUID();
const defaultPageId = randomUUID();

const staging = mkdtempSync(path.join(tmpdir(), "claude-ask-profile-"));
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
    InstalledByPluginUUID: PLUGIN_UUID,
    Name: PROFILE_NAME,
    PreconfiguredName: PROFILE_NAME,
    Pages: { Current: pageId, Default: defaultPageId, Pages: [pageId] },
    Version: "3.0",
  })
);

// The `zip` tool writes real directory entries; archives built with naive
// zip libraries can extract without them and lose the Profiles/ subtree.
rmSync(outFile, { force: true });
execFileSync("zip", ["-qry", path.resolve(outFile), ".", "-x", "*.DS_Store"], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

console.log(`built ${outFile} — ${Object.keys(actions).length} keys, ${slot} option slots`);
