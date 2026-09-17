/** Runtime self-check for the Claude Code hook registration.
 *
 *  The whole pipeline (src/session-events.ts) is fed by hooks that
 *  scripts/install-hook.sh writes into Claude Code's settings.json. If that
 *  registration is stale — e.g. a settings.json last written by an older
 *  install-hook.sh that registered PreToolUse/PostToolUse with tool-specific
 *  matchers instead of catch-all — the plugin keeps running but silently shows
 *  wrong icons (the classic symptom: the permission padlock never clears,
 *  because PostToolUse[Bash/…] never fires). This module turns that silent
 *  degradation into a visible signal (logged at startup + a badge on the Setup
 *  key, see setup-action.ts).
 *
 *  This is the TS mirror of scripts/check-hooks.sh — the event list MUST stay
 *  in sync with that script AND with the `merge` calls in install-hook.sh. */

import { readFile } from "node:fs/promises";
import { SETTINGS_FILE } from "./env.js";

/** Every event the state machine relies on. All are registered catch-all
 *  (empty matcher) by install-hook.sh — keep in sync with check-hooks.sh. */
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

/** The hook-script path a registered command must reference. */
const HOOK_RE = /(streamdeck-claude|claude-deck).*notification\.sh/;

export interface HookCheckResult {
  ok: boolean;
  /** Human-readable problems, e.g. `PostToolUse not registered catch-all`. */
  problems: string[];
}

/** True if `entry` (a settings.json `.hooks[event]` array) registers our hook
 *  script with a catch-all matcher. A tool-specific matcher (the stale-config
 *  failure mode) is treated as NOT registered — that's the whole point. */
function isRegisteredCatchAll(entry: unknown): boolean {
  if (!Array.isArray(entry)) return false;
  return entry.some((reg) => {
    const matcher = (reg as { matcher?: unknown })?.matcher;
    // install-hook.sh writes matcher "" (or it may be absent) for catch-all.
    if (matcher !== undefined && matcher !== "") return false;
    const inner = (reg as { hooks?: unknown })?.hooks;
    if (!Array.isArray(inner)) return false;
    return inner.some((h) => {
      const cmd = (h as { command?: unknown })?.command;
      return typeof cmd === "string" && HOOK_RE.test(cmd);
    });
  });
}

/** Reads settings.json and verifies every REQUIRED_HOOK_EVENTS is registered
 *  catch-all for our hook script. Never throws — an unreadable file is reported
 *  as a problem so the caller can surface it. */
export async function checkHooks(): Promise<HookCheckResult> {
  let hooks: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as { hooks?: Record<string, unknown> };
    hooks = parsed?.hooks ?? {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, problems: [`settings.json ${code === "ENOENT" ? "missing" : "unreadable"} (${SETTINGS_FILE})`] };
  }
  const problems = REQUIRED_HOOK_EVENTS
    .filter((event) => !isRegisteredCatchAll(hooks[event]))
    .map((event) => `${event} not registered catch-all`);
  return { ok: problems.length === 0, problems };
}

/** One-line hint pointing at the fix, for logs and tooltips. */
export const HOOK_FIX_HINT =
  "stale/missing hook registration — run `pnpm install:hook`, then reload Stream Deck";
