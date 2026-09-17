import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Single source of truth for the per-user paths the plugin reads (macOS only).
 *
 * `os.homedir()` rather than `process.env.HOME`: the Stream Deck app is started
 * by launchd, and when `HOME` is missing `homedir()` falls back to the account's
 * passwd entry instead of a guessed `/home/<user>`. It still honours `HOME` when
 * set, which is what lets the check scripts run against a temp home.
 */
export const HOME = homedir();

/** Where Claude Code stores per-pid session JSON and our hook's event logs. */
export const SESSIONS_DIR = join(HOME, ".claude", "sessions");
/** Touch it (`pnpm sd:reload`, `pnpm watch`) and the plugin exits so the Stream
 *  Deck app respawns it. */
export const RELOAD_FILE = join(HOME, ".claude", ".claude-deck.reload");
/** Claude Code user-global settings.json (enabledPlugins, legacy hooks). */
export const SETTINGS_FILE = join(HOME, ".claude", "settings.json");

/** Where `claude-ask` and the answer keys exchange questions/<id>.json and answers/<id>.json.
 *  `CLAUDE_ASK_DIR` overrides it, as it does for the CLI. */
export const ASK_DIR = process.env.CLAUDE_ASK_DIR || join(HOME, ".claude-ask");

/** Claude Code's user-global config blob. Among much else it holds
 *  `cachedUsageUtilization`, the plan-usage snapshot the usage keys read. */
export const CLAUDE_CONFIG_FILE = join(HOME, ".claude.json");

/** Dedicated working directory for the `claude -p "/usage"` refresher. Giving
 *  it a directory of its own is what lets `sessions.ts` recognise and hide the
 *  transient session it creates, instead of flashing a phantom slot every few
 *  minutes. */
export const USAGE_REFRESH_DIR = join(HOME, ".claude", ".claude-deck-usage");
/** The refresher's cwd before the claude-deck rename. Still hidden so a pre-3.0
 *  plugin copy running side by side doesn't flash a phantom slot.
 *  ponytail: drop one release after 3.0. */
export const LEGACY_USAGE_REFRESH_DIR = join(HOME, ".claude", ".streamdeck-usage");

/** True for the refresher's transient session, which `sessions.ts` hides.
 *  Kept here, away from the SDK import, so a check can pin both cwds. */
export function isUsageRefreshCwd(cwd: string): boolean {
  return cwd === USAGE_REFRESH_DIR || cwd === LEGACY_USAGE_REFRESH_DIR;
}

/** Directories prepended to PATH before the plugin spawns the `claude` CLI.
 *
 *  The Stream Deck app is started by launchd, which hands its children the
 *  bare system PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — it has never sourced a
 *  shell rc, so the native installer's `~/.local/bin` is invisible and the
 *  spawn dies with ENOENT. That is not hypothetical: it is what froze the
 *  usage keys on a stale reading for days, warning exactly once (warnOnce) and
 *  then saying nothing at all.
 *
 *  Prepending to PATH rather than resolving one absolute binary keeps a
 *  `claude` that genuinely is on PATH winning, and covers the Homebrew and
 *  npm-global locations in the same breath. */
const CLI_DIRS = [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

/** `process.env` with CLI_DIRS prepended to PATH. Returns `process.env`
 *  untouched when it already covers them, so the common case allocates
 *  nothing and a user with a properly-set PATH sees no change at all. */
export function envWithCliPath(): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? "";
  const present = new Set(path.split(":"));
  const missing = CLI_DIRS.filter((d) => !present.has(d));
  return missing.length === 0 ? process.env : { ...process.env, PATH: [...missing, path].join(":") };
}
