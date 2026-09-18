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
const MANIFEST_FILE = path.join(PLUGIN_DIR, "manifest.json");

// The manifest's Version is derived, not hand-maintained. release-please owns the release
// version and writes plain semver into the three JSON manifests that can hold it; Stream
// Deck's validator rejects anything but {major}.{minor}.{patch}.{build}, so this is the one
// place the fourth part is added. Stamping it here — on every build, before the profile is
// written — is what keeps the profile's embedded Plugin.Version, the manifest and the
// release in agreement; scripts/check-versions.mjs is the assert that they are.
const RELEASE_VERSION = JSON.parse(
  readFileSync(path.resolve(PLUGIN_DIR, "..", "..", "claude-code", ".claude-plugin", "plugin.json"), "utf8"),
).version;
const manifestText = readFileSync(MANIFEST_FILE, "utf8");
const manifest = JSON.parse(manifestText);
if (manifest.Version !== `${RELEASE_VERSION}.0`) {
  // A string replace, not a re-serialise: the manifest is hand-formatted and a JSON.stringify
  // round-trip would reflow the whole file on a version bump.
  writeFileSync(MANIFEST_FILE, manifestText.replace(`"Version": "${manifest.Version}"`, `"Version": "${RELEASE_VERSION}.0"`));
  console.log(`manifest.json Version ${manifest.Version} -> ${RELEASE_VERSION}.0`);
  manifest.Version = `${RELEASE_VERSION}.0`;
}
const PROFILE_NAME = manifest.Profiles[0].Name;
// Name, UUID and Version come from the manifest so a version bump can't leave the profile behind.
const PLUGIN = { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version };
const DEVICE_MODEL = "20GAT9901"; // Stream Deck XL, 8 columns x 4 rows
const COLUMNS = 8;
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

// Row 0: context, header, then queue/back/terminal on the right. Rows 1-2: one
// detail strip, a segment per key. Row 3: the option keys ("col,row" keys).
const actions = {
  "0,0": action("ask.context", {}),
  "1,0": action("ask.header", {}),
  "5,0": action("ask.queue", {}),
  "6,0": action("ask.back", {}),
  "7,0": action("ask.terminal", {}),
};
for (let segment = 0; segment < 2 * COLUMNS; segment++) {
  actions[`${segment % COLUMNS},${1 + Math.floor(segment / COLUMNS)}`] = action("ask.detail", { segment });
}
for (let slot = 0; slot < COLUMNS; slot++) {
  actions[`${slot},3`] = action("ask.option", { slot }, `Option ${slot + 1}`);
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

console.log(`built ${path.basename(outFile)} — ${Object.keys(actions).length} keys, ${COLUMNS} option slots`);
