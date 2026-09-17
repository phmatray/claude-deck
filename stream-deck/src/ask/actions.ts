import streamDeck, {
  action,
  SingletonAction,
  type Coordinates,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { ask } from "./ask.js";
import { detailLines, KEYS_PER_ROW, segmentLines } from "./detail.js";
import type { Question } from "./queue.js";
import * as render from "./render.js";

/** Set by the bundled profile: `slot` on option keys, `segment` on detail keys. */
type AskSettings = { slot?: number; segment?: number };

/** A key on the answer profile, painted from the pending question. */
abstract class AskKey extends SingletonAction<AskSettings> {
  private readonly keys = new Map<string, { action: KeyAction<AskSettings>; slot: number }>();

  protected abstract image(question: Question | null, slot: number): string;

  /** The key's option slot. The bundled profile sets it; the fallback assumes its single option row. */
  protected slotFrom(settings: AskSettings, at?: Coordinates): number {
    return typeof settings.slot === "number" ? settings.slot : (at?.column ?? 0);
  }

  override onWillAppear(ev: WillAppearEvent<AskSettings>): Promise<void> | void {
    if (!ev.action.isKey()) return;
    const slot = this.slotFrom(ev.payload.settings, ev.action.coordinates);
    const key = { action: ev.action, slot };
    this.keys.set(ev.action.id, key);
    return this.paint(key.action, slot);
  }

  override onWillDisappear(ev: WillDisappearEvent<AskSettings>): void {
    this.keys.delete(ev.action.id);
  }

  async repaint(): Promise<void> {
    await Promise.all([...this.keys.values()].map((k) => this.paint(k.action, k.slot)));
  }

  protected slotOf(id: string): number | undefined {
    return this.keys.get(id)?.slot;
  }

  /** Runs a press and acknowledges failure on the key: a lost answer leaves `claude-ask` waiting. */
  protected async press(ev: KeyDownEvent<AskSettings>, run: () => void): Promise<void> {
    try {
      run();
    } catch (err) {
      streamDeck.logger.error("ask: key press failed", err);
      await ev.action.showAlert();
    }
  }

  /** Never rejects: its callers fire and forget, and an unhandled rejection
   *  takes down the whole plugin, session dashboard included. */
  private async paint(key: KeyAction<AskSettings>, slot: number): Promise<void> {
    try {
      await key.setImage(this.image(ask.active(), slot));
    } catch (err) {
      streamDeck.logger.warn(`ask: paint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.context" })
export class AskContextAction extends AskKey {
  /** `sessionLabel`: the dashboard's name for a session, when it knows the session. */
  constructor(private readonly sessionLabel: (sessionId: string) => string | undefined) {
    super();
  }

  protected image(q: Question | null): string {
    if (!q?.context) return render.idleContextKey();
    const label = q.sessionId ? this.sessionLabel(q.sessionId) : undefined;
    return render.contextKey(q.context, label === q.context ? undefined : label);
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.header" })
export class AskHeaderAction extends AskKey {
  protected image(q: Question | null): string {
    return q ? render.questionKey(q.header || "Question", q.kind) : render.idleQuestionKey();
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.detail" })
export class AskDetailAction extends AskKey {
  /** Detail keys are numbered by `segment` (0-7 row 1, 8-15 row 2) in `slot`'s place. */
  protected override slotFrom(settings: AskSettings, at?: Coordinates): number {
    return typeof settings.segment === "number" ? settings.segment : at ? (at.row - 1) * KEYS_PER_ROW + at.column : 0;
  }

  protected image(q: Question | null, segment: number): string {
    return render.detailKey(q ? segmentLines(detailLines(q.detail ?? q.question ?? ""), segment) : []);
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.option" })
export class AskOptionAction extends AskKey {
  protected image(q: Question | null, slot: number): string {
    const option = q?.options?.[slot];
    return option ? render.optionKey(slot + 1, option.label) : render.emptyKey();
  }

  override async onKeyDown(ev: KeyDownEvent<AskSettings>): Promise<void> {
    const slot = this.slotOf(ev.action.id);
    if (slot !== undefined) await this.press(ev, () => ask.pressOption(slot));
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.terminal" })
export class AskTerminalAction extends AskKey {
  protected image(): string {
    return render.cancelKey();
  }

  override async onKeyDown(ev: KeyDownEvent<AskSettings>): Promise<void> {
    await this.press(ev, () => ask.pressTerminal());
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.queue" })
export class AskQueueAction extends AskKey {
  protected image(): string {
    const others = ask.othersCount();
    return others > 0 ? render.queueKey(others) : render.emptyKey();
  }

  override async onKeyDown(ev: KeyDownEvent<AskSettings>): Promise<void> {
    await this.press(ev, () => ask.pressQueue());
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.back" })
export class AskBackAction extends AskKey {
  protected image(): string {
    return render.backKey();
  }

  override async onKeyDown(ev: KeyDownEvent<AskSettings>): Promise<void> {
    await this.press(ev, () => ask.pressBack(ev.action.device.id));
  }
}
