import { join } from "node:path";
import { platform, userInfo } from "node:os";

/**
 * Single source of truth for user-, distro- and host-specific paths used by
 * the plugin.
 *
 * The plugin runs inside the Stream Deck app on Windows, where neither `HOME`
 * nor `WSL_DISTRO_NAME` is set. To keep the bundle portable, rollup's
 * `inject-build-env` transform replaces the two `__BUILD_*__` sentinels below
 * with whatever values were live at build time (which always runs from WSL).
 * At runtime, real env vars take precedence; the baked defaults are the
 * fallback.
 *
 * If the sentinels somehow survived the build (e.g. running an unbuilt module
 * directly), `assertResolved` catches it before any path is constructed.
 */

const BUILD_WSL_HOME = "__BUILD_WSL_HOME__";
const BUILD_WSL_DISTRO = "__BUILD_WSL_DISTRO__";

function assertResolved(name: string, value: string): string {
  if (value.startsWith("__BUILD_") && value.endsWith("__")) {
    throw new Error(
      `streamdeck-claude env: ${name} was never replaced — run \`pnpm build\` from WSL with HOME and WSL_DISTRO_NAME set, or set ${name} in the runtime env.`,
    );
  }
  return value;
}

/** WSL/Linux-side home directory. Used directly inside WSL and as the basis
 *  for the UNC path the Windows-side plugin reads. */
export const WSL_HOME = process.env.HOME
  ?? (platform() === "win32" ? assertResolved("HOME", BUILD_WSL_HOME) : `/home/${userInfo().username}`);

/** WSL distro name as known by `wsl.exe -d <distro>`. */
export const WSL_DISTRO = process.env.WSL_DISTRO_NAME ?? assertResolved("WSL_DISTRO_NAME", BUILD_WSL_DISTRO);

/** Windows user profile dir. Always set by Windows; we refuse to fall back. */
export const WIN_HOME = platform() === "win32"
  ? (process.env.USERPROFILE ?? (() => { throw new Error("streamdeck-claude env: USERPROFILE is not set on win32"); })())
  : (process.env.USERPROFILE ?? "");

/** Where Claude Code stores per-pid session JSON, viewed from the WSL side. */
export const WSL_SESSIONS_DIR = join(WSL_HOME, ".claude", "sessions");
export const WSL_RELOAD_FILE = join(WSL_HOME, ".claude", ".streamdeck-claude.reload");
/** Claude Code user-global settings.json (where install-hook.sh writes the hook). */
export const WSL_SETTINGS_FILE = join(WSL_HOME, ".claude", "settings.json");

/** Claude Code's user-global config blob. Among much else it holds
 *  `cachedUsageUtilization`, the plan-usage snapshot the usage keys read. */
export const CLAUDE_CONFIG_FILE = join(WSL_HOME, ".claude.json");

/** Dedicated working directory for the `claude -p "/usage"` refresher. Giving
 *  it a directory of its own is what lets `sessions.ts` recognise and hide the
 *  transient session it creates, instead of flashing a phantom slot every few
 *  minutes. */
export const USAGE_REFRESH_DIR = join(WSL_HOME, ".claude", ".streamdeck-usage");

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
 *  npm-global locations in the same breath. Empty on Windows, where the plugin
 *  never spawns the CLI. */
const CLI_DIRS = platform() === "win32"
  ? []
  : [join(WSL_HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

/** `process.env` with CLI_DIRS prepended to PATH. Returns `process.env`
 *  untouched when it already covers them, so the common case allocates
 *  nothing and a user with a properly-set PATH sees no change at all. */
export function envWithCliPath(): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? "";
  const present = new Set(path.split(":"));
  const missing = CLI_DIRS.filter((d) => !present.has(d));
  return missing.length === 0 ? process.env : { ...process.env, PATH: [...missing, path].join(":") };
}

/** Same paths, but as UNC the Windows-side plugin can read. */
export const WSL_SESSIONS_DIR_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\sessions`;
export const WSL_RELOAD_FILE_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\.streamdeck-claude.reload`;
export const WSL_SETTINGS_FILE_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\settings.json`;

/** Windows-native sessions dir + settings.json (no WSL involved). */
export const WIN_SESSIONS_DIR = `${WIN_HOME}\\.claude\\sessions`;
export const WIN_SETTINGS_FILE = `${WIN_HOME}\\.claude\\settings.json`;

/** Namespace tag a path is expressed in. Mirrors `SessionOrigin` in sessions.ts,
 *  redeclared here as a literal union so env.ts stays free of imports from the
 *  modules that depend on it. */
export type PathOrigin = "wsl" | "windows";

/** Translates a cwd reported by a session into a path *this* process can open.
 *  Every session writes its cwd in its own namespace: a WSL session reports
 *  `/home/u/proj`, a Windows-native one `D:\dev\proj`. From the Windows-side
 *  plugin the former is only reachable over the `\\wsl.localhost\<distro>` UNC.
 *  Returns undefined when the combination isn't reachable from here, so callers
 *  can degrade (skip the lookup) instead of throwing. */
export function localPathForOrigin(p: string, origin: PathOrigin): string | undefined {
  if (!p) return undefined;
  if (platform() === "win32") {
    // Windows-native paths are already local; WSL ones need the same UNC math
    // as WSL_SESSIONS_DIR_FROM_WIN above.
    return origin === "windows" ? p : `\\\\wsl.localhost\\${WSL_DISTRO}${p.replace(/\//g, "\\")}`;
  }
  // Linux/macOS: SESSION_SOURCES only ever collects the native ("wsl") namespace.
  return origin === "wsl" ? p : undefined;
}
