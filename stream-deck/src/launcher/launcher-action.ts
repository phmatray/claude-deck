import { action, SingletonAction } from "@elgato/streamdeck";

/** Warp launcher key. Declared now so the manifest action list and the
 *  registration order in plugin.ts stay fixed; until the launcher lands it
 *  shows its manifest image and does nothing. */
@action({ UUID: "com.phmatray.claudedeck.launcher" })
export class LauncherAction extends SingletonAction {}
