import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import { basename } from "node:path";
import { HOME } from "../env.js";
import { openUrl } from "../warp-focus.js";
import { launcherKeyUrl } from "./render.js";
import { expandHome, tabConfigUri, writeTabConfig } from "./tab-config.js";

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

/**
 * Warp launcher key: press it and a Warp tab opens in a project, already running
 * `claude`.
 *
 * The tab comes from a Warp Tab Config we own — `~/.warp/tab_configs/claude_deck_<slug>.toml`
 * — because `warp://action/new_tab?path=…` opens the directory but runs nothing
 * (map/warp-launch.md §1). The file is (re)written whenever the key appears or its
 * settings change, so Warp has had it on disk long before the press; the press
 * rewrites it too, for the case where the user cleaned out `~/.warp` in between.
 *
 * The directory is never `stat`ed: a path that doesn't exist yet is the user's
 * business, and Warp reports the failed `cd` in the tab it opens.
 */
@action({ UUID: "com.phmatray.claudedeck.launcher" })
export class LauncherAction extends SingletonAction<LauncherSettings> {
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
      const result = await openUrl(tabConfigUri(stem, ev.payload.settings.newWindow === true));
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
    const label = settings.label?.trim() || (directory ? basename(directory) : "");
    await key.setImage(launcherKeyUrl(label)).catch((err: unknown) => {
      streamDeck.logger.warn(`launcher: setImage failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!directory) return;
    try {
      const { path, written } = await writeTabConfig(HOME, directory, settings.command);
      if (written) streamDeck.logger.info(`launcher: wrote ${path}`);
    } catch (err) {
      streamDeck.logger.warn(`launcher: tab config write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
