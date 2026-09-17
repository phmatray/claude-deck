/** Runtime self-check for the Claude Code hook registration.
 *
 *  The whole pipeline (src/session-events.ts) is fed by hooks the Claude Code
 *  plugin `claude-deck` registers in its own hooks/hooks.json. Claude Code runs
 *  them from a versioned copy under ~/.claude/plugins/cache/, so what matters
 *  is that copy, not the repo: if the plugin is disabled, missing, or an older
 *  install lacks an event, the Stream Deck plugin keeps running but silently
 *  shows wrong icons (the classic symptom: a permission padlock that never
 *  clears). This module turns that silent degradation into a visible signal
 *  (logged at startup + a badge on the Setup key, see setup-action.ts).
 *
 *  scripts/probe-hooks.sh applies the same rules from a shell — keep the two
 *  in sync with each other and with claude-code/hooks/hooks.json. */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./env.js";

/** Every event the state machine relies on, each registered catch-all. */
export const REQUIRED_HOOK_EVENTS = [
  "SessionStart",
  "Notification",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
] as const;

/** hooks.json stores `${CLAUDE_PLUGIN_ROOT}/…` literally, so match the tail. */
const NOTIFY_RE = /\/hooks\/notification\.sh$/;
const PERMISSION_RE = /\/bin\/claude-permission$/;
/** Hooks written into settings.json by the pre-3.0 install-hook.sh. */
const LEGACY_RE = /(streamdeck-claude|claude-deck).*notification\.(sh|ps1)/;

export interface HookCheckResult {
  ok: boolean;
  /** Short problems that break the dashboard, e.g. `PostToolUse not registered catch-all`. */
  problems: string[];
  /** Worth fixing but harmless to the icons, e.g. legacy hooks double-logging. */
  warnings: string[];
}

type HookGroups = Record<string, unknown>;

/** True if `entry` (a `.hooks[event]` array) registers a command matching `re`
 *  with a catch-all matcher. A tool-specific matcher is treated as NOT
 *  registered — that's the stale-config failure mode this check exists for. */
function isRegisteredCatchAll(entry: unknown, re: RegExp): boolean {
  return Array.isArray(entry) && entry.some((group) => {
    const { matcher, hooks } = (group ?? {}) as { matcher?: unknown; hooks?: unknown };
    if (matcher !== undefined && matcher !== "") return false;
    return Array.isArray(hooks) && hooks.some((h) => re.test(String((h as { command?: unknown })?.command ?? "")));
  });
}

function hasLegacyHooks(hooks: HookGroups | undefined): boolean {
  return Object.values(hooks ?? {}).some((groups) =>
    Array.isArray(groups) && groups.some((g) =>
      Array.isArray(g?.hooks) && g.hooks.some((h: { command?: unknown }) => LEGACY_RE.test(String(h?.command ?? "")))));
}

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Verifies the claude-deck Claude Code plugin is enabled, installed, and that
 *  its installed hooks.json registers every event. Never throws. `home` is a
 *  parameter so a check script can point it at a fake HOME. */
export async function checkHooks(home: string = HOME): Promise<HookCheckResult> {
  const claudeDir = join(home, ".claude");
  const settings = await readJson(join(claudeDir, "settings.json"));
  const warnings = hasLegacyHooks(settings?.hooks)
    ? ["legacy hooks in settings.json: every event is logged twice; run scripts/migrate-settings.mjs"]
    : [];
  const fail = (problem: string): HookCheckResult => ({ ok: false, problems: [problem], warnings });

  const enabled = settings?.enabledPlugins ?? {};
  const key = Object.keys(enabled).find((k) => /^claude-deck@/.test(k) && enabled[k] === true);
  if (!key) return fail("plugin claude-deck not enabled");

  const installed = await readJson(join(claudeDir, "plugins", "installed_plugins.json"));
  const entries: { scope?: string; installPath?: unknown }[] = Array.isArray(installed?.plugins?.[key]) ? installed.plugins[key] : [];
  const installPath = (entries.find((e) => e?.scope === "user") ?? entries[0])?.installPath;
  if (typeof installPath !== "string") return fail(`plugin ${key} not installed`);

  const hooksJson = await readJson(join(installPath, "hooks", "hooks.json"));
  if (!hooksJson) return fail("installed plugin has no readable hooks/hooks.json");
  const hooks: HookGroups = hooksJson.hooks ?? {};

  const problems = REQUIRED_HOOK_EVENTS
    .filter((event) => !isRegisteredCatchAll(hooks[event], NOTIFY_RE))
    .map((event) => `${event} not registered catch-all`);
  if (!isRegisteredCatchAll(hooks.PermissionRequest, PERMISSION_RE)) problems.push("PermissionRequest not registered");
  try {
    await access(join(installPath, "hooks", "notification.sh"));
  } catch {
    problems.push("installed plugin has no hooks/notification.sh");
  }
  return { ok: problems.length === 0, problems, warnings };
}

/** One-line hint pointing at the fix, for logs and tooltips. */
export const HOOK_FIX_HINT = "install the Claude Code plugin: claude plugin install claude-deck@phmatray";
