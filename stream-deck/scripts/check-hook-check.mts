// Self-check: hook-check.ts judges the Claude Code plugin install, not settings.json
// hooks. Each case is a fake HOME whose installed plugin copy starts from the repo's
// real claude-code/hooks/hooks.json, so the shipped file must pass too.
// Run: pnpm exec tsx scripts/check-hook-check.mts
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHooks, REQUIRED_HOOK_EVENTS } from "../src/hook-check.ts";

const repoPlugin = fileURLToPath(new URL("../../claude-code/", import.meta.url));
const legacyHook = { matcher: "", hooks: [{ type: "command", command: "/Users/me/claude-deck/status/hooks/notification.sh" }] };
const temps: string[] = [];

/** A HOME with claude-deck@phmatray enabled and installed; `edit` bends one piece. */
function fakeHome(edit: {
  settings?: (s: any) => void;
  installed?: (i: any) => void;
  hooks?: (h: any) => void;
} = {}): string {
  const home = mkdtempSync(join(tmpdir(), "claude-deck-hookcheck-"));
  temps.push(home);
  const installPath = join(home, ".claude", "plugins", "cache", "phmatray", "claude-deck", "3.0.0");
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  copyFileSync(join(repoPlugin, "hooks", "notification.sh"), join(installPath, "hooks", "notification.sh"));
  chmodSync(join(installPath, "hooks", "notification.sh"), 0o755);

  const hooks = JSON.parse(readFileSync(join(repoPlugin, "hooks", "hooks.json"), "utf8"));
  edit.hooks?.(hooks);
  writeFileSync(join(installPath, "hooks", "hooks.json"), JSON.stringify(hooks));

  const settings = { enabledPlugins: { "other@market": false, "claude-deck@phmatray": true } };
  edit.settings?.(settings);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));

  const installed = {
    version: 2,
    plugins: {
      "claude-deck@phmatray": [
        { scope: "project", installPath: join(home, "nowhere"), version: "2.0.0" },
        { scope: "user", installPath, version: "3.0.0" },
      ],
    },
  };
  edit.installed?.(installed);
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(installed));
  return home;
}

// ok: the shipped hooks.json registers every event; the user-scope entry wins.
assert.deepEqual(await checkHooks(fakeHome()), { ok: true, problems: [], warnings: [] });

// plugin disabled, or never enabled
let r = await checkHooks(fakeHome({ settings: (s) => (s.enabledPlugins["claude-deck@phmatray"] = false) }));
assert.deepEqual([r.ok, r.problems], [false, ["plugin claude-deck not enabled"]]);
temps.push(mkdtempSync(join(tmpdir(), "claude-deck-hookcheck-empty-")));
r = await checkHooks(temps.at(-1)!);
assert.deepEqual([r.ok, r.problems, r.warnings], [false, ["plugin claude-deck not enabled"], []]);

// enabled but not installed
r = await checkHooks(fakeHome({ installed: (i) => delete i.plugins["claude-deck@phmatray"] }));
assert.deepEqual([r.ok, r.problems], [false, ["plugin claude-deck@phmatray not installed"]]);

// an event missing, another narrowed to one tool, PermissionRequest gone
r = await checkHooks(fakeHome({
  hooks: (h) => {
    delete h.hooks.StopFailure;
    h.hooks.PostToolUse[0].matcher = "Bash";
    delete h.hooks.PermissionRequest;
  },
}));
assert.equal(r.ok, false);
assert.deepEqual(r.problems, [
  "PostToolUse not registered catch-all",
  "StopFailure not registered catch-all",
  "PermissionRequest not registered",
]);

// installed copy lost its script
{
  const home = fakeHome();
  rmSync(join(home, ".claude", "plugins", "cache", "phmatray", "claude-deck", "3.0.0", "hooks", "notification.sh"));
  r = await checkHooks(home);
  assert.deepEqual([r.ok, r.problems], [false, ["installed plugin has no hooks/notification.sh"]]);
}

// legacy settings.json hooks: a warning, not a failure — and reported even when the plugin is off
const legacy = "legacy hooks in settings.json: every event is logged twice; run scripts/migrate-settings.mjs";
r = await checkHooks(fakeHome({ settings: (s) => (s.hooks = { Stop: [legacyHook] }) }));
assert.deepEqual(r, { ok: true, problems: [], warnings: [legacy] });
r = await checkHooks(fakeHome({
  settings: (s) => {
    s.hooks = { PreToolUse: [legacyHook] };
    delete s.enabledPlugins["claude-deck@phmatray"];
  },
}));
assert.deepEqual(r, { ok: false, problems: ["plugin claude-deck not enabled"], warnings: [legacy] });

assert.equal(REQUIRED_HOOK_EVENTS.length, 10);
for (const t of temps) rmSync(t, { recursive: true, force: true });
console.log("ok: hook check");
