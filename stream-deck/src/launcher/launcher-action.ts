import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { HOME } from "../env.js";
import type { WarpFocusResult } from "../warp-focus.js";
import { launcherKeyUrl } from "./render.js";
import { expandHome, tabConfigPath, tabConfigStem, tabConfigUri, writeTabConfig } from "./tab-config.js";

/** What the property inspector (ui/launcher.html) stores on the key. */
type LauncherSettings = {
  /** Absolute path (or `~/…`) of the project to open. Empty = key not configured. */
  directory?: string;
  /** Optional override for the key's caption; defaults to the directory's basename. */
  label?: string;
  /** Open a new Warp window instead of a tab in the focused one. */
  newWindow?: boolean;
  /** Command the tab runs; defaults to `claude`. */
  command?: string;
};

/** Stem each key currently has on disk, so retargeting one can take its old Tab
 *  Config out of Warp's `+` menu. Warp lists every file in that folder, and the
 *  property inspector saves while the user is still typing — without this, every
 *  pause mid-path would leave a dead entry there forever.
 *
 *  Its ceiling is that it only knows the keys this process has seen appear: a
 *  restart forgets them (one orphan left in the `+` menu), and a second key on
 *  another page or profile has never appeared, so retargeting the visible one
 *  can delete a config that key shares. Neither breaks a press — its own
 *  willAppear, and the press itself, write the file back. */
const stems = new Map<string, string>();

/**
 * Warp launcher key: press it and a Warp tab opens in a project, already running
 * `claude`.
 *
 * The tab comes from a Warp Tab Config we own — `~/.warp/tab_configs/claude_deck_<slug>.toml`
 * — because `warp://action/new_tab?path=…` opens the directory but runs nothing
 * (map/warp-launch.md §1). The file is (re)written whenever the key appears or its
 * settings change, so Warp has had it on disk long before the press; the press
 * rewrites it too, for the case where the user cleaned out `~/.warp` in between.
 * Retargeting or clearing a key takes the config it used to own back out of
 * Warp's `+` menu, which lists every file in that folder.
 *
 * The directory is never `stat`ed: a path that doesn't exist yet is the user's
 * business, and Warp reports the failed `cd` in the tab it opens.
 */
@action({ UUID: "com.phmatray.claudedeck.launcher" })
export class LauncherAction extends SingletonAction<LauncherSettings> {
  /** Injected so a check can press a key without handing the user's Warp a tab. */
  constructor(private readonly open: (url: string) => Promise<WarpFocusResult>) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent<LauncherSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.apply(ev.action, ev.payload.settings);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LauncherSettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.apply(ev.action, ev.payload.settings);
  }

  override async onKeyDown(ev: KeyDownEvent<LauncherSettings>): Promise<void> {
    const directory = expandHome(ev.payload.settings.directory ?? "", HOME);
    if (!directory) {
      streamDeck.logger.warn("launcher: no directory set on this key");
      await ev.action.showAlert().catch(() => {});
      return;
    }
    try {
      const { stem } = await writeTabConfig(HOME, directory, ev.payload.settings.command);
      const result = await this.open(tabConfigUri(stem, ev.payload.settings.newWindow === true));
      if (!result.matched) {
        streamDeck.logger.warn(`launcher: ${result.reason}`);
        await ev.action.showAlert().catch(() => {});
      }
    } catch (err) {
      streamDeck.logger.error(`launcher: ${err instanceof Error ? err.message : String(err)}`);
      await ev.action.showAlert().catch(() => {});
    }
  }

  /** Paint the key, and keep its Tab Config on disk in step with the settings. */
  private async apply(key: KeyAction<LauncherSettings>, settings: LauncherSettings): Promise<void> {
    const directory = expandHome(settings.directory ?? "", HOME);
    // Claim the new stem before the first await: two settings changes in flight
    // would otherwise both read the same stale entry and both skip the cleanup.
    // Only the bookkeeping is ordered, not the files — two applies interleaved
    // could still leave an orphan. They cannot: the PI debounces 500ms and drops
    // a repeat payload, so its saves never overlap.
    const stem = directory ? tabConfigStem(directory) : undefined;
    const stale = stems.get(key.id);
    if (stem) stems.set(key.id, stem);
    else stems.delete(key.id);

    // No directory means no key, whatever the label field says: a typo is worth
    // seeing on the deck as "Dossier ?" rather than as a project that isn't one.
    const label = directory ? settings.label?.trim() || basename(directory) : "";
    await key.setImage(launcherKeyUrl(label)).catch((err: unknown) => {
      streamDeck.logger.warn(`launcher: setImage failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (stale && stale !== stem) await this.forget(stale);
    if (!directory) return;
    try {
      const { path, written } = await writeTabConfig(HOME, directory, settings.command);
      if (written) streamDeck.logger.info(`launcher: wrote ${path}`);
    } catch (err) {
      streamDeck.logger.warn(`launcher: tab config write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Drop a Tab Config no key points at any more — unless another one still does:
   *  the stem comes from the directory alone, so two keys on the same project
   *  legitimately share a file, and retargeting one must not yank the other's. */
  private async forget(stem: string): Promise<void> {
    if ([...stems.values()].includes(stem)) return;
    const path = tabConfigPath(HOME, stem);
    await rm(path, { force: true }).then(
      () => streamDeck.logger.info(`launcher: removed ${path}`),
      (err: unknown) => streamDeck.logger.warn(`launcher: tab config cleanup failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}
