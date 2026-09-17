#!/usr/bin/env node
// One-time cleanup for claude-deck 3.0: the status hooks now ship inside the Claude
// Code plugin (claude-code/hooks/hooks.json), so the copies the old install-hook.sh
// wrote into ~/.claude/settings.json make every event log twice. This removes them.
//
// Backs up settings.json to settings.json.bak.<yyyymmdd>-claude-deck-v3 first (an
// existing backup is never overwritten), removes every hook whose command matches the
// legacy regex, drops the matcher groups and event keys that leaves empty, and writes
// the file back as 2-space JSON. Run it after `claude plugin update claude-deck@phmatray`.
//
// Usage: node scripts/migrate-settings.mjs [--dry-run]
// Self-check: node scripts/check-migrate-settings.mjs
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LEGACY_RE = /(streamdeck-claude|claude-deck).*notification\.(sh|ps1)/;
const dryRun = process.argv.includes("--dry-run");
const file = path.join(homedir(), ".claude", "settings.json");

if (!existsSync(file)) {
  console.log(`nothing to do: ${file} does not exist`);
  process.exit(0);
}
const settings = JSON.parse(readFileSync(file, "utf8"));
const hooks = settings.hooks ?? {};

const removed = [];
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
      if (legacy) removed.push(`${event}: ${h.command}`);
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
