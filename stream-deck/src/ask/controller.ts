import type { Question } from "./queue.js";

/** The bundled profile (manifest `Profiles[].Name`) the answer keys live on. */
export const PROFILE_NAME = "Claude Deck";

/** Everything the answer keys' state machine touches outside itself. SDK-free on
 *  purpose: the glue in ask.ts binds these to the SDK, a check binds them to fakes. */
export interface ControllerDeps {
  /** Live questions, oldest first (the queue's view). */
  pending(): Question[];
  answer(id: string, index: number): void;
  cancel(id: string): void;
  /** Switches `device` to `profile`, or back to the previous profile when omitted. */
  switchTo(device: string, profile?: string): void;
  /** Brings the terminal of the question's session to the front. */
  focus(question: Question): void;
  /** Deck to show a question on when no key press says which. */
  defaultDevice(): string | undefined;
  repaint(): void;
}

export type AskController = ReturnType<typeof createController>;

/**
 * Which pending question the answer profile shows, and when the deck goes to that
 * profile and back. One rule settles every change ("next or back", `sync`): keep
 * the active question while it is pending, else take the oldest one not dismissed
 * with the Back key, and leave the profile when there is none.
 */
export function createController(deps: ControllerDeps) {
  let activeId: string | null = null;
  /** Put aside with Back: still pending (the session key keeps its badge), but no
   *  longer brought up by itself. */
  const dismissed = new Set<string>();
  let profileShown = false;
  let shownOnDevice: string | null = null;

  const active = (): Question | null => deps.pending().find((q) => q.id === activeId) ?? null;

  function show(device = deps.defaultDevice()): void {
    // No deck connected yet: sync() runs again when one connects.
    if (!device || (profileShown && shownOnDevice === device)) return;
    if (profileShown && shownOnDevice) deps.switchTo(shownOnDevice);
    deps.switchTo(device, PROFILE_NAME);
    profileShown = true;
    shownOnDevice = device;
  }

  function hide(): void {
    if (!profileShown) return;
    if (shownOnDevice) deps.switchTo(shownOnDevice);
    profileShown = false;
    shownOnDevice = null;
  }

  /** Re-applies "next or back" to the current queue. Call on every queue change and
   *  whenever a deck connects. */
  function sync(): void {
    const pending = deps.pending();
    const ids = new Set(pending.map((q) => q.id));
    for (const id of dismissed) if (!ids.has(id)) dismissed.delete(id);
    if (activeId === null || !ids.has(activeId)) activeId = pending.find((q) => !dismissed.has(q.id))?.id ?? null;
    if (activeId === null) hide();
    else if (!profileShown) show();
    deps.repaint();
  }

  /** `device`: the deck whose key asked for it, which gets the profile even when
   *  another deck shows it. Without one, a deck already on the profile keeps it. */
  function activate(id: string, device?: string): void {
    dismissed.delete(id);
    activeId = id;
    if (device) show(device);
    sync();
  }

  /** Terminal key: claude-ask exits 2, its caller falls back to the terminal, which comes to the front. */
  function pressTerminal(): boolean {
    const q = active();
    if (!q) return false;
    deps.cancel(q.id);
    deps.focus(q);
    sync();
    return true;
  }

  return {
    sync,
    active,
    /** Pending questions besides the one on the keys: the queue key's "+N". */
    othersCount: (): number => deps.pending().length - (active() ? 1 : 0),

    /** Option key `slot`. False when it holds no option (nothing written). */
    pressOption(slot: number): boolean {
      const q = active();
      const option = q?.options[slot];
      if (!q || !option) return false;
      // A plan's "Approuver au terminal" is the Terminal key under another name.
      if (option.id === "terminal") return pressTerminal();
      deps.answer(q.id, slot);
      sync();
      return true;
    },

    pressTerminal,

    /** Back key: set the question aside and move on to the next one, or leave the profile. */
    pressBack(): void {
      if (activeId !== null) dismissed.add(activeId);
      activeId = null;
      sync();
    },

    /** Queue key: step to the next pending question, dismissed ones included, wrapping. */
    pressQueue(): boolean {
      const pending = deps.pending();
      const next = pending[(pending.findIndex((q) => q.id === activeId) + 1) % pending.length];
      if (!next || next.id === activeId) return false;
      activate(next.id);
      return true;
    },

    /** Dashboard key of `sessionId` pressed on `device`: bring up its oldest pending
     *  question there, even a dismissed one. False when it has none. */
    showSession(sessionId: string, device: string): boolean {
      const q = deps.pending().find((p) => p.sessionId === sessionId);
      if (!q) return false;
      activate(q.id, device);
      return true;
    },
  };
}
