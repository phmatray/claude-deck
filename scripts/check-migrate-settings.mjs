// Self-check for scripts/migrate-settings.mjs against a temp HOME: legacy hooks go,
// everything else stays, the backup is taken once and never overwritten.
// Run: node scripts/check-migrate-settings.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = new URL("./migrate-settings.mjs", import.meta.url).pathname;
const home = mkdtempSync(path.join(tmpdir(), "claude-deck-migrate-settings-"));
const claudeDir = path.join(home, ".claude");
const file = path.join(claudeDir, "settings.json");
mkdirSync(claudeDir, { recursive: true });

const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
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

// every hook legacy → the empty hooks object goes too
writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [legacy("/a/claude-deck/hooks/notification.sh")] }] } }));
run();
assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});

// no settings.json at all
rmSync(file);
assert.match(run(), /nothing to do/);
assert.ok(!existsSync(file));

rmSync(home, { recursive: true, force: true });
console.log("ok: migrate-settings");
