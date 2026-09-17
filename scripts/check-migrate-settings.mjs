// Self-check for scripts/migrate-settings.mjs against a temp HOME: legacy hooks go,
// everything else stays, the backup is taken once and never overwritten, and nothing is
// removed while the installed claude-deck plugin does not register those events itself.
// Run: node scripts/check-migrate-settings.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = new URL("./migrate-settings.mjs", import.meta.url).pathname;
const home = mkdtempSync(path.join(tmpdir(), "claude-deck-migrate-settings-"));
const claudeDir = path.join(home, ".claude");
const file = path.join(claudeDir, "settings.json");
mkdirSync(claudeDir, { recursive: true });

const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
const refused = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  return r.stderr;
};

// The enabled claude-deck plugin, installed from the repo's own hooks.json.
const installPath = path.join(claudeDir, "plugins", "cache", "phmatray", "claude-deck", "3.0.0");
mkdirSync(path.join(installPath, "hooks"), { recursive: true });
const installHooks = (hooks) => writeFileSync(path.join(installPath, "hooks", "hooks.json"), JSON.stringify(hooks));
const repoHooks = JSON.parse(readFileSync(new URL("../claude-code/hooks/hooks.json", import.meta.url), "utf8"));
installHooks(repoHooks);
writeFileSync(
  path.join(claudeDir, "plugins", "installed_plugins.json"),
  JSON.stringify({ version: 2, plugins: { "claude-deck@phmatray": [{ scope: "user", installPath, version: "3.0.0" }] } }),
);
const legacy = (cmd) => ({ type: "command", command: cmd });
const other = { type: "command", command: "/usr/local/bin/my-audit-hook" };
// Must survive: the regex needs BOTH the project name and notification.(sh|ps1).
const otherNotify = { type: "command", command: "/opt/other-tool/hooks/notification.sh", timeout: 5 };
const permission = { type: "command", command: "/Users/me/claude-deck/claude-code/bin/claude-permission" };

const original = {
  model: "opus",
  hooks: {
    SessionStart: [{ matcher: "", hooks: [legacy("/Users/me/claude-deck/status/hooks/notification.sh")] }],
    PreToolUse: [
      { matcher: "", hooks: [legacy("/Users/me/streamdeck-claude/hooks/notification.sh"), other, otherNotify, permission], _note: "kept" },
      { matcher: "Bash", hooks: [other] },
    ],
    Stop: [{ matcher: "", hooks: [legacy("bash '/home/j/streamdeck-claude/hooks/notification.ps1'")] }, { matcher: "", hooks: [] }],
    Notification: [{ matcher: "", hooks: [other] }],
  },
  enabledPlugins: { "claude-deck@phmatray": true },
};
const originalText = JSON.stringify(original, null, 4);
writeFileSync(file, originalText);
const backups = () => readdirSync(claudeDir).filter((f) => f.startsWith("settings.json.bak."));

// installed plugin still 2.0.0 (PermissionRequest only): refuse, dry run included, touch nothing
installHooks({ hooks: { PermissionRequest: repoHooks.hooks.PermissionRequest } });
assert.match(refused(), /does not register SessionStart, PreToolUse, Stop .*--force/s);
assert.match(refused("--dry-run"), /refusing/);
// only the event actually missing is named; a "*" matcher counts as catch-all
const partial = structuredClone(repoHooks);
delete partial.hooks.Stop;
partial.hooks.PreToolUse[0].matcher = "*";
installHooks(partial);
assert.match(refused(), /does not register Stop \(/);
assert.equal(readFileSync(file, "utf8"), originalText);
assert.deepEqual(backups(), []);
installHooks(repoHooks);

// --dry-run reports and writes nothing
assert.match(run("--dry-run"), /3 hook\(s\) would be removed/);
assert.equal(readFileSync(file, "utf8"), originalText);
assert.deepEqual(backups(), []);

// real run
assert.match(run(), /3 legacy hook\(s\) removed/);
const [backup] = backups();
assert.match(backup, /^settings\.json\.bak\.\d{8}-claude-deck-v3$/);
assert.equal(readFileSync(path.join(claudeDir, backup), "utf8"), originalText, "backup is the untouched original");
const text = readFileSync(file, "utf8");
assert.ok(text.endsWith("}\n") && text.includes('\n  "model": "opus"'), "2-space JSON with a trailing newline");
assert.deepEqual(JSON.parse(text), {
  model: "opus",
  hooks: {
    PreToolUse: [{ matcher: "", hooks: [other, otherNotify, permission], _note: "kept" }, { matcher: "Bash", hooks: [other] }],
    Stop: [{ matcher: "", hooks: [] }],
    Notification: [{ matcher: "", hooks: [other] }],
  },
  enabledPlugins: { "claude-deck@phmatray": true },
});

// idempotent; and a later run never overwrites the day's backup
assert.match(run(), /no legacy claude-deck hooks/);
const again = JSON.parse(text);
again.hooks.SessionEnd = [{ matcher: "", hooks: [legacy("/x/claude-deck/status/hooks/notification.sh")] }];
writeFileSync(file, JSON.stringify(again));
assert.match(run(), /backup kept/);
assert.deepEqual(backups(), [backup]);
assert.equal(readFileSync(path.join(claudeDir, backup), "utf8"), originalText);
assert.equal(JSON.parse(readFileSync(file, "utf8")).hooks.SessionEnd, undefined);

// every hook legacy → the empty hooks object goes too (plugin installed but disabled: needs --force)
const disabled = { enabledPlugins: { "claude-deck@phmatray": false } };
writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [legacy("/a/claude-deck/hooks/notification.sh")] }] }, ...disabled }));
assert.match(refused(), /does not register Stop/);
run("--force");
assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), disabled);

// no settings.json at all
rmSync(file);
assert.match(run(), /nothing to do/);
assert.ok(!existsSync(file));

rmSync(home, { recursive: true, force: true });
console.log("ok: migrate-settings");
