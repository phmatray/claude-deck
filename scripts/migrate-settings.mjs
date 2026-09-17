#!/usr/bin/env node
// One-time cleanup for claude-deck 3.0: the status hooks now ship inside the Claude
// Code plugin (claude-code/hooks/hooks.json), so the copies the old install-hook.sh
// wrote into ~/.claude/settings.json make every event log twice. This removes them.
//
// Backs up settings.json to settings.json.bak.<yyyymmdd>-claude-deck-v3 first (an
// existing backup is never overwritten), removes every hook whose command matches the
// legacy regex, drops the matcher groups and event keys that leaves empty, and writes
// the file back as 2-space JSON. Run it after `claude plugin update claude-deck@phmatray`:
// it refuses (exit 1) to remove a hook for an event the installed, enabled claude-deck
// plugin does not register itself yet — those legacy hooks are then the dashboard's only
// event feed. --force skips that guard.
//
// Usage: node scripts/migrate-settings.mjs [--dry-run] [--force]
// Self-check: node scripts/check-migrate-settings.mjs
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LEGACY_RE = /(streamdeck-claude|claude-deck).*notification\.(sh|ps1)/;
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const claudeDir = path.join(homedir(), ".claude");
const file = path.join(claudeDir, "settings.json");

if (!existsSync(file)) {
  console.log(`nothing to do: ${file} does not exist`);
  process.exit(0);
}
const settings = JSON.parse(readFileSync(file, "utf8"));
const hooks = settings.hooks ?? {};

const removed = [];
const removedEvents = new Set();
for (const [event, groups] of Object.entries(hooks)) {
  if (!Array.isArray(groups)) continue;
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((h) => {
      const legacy = LEGACY_RE.test(String(h?.command ?? ""));
      if (legacy) {
        removed.push(`${event}: ${h.command}`);
        removedEvents.add(event);
      }
      return !legacy;
    });
    // Only groups this script emptied go; a group that was already empty is not ours to judge.
    if (rest.length > 0 || group.hooks.length === 0) kept.push({ ...group, hooks: rest });
  }
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
}

if (removed.length === 0) {
  console.log(`no legacy claude-deck hooks in ${file}`);
  process.exit(0);
}
for (const line of removed) console.log(`${dryRun ? "would remove" : "removed"} ${line}`);

const covered = pluginEvents();
const uncovered = [...removedEvents].filter((event) => !covered.has(event));
if (uncovered.length > 0 && !force) {
  console.error(`refusing: the installed claude-deck plugin does not register ${uncovered.join(", ")} (not enabled, not installed, or pre-3.0),`);
  console.error("so removing these hooks would cut the dashboard's event feed. Run `claude plugin update claude-deck@phmatray` first, or pass --force.");
  process.exit(1);
}
if (dryRun) {
  console.log(`dry run: ${removed.length} hook(s) would be removed, ${file} untouched`);
  process.exit(0);
}

const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const backup = `${file}.bak.${stamp}-claude-deck-v3`;
if (existsSync(backup)) console.log(`backup kept: ${backup} already exists`);
else copyFileSync(file, backup);

if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log(`${removed.length} legacy hook(s) removed from ${file} (backup: ${backup})`);

/** Events the enabled claude-deck plugin's installed hooks.json sends to notification.sh
 *  catch-all — stream-deck/src/hook-check.ts's rules, reduced to what this script needs. */
function pluginEvents() {
  const readJson = (f) => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return undefined;
    }
  };
  const enabled = settings.enabledPlugins ?? {};
  const key = Object.keys(enabled).find((k) => /^claude-deck@/.test(k) && enabled[k] === true);
  const entries = key ? readJson(path.join(claudeDir, "plugins", "installed_plugins.json"))?.plugins?.[key] : undefined;
  const installPath = Array.isArray(entries) ? (entries.find((e) => e?.scope === "user") ?? entries[0])?.installPath : undefined;
  const hooks = typeof installPath === "string" ? readJson(path.join(installPath, "hooks", "hooks.json"))?.hooks ?? {} : {};
  return new Set(Object.entries(hooks).filter(([, groups]) => Array.isArray(groups) && groups.some((g) =>
    ["", "*", undefined].includes(g?.matcher) && Array.isArray(g?.hooks) &&
    g.hooks.some((h) => /\/hooks\/notification\.sh$/.test(String(h?.command ?? ""))))).map(([event]) => event));
}
