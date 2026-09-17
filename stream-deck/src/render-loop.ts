import streamDeck from "@elgato/streamdeck";
import { isAnimated, renderIcon, renderKillArming } from "./icons/index.js";
import type { SlotAction } from "./slot-action.js";
import { KILL_PRESS_MS, LONG_PRESS_MS } from "./slot-action.js";
import type { DisplayEntry } from "./state-tracker.js";

/**
 * Walks the ordered action instances and pushes the right SVG onto each key.
 * Per-slot dedup lives in `slotAction.getState(id).lastSvg` — if the SVG is
 * unchanged we skip the setImage call but still refresh the clipboard payload
 * (cwd may have moved underneath us between ticks for the same sessionId).
 */
export async function renderAll(
  slotAction: SlotAction,
  entries: DisplayEntry[],
  frame: number,
): Promise<void> {
  const ordered = slotAction.orderedActions();
  const pending: Promise<void>[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const action = ordered[i];
    const entry = entries[i];
    // Absolute position in the full session list, carried on the entry so the
    // slow tick and the animation tick can't disagree about the badge.
    const slotIndex = entry?.slotNumber ?? i + 1;
    const state = entry?.state ?? "empty";
    const label = entry?.session.label ?? "";
    const branch = entry?.session.branch;
    const badge = entry?.session.badge;
    const todos = entry?.session.todos;
    const deck = entry?.session.pendingQuestion !== undefined;
    // Only animated states advance the frame (see STATES) — a busy key with an
    // in-progress todo stays still rather than streaming frames to the deck.
    const useFrame = isAnimated(state) ? frame : 0;

    const svg = entry
      ? renderIcon({ state, slot: slotIndex, label, branch, badge, deck, frame: useFrame, todos })
      : renderIcon({ state: "empty", slot: slotIndex, label: "", frame: 0 });
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

    const slotState = slotAction.getState(action.id);
    if (!slotState) continue;
    slotState.label = label;
    slotState.badge = badge;
    slotState.focus = entry && { cwd: entry.session.cwd, warpSession: entry.session.warpSession, termProgram: entry.session.termProgram };
    slotState.sessionId = entry?.session.sessionId;
    slotState.pid = entry?.session.pid;
    // entry undefined (slot vide) → killable=true, sans risque : onKeyDown sort tôt sur un slot vide avant de lire ce flag.
    slotState.killable = entry?.session.kind !== "bg";

    // Hold passé LONG_PRESS_MS : on masque l'état normal par l'anneau "KILL"
    // tant que la touche reste enfoncée (killArmingSince posé par SlotAction).
    if (slotState.killArmingSince !== undefined) {
      const elapsed = Date.now() - slotState.killArmingSince;
      const progress = Math.max(0, Math.min(1, elapsed / (KILL_PRESS_MS - LONG_PRESS_MS)));
      // Pinned caption: `label` above is whoever occupies the slot right now,
      // which over a 3 s hold need not still be the session being killed.
      const killSvg = renderKillArming({
        slot: slotIndex,
        label: slotState.pressedLabel ?? label,
        badge: slotState.pressedBadge ?? badge,
        progress,
      });
      const killUrl = "data:image/svg+xml;base64," + Buffer.from(killSvg, "utf8").toString("base64");
      if (slotState.lastSvg !== killUrl) {
        slotState.lastSvg = killUrl;
        pending.push(
          action.setImage(killUrl).catch((err) => {
            streamDeck.logger.error(`setImage(kill) failed for slot ${slotIndex}`, err);
          }),
        );
      }
      continue;
    }

    if (slotState.lastSvg === dataUrl) continue;
    slotState.lastSvg = dataUrl;
    pending.push(
      action.setImage(dataUrl).catch((err) => {
        streamDeck.logger.error(`setImage failed for slot ${slotIndex}`, err);
      }),
    );
  }
  await Promise.all(pending);
}
