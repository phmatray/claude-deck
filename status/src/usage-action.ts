import streamDeck, {
  action,
  SingletonAction,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { platform } from "node:os";
import { renderUsageIcon, type UsageKind } from "./icons/usage-icon.js";
import type { UsageSnapshot } from "./usage.js";
import type { UsageRefreshResult } from "./usage-refresh.js";

/** The usage cache only exists at `~/.claude.json` on the machine running the
 *  CLI. On Windows the plugin reads sessions over a UNC path into WSL, which
 *  is a different home — rather than guess, the keys say "macOS only" there. */
export const USAGE_SUPPORTED = platform() === "darwin";

/** How long a press waits for a verdict before answering anyway. The refresh
 *  is deliberately NOT cancelled when this expires: killing the child early
 *  would make a machine where `claude` is merely slow fail permanently, since
 *  the attempt throttle then blocks the tick for the next 5m30s too. It keeps
 *  running and the tile updates on its own — this only bounds how long the
 *  press can sit unacknowledged, which `SPAWN_TIMEOUT_MS` would otherwise let
 *  stretch to 30s, long after the user moved on. */
const VERDICT_TIMEOUT_MS = 12_000;

/**
 * One key per usage window. Three thin subclasses instead of a single action
 * with a property-inspector dropdown: the user drags the window they want
 * straight off the action list, and there is no PI to build or keep in sync.
 */
abstract class UsageAction extends SingletonAction {
  protected abstract readonly kind: UsageKind;
  private readonly instances = new Map<string, KeyAction>();
  /** Per-instance dedup, mirroring render-loop.ts: setImage is comparatively
   *  expensive and the tile only really changes once a minute. */
  private readonly lastSvg = new Map<string, string>();

  constructor(private readonly refreshUsage: () => Promise<UsageRefreshResult>) {
    super();
  }

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey()) return;
    this.instances.set(ev.action.id, ev.action);
    this.lastSvg.delete(ev.action.id);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.instances.delete(ev.action.id);
    this.lastSvg.delete(ev.action.id);
  }

  /** Pressing any usage key drops the cached read and re-renders all three —
   *  the underlying snapshot is shared, so refreshing one in isolation would
   *  leave the others showing an older reading.
   *
   *  The press always acknowledges itself, and within VERDICT_TIMEOUT_MS. Claude
   *  Code refuses to rewrite a snapshot under five minutes old, so most presses
   *  legitimately cannot move the number; the tile then renders byte-identical,
   *  the dedup below swallows the repaint, and with no overlay the key looks
   *  broken. A tick means "what you are looking at is the freshest reading
   *  obtainable", an alert means the refetch did not deliver one in time — which
   *  covers both an outright failure and a refresh still grinding away, since
   *  from the user's side those are the same thing at that moment. */
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (!USAGE_SUPPORTED) {
      await ev.action.showAlert().catch(() => {});
      return;
    }
    // Detached from the race on purpose: whichever side wins, the refresh runs
    // to completion and repaints the tile. The catch is what keeps a rejection
    // from surfacing as an unhandled promise once the timer has already spoken.
    const pending = this.refreshUsage().catch((err: unknown) => {
      streamDeck.logger.warn(`usage refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return "failed" as const;
    });
    let timer: NodeJS.Timeout | undefined;
    const verdict = await Promise.race([
      pending,
      new Promise<UsageRefreshResult>((resolve) => {
        timer = setTimeout(() => resolve("failed"), VERDICT_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await (verdict === "failed" ? ev.action.showAlert() : ev.action.showOk()).catch(() => {});
  }

  /** True when at least one instance of this action sits on the deck. Lets the
   *  tick skip reading the usage cache altogether for users who never place a
   *  usage key. */
  hasInstances(): boolean {
    return this.instances.size > 0;
  }

  async render(snapshot: UsageSnapshot | undefined): Promise<void> {
    if (this.instances.size === 0) return;
    const svg = renderUsageIcon({ kind: this.kind, snapshot, supported: USAGE_SUPPORTED });
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
    const pending: Promise<unknown>[] = [];
    for (const [id, keyAction] of this.instances) {
      if (this.lastSvg.get(id) === dataUrl) continue;
      this.lastSvg.set(id, dataUrl);
      pending.push(
        keyAction.setImage(dataUrl).catch((err: unknown) => {
          this.lastSvg.delete(id);
          streamDeck.logger.warn(`usage setImage failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }
    await Promise.all(pending);
  }
}

@action({ UUID: "com.julien.claudesessions.usage.session" })
export class UsageSessionAction extends UsageAction {
  protected readonly kind: UsageKind = "five_hour";
}

@action({ UUID: "com.julien.claudesessions.usage.week" })
export class UsageWeekAction extends UsageAction {
  protected readonly kind: UsageKind = "seven_day";
}

@action({ UUID: "com.julien.claudesessions.usage.models" })
export class UsageModelsAction extends UsageAction {
  protected readonly kind: UsageKind = "model_scoped";
}
