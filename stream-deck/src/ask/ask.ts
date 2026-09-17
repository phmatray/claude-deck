import streamDeck, { DeviceType } from "@elgato/streamdeck";
import { ASK_DIR } from "../env.js";
import { createController } from "./controller.js";
import { createQueue, type Question } from "./queue.js";

/**
 * SDK glue for the answer keys: binds the question queue (queue.ts) and the
 * display state machine (controller.ts) to the Stream Deck's devices and profiles.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const queue = createQueue(ASK_DIR, (msg) => streamDeck.logger.info(msg));

let repaint: () => void = () => {};
let focus: (question: Question) => void = () => {};

/** The bundled profile targets the XL, so prefer one; otherwise the first deck
 *  with a grid of keys (more than one row: not a pedal or a strip of G keys). */
function defaultDevice(): string | undefined {
  const connected = [...streamDeck.devices].filter((d) => d.isConnected);
  return (connected.find((d) => d.type === DeviceType.StreamDeckXL) ?? connected.find((d) => d.size.rows > 1))?.id;
}

export const ask = createController({
  pending: () => queue.pending(),
  answer: (id, index) => queue.answer(id, index),
  cancel: (id) => queue.cancel(id),
  switchTo(device, profile) {
    // Page 0 on the way in; no profile name returns the deck to whatever it showed before.
    const request = profile ? streamDeck.profiles.switchToProfile(device, profile, 0) : streamDeck.profiles.switchToProfile(device);
    request.catch((err: unknown) => streamDeck.logger.warn(`ask: switch to ${profile ?? "previous profile"} failed: ${errorText(err)}`));
  },
  focus: (question) => focus(question),
  defaultDevice,
  repaint: () => repaint(),
});

/** The oldest pending question of a dashboard session, for its key's badge and state. */
export const pendingQuestion = (sessionId: string): Question | undefined => queue.bySession(sessionId);

/** Starts watching for questions. `onRepaint` repaints every answer key; `onFocus`
 *  brings a question's session terminal to the front. */
export function startAsk(onRepaint: () => void, onFocus: (question: Question) => void): void {
  repaint = onRepaint;
  focus = onFocus;
  let shown: string | undefined;
  queue.onChange(() => {
    ask.sync();
    const q = ask.active();
    if (q && q.id !== shown) streamDeck.logger.info(`ask: ${q.kind} ${q.header || q.question || ""} (${queue.pending().length} pending)`);
    shown = q?.id;
  });
  // Devices from the registration info start out disconnected: connect() resolves
  // before the app's deviceDidConnect messages, so a question already waiting at
  // startup finds no deck. Retry when one connects (also covers a hot-plugged XL).
  streamDeck.devices.onDeviceDidConnect(() => ask.sync());
  queue.start();
}
