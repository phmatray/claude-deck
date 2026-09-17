// Self-check: every per-user path in env.ts lives under HOME, and reload-plugin.sh
// (`pnpm sd:reload`, `pnpm watch`) touches the exact file the plugin watches — if the
// two spellings drift, reloads stop silently. Hermetic: runs against a temp HOME.
// Run: pnpm exec tsx scripts/check-env-paths.mts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "claude-deck-home-"));
process.env.HOME = home; // before the import: env.ts reads homedir() at load
const env = await import("../src/env.ts");

for (const p of [env.SESSIONS_DIR, env.RELOAD_FILE, env.SETTINGS_FILE, env.CLAUDE_CONFIG_FILE, env.USAGE_REFRESH_DIR, env.LEGACY_USAGE_REFRESH_DIR]) {
  assert.ok(p.startsWith(home + "/"), `${p} is under HOME`);
}
execFileSync("bash", [fileURLToPath(new URL("./reload-plugin.sh", import.meta.url))], { stdio: "ignore" });
assert.ok(existsSync(env.RELOAD_FILE), "reload-plugin.sh touches env.RELOAD_FILE");

rmSync(home, { recursive: true, force: true });
console.log("ok: env paths");
