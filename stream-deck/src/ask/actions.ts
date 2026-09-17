import streamDeck, {
  action,
  SingletonAction,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { answer, currentQuestion, type Answer, type Question } from "./ask.js";
import * as render from "./render.js";

type AskSettings = { slot?: number };

/** A key on the answer profile, painted from the pending question. */
abstract class AskKey extends SingletonAction<AskSettings> {
  private readonly keys = new Map<string, { action: KeyAction<AskSettings>; slot: number }>();

  protected abstract image(question: Question | null, slot: number): string;

  override onWillAppear(ev: WillAppearEvent<AskSettings>): Promise<void> | void {
    if (!ev.action.isKey()) return;
    const c = ev.action.coordinates;
    // The bundled profile sets `slot`; the fallback assumes its single option row.
    const slot = typeof ev.payload.settings.slot === "number" ? ev.payload.settings.slot : (c?.column ?? 0);
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

  /** Answers and acknowledges failure on the key: a lost answer leaves `claude-ask` waiting. */
  protected async send(ev: KeyDownEvent<AskSettings>, a: Answer): Promise<void> {
    try {
      answer(a);
    } catch (err) {
      streamDeck.logger.error("ask: writing the answer failed", err);
      await ev.action.showAlert();
    }
  }

  /** Never rejects: its callers fire and forget, and an unhandled rejection
   *  takes down the whole plugin, session dashboard included. */
  private async paint(key: KeyAction<AskSettings>, slot: number): Promise<void> {
    try {
      await key.setImage(this.image(currentQuestion(), slot));
    } catch (err) {
      streamDeck.logger.warn(`ask: paint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.context" })
export class AskContextAction extends AskKey {
  protected image(q: Question | null): string {
    return q?.context ? render.contextKey(q.context) : render.idleContextKey();
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.header" })
export class AskHeaderAction extends AskKey {
  protected image(q: Question | null): string {
    return q ? render.questionKey(q.header || "Question") : render.idleQuestionKey();
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
    const option = slot === undefined ? undefined : currentQuestion()?.options?.[slot];
    if (slot !== undefined && option) await this.send(ev, { index: slot, label: option.label, cancelled: false });
  }
}

@action({ UUID: "com.phmatray.claudedeck.ask.terminal" })
export class AskTerminalAction extends AskKey {
  protected image(): string {
    return render.cancelKey();
  }

  override async onKeyDown(ev: KeyDownEvent<AskSettings>): Promise<void> {
    if (currentQuestion()) await this.send(ev, { cancelled: true });
  }
}

// Declared now so the manifest action list and the registration order in
// plugin.ts never change again; they show their manifest image until the
// XL answer layout gives them content.

@action({ UUID: "com.phmatray.claudedeck.ask.detail" })
export class AskDetailAction extends SingletonAction {}

@action({ UUID: "com.phmatray.claudedeck.ask.queue" })
export class AskQueueAction extends SingletonAction {}

@action({ UUID: "com.phmatray.claudedeck.ask.back" })
export class AskBackAction extends SingletonAction {}
