#!/usr/bin/env node
// One-time Stream Deck profile migration for claude-deck 3.0: the dashboard keys
// placed with the old "Claude Sessions" plugin (com.julien.claudesessions) are
// re-pointed at the merged plugin (com.phmatray.claudedeck), so every key keeps its
// position and settings instead of turning into a "missing plugin" tile.
//
// QUIT THE STREAM DECK APP FIRST: it rewrites these files itself. The script refuses to
// touch the app's own ProfilesV3 folder while "Stream Deck" is running.
//
//   * Backs up the whole profiles folder to <dir>.bak-<yyyymmdd>-claude-deck-v3
//     (an existing backup is kept, never overwritten).
//   * In every <profile>.sdProfile/Profiles/<page>/manifest.json, each action whose
//     Plugin.UUID is com.julien.claudesessions — multi-action children included — gets
//     the new UUID prefix, the new Plugin {Name, UUID, Version} and the new action Name,
//     all read from the plugin manifest. Nothing is added or removed: the app offers to
//     restore a backup when a page's action count drops.
//   * Actions of the old answer-keys plugin (com.claudeask.streamdeck) are left alone.
//     Its imported "Claude Ask" profile is listed; with --remove-old-ask-profile it is
//     moved into the backup folder (the new plugin installs its own "Claude Deck" one).
//   * Files are written back compact with no trailing newline, as the app writes them.
//
// Usage: node scripts/migrate-profiles.mjs [--dry-run] [--profiles-dir <dir>] [--remove-old-ask-profile]
// Self-check: node scripts/check-migrate-profiles.mjs
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const OLD_UUID = "com.julien.claudesessions";
const OLD_ASK_UUID = "com.claudeask.streamdeck";
const APP_DIR = path.join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck");
const manifest = JSON.parse(
  readFileSync(new URL("../stream-deck/com.phmatray.claudedeck.sdPlugin/manifest.json", import.meta.url), "utf8"),
);
const PLUGIN = { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const removeOldAsk = args.includes("--remove-old-ask-profile");
const dirAt = args.indexOf("--profiles-dir");
if (dirAt >= 0 && !args[dirAt + 1]) {
  console.error("--profiles-dir needs a directory");
  process.exit(1);
}
const profilesDir = path.resolve(dirAt >= 0 ? args[dirAt + 1] : path.join(APP_DIR, "ProfilesV3"));
if (!existsSync(profilesDir)) {
  console.error(`no profiles folder at ${profilesDir}`);
  process.exit(1);
}

function appRunning() {
  try {
    execFileSync("pgrep", ["-x", "Stream Deck"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
// Only the app's own folder is at risk from the running app; a copy elsewhere is fair game.
// Real paths, so a symlink or another letter case can't slip past.
const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};
if (!dryRun && real(profilesDir).startsWith(real(APP_DIR) + path.sep) && appRunning()) {
  console.error("Stream Deck is running: quit the app first, it would overwrite the migrated profiles");
  process.exit(1);
}

/** Re-points every old dashboard action under `node` (a parsed page manifest, walked
 *  whole so multi-action children are covered). Returns how many it rewrote. */
function rewrite(node) {
  if (Array.isArray(node)) return node.reduce((n, child) => n + rewrite(child), 0);
  if (!node || typeof node !== "object") return 0;
  let n = 0;
  if (node.Plugin?.UUID === OLD_UUID && typeof node.UUID === "string" && node.UUID.startsWith(`${OLD_UUID}.`)) {
    node.UUID = PLUGIN.UUID + node.UUID.slice(OLD_UUID.length);
    node.Plugin = { ...PLUGIN };
    const declared = manifest.Actions.find((a) => a.UUID === node.UUID);
    if (declared) node.Name = declared.Name;
    n++;
  }
  for (const child of Object.values(node)) n += rewrite(child);
  return n;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const pages = [];
const oldAskProfiles = [];
for (const profile of readdirSync(profilesDir).filter((name) => name.endsWith(".sdProfile")).sort()) {
  const root = path.join(profilesDir, profile);
  if (existsSync(path.join(root, "manifest.json"))) {
    const top = readJson(path.join(root, "manifest.json"));
    if (top.InstalledByPluginUUID === OLD_ASK_UUID) oldAskProfiles.push({ profile, name: top.Name });
  }
  const pagesDir = path.join(root, "Profiles");
  for (const page of existsSync(pagesDir) ? readdirSync(pagesDir).sort() : []) {
    const file = path.join(pagesDir, page, "manifest.json");
    if (!existsSync(file)) continue;
    const json = readJson(file);
    const count = rewrite(json);
    if (count > 0) pages.push({ file, json, count });
  }
}

for (const { file, count } of pages) console.log(`${path.relative(profilesDir, file)}: ${count} action(s)`);
for (const { profile, name } of oldAskProfiles) {
  console.log(`old answer-keys profile "${name}": ${profile}${removeOldAsk ? "" : " (pass --remove-old-ask-profile to move it into the backup)"}`);
}
const toRemove = removeOldAsk ? oldAskProfiles : [];
if (pages.length === 0 && toRemove.length === 0) {
  console.log("nothing to migrate");
  process.exit(0);
}
const total = pages.reduce((n, p) => n + p.count, 0);
if (dryRun) {
  console.log(`dry run: ${total} action(s) in ${pages.length} page(s) would be migrated, ${toRemove.length} profile(s) removed`);
  process.exit(0);
}

const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const backup = `${profilesDir}.bak-${stamp}-claude-deck-v3`;
if (existsSync(backup)) console.log(`backup kept: ${backup} already exists`);
else cpSync(profilesDir, backup, { recursive: true, verbatimSymlinks: true });

for (const { file, json } of pages) writeFileSync(file, JSON.stringify(json));
for (const { profile } of toRemove) {
  const src = path.join(profilesDir, profile);
  const dest = path.join(backup, profile);
  // The backup normally holds a copy already; an older same-day backup might not.
  if (existsSync(dest)) rmSync(src, { recursive: true, force: true });
  else renameSync(src, dest);
}
console.log(`${total} action(s) in ${pages.length} page(s) migrated, ${toRemove.length} profile(s) moved out (backup: ${backup})`);
