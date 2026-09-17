// Self-check: every per-user path in env.ts lives under HOME, and reload-plugin.sh
// (`pnpm sd:reload`, `pnpm watch`) touches the exact file the plugin watches — if the
// two spellings drift, reloads stop silently. Hermetic: runs against a temp HOME.
// Run: pnpm exec tsx scripts/check-env-paths.mts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "claude-deck-home-"));
process.env.HOME = home; // before the import: env.ts reads homedir() at load
delete process.env.CLAUDE_ASK_DIR;
const env = await import("../src/env.ts");

for (const p of [env.SESSIONS_DIR, env.RELOAD_FILE, env.SETTINGS_FILE, env.CLAUDE_CONFIG_FILE, env.USAGE_REFRESH_DIR, env.LEGACY_USAGE_REFRESH_DIR, env.ASK_DIR]) {
  assert.ok(p.startsWith(home + "/"), `${p} is under HOME`);
}
// Pin the names, not just their agreement: the renames are what keep a worktree
// `pnpm watch` from restarting the live pre-3.0 plugin (.streamdeck-claude.reload).
assert.equal(env.RELOAD_FILE, join(home, ".claude", ".claude-deck.reload"));
assert.equal(env.USAGE_REFRESH_DIR, join(home, ".claude", ".claude-deck-usage"));
assert.equal(env.LEGACY_USAGE_REFRESH_DIR, join(home, ".claude", ".streamdeck-usage"));
// claude-code/bin/claude-ask writes to the same default; a drift strands every question.
assert.equal(env.ASK_DIR, join(home, ".claude-ask"));
assert.match(readFileSync(fileURLToPath(new URL("../../claude-code/bin/claude-ask", import.meta.url)), "utf8"), /CLAUDE_ASK_DIR \|\| path\.join\(os\.homedir\(\), "\.claude-ask"\)/);
// sessions.ts hides the refresher's session under both cwds, and nothing else.
assert.ok(env.isUsageRefreshCwd(env.USAGE_REFRESH_DIR), "new refresher cwd hidden");
assert.ok(env.isUsageRefreshCwd(env.LEGACY_USAGE_REFRESH_DIR), "legacy refresher cwd hidden");
assert.ok(!env.isUsageRefreshCwd(join(home, "repo")), "normal cwd kept");
assert.ok(!env.isUsageRefreshCwd(home), "HOME cwd kept");
execFileSync("bash", [fileURLToPath(new URL("./reload-plugin.sh", import.meta.url))], { stdio: "ignore" });
assert.ok(existsSync(env.RELOAD_FILE), "reload-plugin.sh touches env.RELOAD_FILE");

rmSync(home, { recursive: true, force: true });
console.log("ok: env paths");
