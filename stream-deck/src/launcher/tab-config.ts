/** Warp Tab Configs: the file the launcher key writes, and the URI that runs it.
 *
 *  Warp reads `~/.warp/tab_configs/<stem>.toml` and `warp://tab_config/<stem>`
 *  opens a tab in the focused window with the config's directory and commands
 *  (map/warp-launch.md §3). Writing a file we own — rather than driving Warp
 *  with `new_tab?path=…` — is what lets the tab actually run `claude`.
 *
 *  Everything here is pure or `home`-parameterised, so a check can exercise the
 *  writer against a temp HOME and never go near the real `~/.warp`.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** What the tab runs when the key's `command` setting is empty. */
export const DEFAULT_COMMAND = "claude";

/** Absolute, normalised form of a directory typed into the property inspector.
 *  `~` is expanded here because the PI has no folder picker (the SDK ships none),
 *  so the field is typed by hand and `~/repo/x` is how a macOS user writes it —
 *  Warp would silently land in a directory of that literal name otherwise. */
export function expandHome(directory: string, home: string): string {
  const d = directory.trim();
  if (!d) return "";
  if (d === "~") return home;
  return resolve(d.startsWith("~/") ? join(home, d.slice(2)) : d);
}

/** Filename-safe identity of a directory: its basename for a human reading the
 *  `+` menu in Warp, plus 6 hex of the full path so two checkouts of the same
 *  repo name get two configs instead of overwriting each other. */
export function tabConfigSlug(directory: string): string {
  const name = basename(directory).toLowerCase().replace(/[^a-z0-9]/g, "_");
  const hash = createHash("sha1").update(directory).digest("hex").slice(0, 6);
  return `${name}_${hash}`;
}

/** The `<stem>` in both `~/.warp/tab_configs/<stem>.toml` and `warp://tab_config/<stem>`.
 *  The `claude_deck_` prefix is what makes ours recognisable among the user's own. */
export function tabConfigStem(directory: string): string {
  return `claude_deck_${tabConfigSlug(directory)}`;
}

/** The TOML body. `JSON.stringify` doubles as a TOML basic-string escaper — the
 *  two grammars agree on `\"`, `\\` and `\uXXXX`, which covers every path and
 *  command a user can type. */
export function tabConfigToml(directory: string, command = DEFAULT_COMMAND): string {
  return [
    "# Written by Claude Deck (Stream Deck launcher key). Edits are overwritten.",
    `name = ${JSON.stringify(`Claude Deck · ${basename(directory)}`)}`,
    "",
    "[[panes]]",
    'id = "main"',
    'type = "terminal"',
    `directory = ${JSON.stringify(directory)}`,
    `commands = [${JSON.stringify(command || DEFAULT_COMMAND)}]`,
    "is_focused = true",
    "",
  ].join("\n");
}

/** `open`-able URI for a stem. `new_window=true` gives a window instead of a tab. */
export function tabConfigUri(stem: string, newWindow = false): string {
  return `warp://tab_config/${encodeURIComponent(stem)}${newWindow ? "?new_window=true" : ""}`;
}

export interface TabConfigResult {
  /** Absolute path of the `.toml`, always under `<home>/.warp/tab_configs`. */
  path: string;
  stem: string;
  /** False when the file was already byte-identical. */
  written: boolean;
}

/** Writes the Tab Config for `directory`, but only when the content would change:
 *  this runs on every willAppear and every key press, and Warp lists these files
 *  in its `+` menu — no reason to churn their mtimes for an unchanged key. */
export async function writeTabConfig(
  home: string,
  directory: string,
  command?: string,
): Promise<TabConfigResult> {
  const stem = tabConfigStem(directory);
  const path = join(home, ".warp", "tab_configs", `${stem}.toml`);
  const content = tabConfigToml(directory, command);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === content) return { path, stem, written: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return { path, stem, written: true };
}
