import streamDeck, {
  action,
  KeyDownEvent,
  KeyUpEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import { focusSession, type FocusTarget } from "./warp-focus.js";

/** Hold ≥ this long → wipe just this agent's event log (palier 1). */
export const LONG_PRESS_MS = 500;
/** Hold ≥ this long → kill the agent process (palier 2). Le wipe à
 *  LONG_PRESS_MS a déjà eu lieu quand on atteint ce seuil. */
export const KILL_PRESS_MS = 3000;

/** Per-instance state we render onto each key. */
export interface SlotState {
  /** SVG already rendered last tick — used to skip redundant setImage calls. */
  lastSvg?: string;
  /** Bound session — used by long-press to wipe just this agent's event log. */
  sessionId?: string;
  /** Bound session pid — required to kill the process on a ≥3s hold. */
  pid?: number;
  /** Bound session label, refreshed every tick by the render loop. */
  label?: string;
  /** Where the bound session runs, same refresh cycle as `label` — what a short press brings to front. */
  focus?: FocusTarget;
  /** `focus` captured at KeyDown, pinned like `pressedLabel` so a reorder between
   *  press and release can't send the focus to another session's terminal. */
  pressedFocus?: FocusTarget;
  /** Bound session's corner disambiguator, same refresh cycle as `label`. */
  badge?: string;
  /** Label captured at KeyDown. Slots are ordered by recency, so the entry
   *  under a key can change between press and release, and the KILL ring has to
   *  keep naming the session it is about to kill. (Its pid is already pinned in
   *  onKeyDown's locals, so only the caption could drift.) */
  pressedLabel?: string;
  /** Badge captured at KeyDown, pinned for the same reason as `pressedLabel`. */
  pressedBadge?: string;
  /** Wall-clock ms du début d'arming (≥LONG_PRESS_MS tenu). undefined = pas en
   *  arming. Lu par le render-loop pour dessiner l'anneau "KILL". */
  killArmingSince?: number;
  /** False pour un agent bg : son PID est un daemon --bg-spare partagé, le tuer
   *  flinguerait le daemon. Posé chaque tick par le render-loop. */
  killable?: boolean;
}

@action({ UUID: "com.phmatray.claudedeck.slot" })
export class SlotAction extends SingletonAction {
  /** All currently-visible action instances, keyed by their Stream Deck instance id. */
  private readonly instances = new Map<string, KeyAction>();
  /** Per-instance render bookkeeping. */
  private readonly state = new Map<string, SlotState>();
  /** Armed long-press timers. Presence = key is currently held but threshold
   *  not yet reached. Cleared on KeyUp (short press) or when the timer fires. */
  private readonly pressTimers = new Map<string, NodeJS.Timeout>();
  /** Armed kill timers (fire at KILL_PRESS_MS). Same lifecycle as pressTimers. */
  private readonly killTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly resetSlot: (sessionId: string) => Promise<void>,
    private readonly killSlot: (pid: number, sessionId: string) => Promise<void>,
  ) {
    super();
  }

  override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
    if (!ev.action.isKey()) {
      streamDeck.logger.warn(`willAppear: not a key, id=${ev.action.id}`);
      return;
    }
    this.instances.set(ev.action.id, ev.action);
    this.state.set(ev.action.id, {});
    const c = ev.action.coordinates;
    streamDeck.logger.info(
      `willAppear: id=${ev.action.id} coords=${c ? `(${c.row},${c.column})` : "none"} total=${this.instances.size}`,
    );
  }

  override onWillDisappear(ev: WillDisappearEvent): void | Promise<void> {
    this.instances.delete(ev.action.id);
    this.state.delete(ev.action.id);
    const t = this.pressTimers.get(ev.action.id);
    if (t) {
      clearTimeout(t);
      this.pressTimers.delete(ev.action.id);
    }
    const k = this.killTimers.get(ev.action.id);
    if (k) {
      clearTimeout(k);
      this.killTimers.delete(ev.action.id);
    }
    streamDeck.logger.info(`willDisappear: id=${ev.action.id} total=${this.instances.size}`);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    const slot = this.state.get(ev.action.id);
    if (!slot?.sessionId || slot.pid === undefined) {
      // Empty slot — keep the "nothing to do here" feedback. No timer armed, so
      // KeyUp is also a no-op.
      void ev.action.showAlert();
      return;
    }
    const id = ev.action.id;
    const sessionId = slot.sessionId;
    const pid = slot.pid;
    // Freeze what the key was showing at press time — the render loop rewrites
    // `label` every tick as the ordering shifts under us.
    slot.pressedLabel = slot.label;
    slot.pressedBadge = slot.badge;
    slot.pressedFocus = slot.focus;
    // Un agent bg n'est pas killable (daemon partagé) : on garde le palier 1
    // (wipe du log) mais ni l'anneau KILL ni le palier 2.
    const killable = slot.killable === true;
    const wipeTimer = setTimeout(() => {
      this.pressTimers.delete(id);
      // Palier 1 atteint : wipe le log. L'anneau "KILL" ne s'arme que si un kill
      // peut effectivement suivre.
      if (killable) slot.killArmingSince = Date.now();
      void this.runLongPress(ev, sessionId);
    }, LONG_PRESS_MS);
    this.pressTimers.set(id, wipeTimer);
    if (killable) {
      const killTimer = setTimeout(() => {
        this.killTimers.delete(id);
        // Garde killArmingSince posé pendant le kill pour que l'anneau s'affiche
        // plein (progress clampé à 1) le temps du SIGTERM, puis le libère — sinon
        // le dernier frame visible plafonne à ~0.95 avant de disparaître.
        void this.runKill(ev, pid, sessionId).finally(() => {
          slot.killArmingSince = undefined;
        });
      }, KILL_PRESS_MS);
      this.killTimers.set(id, killTimer);
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const id = ev.action.id;
    const wipeTimer = this.pressTimers.get(id);
    const killTimer = this.killTimers.get(id);
    if (wipeTimer) {
      // Relâché avant 500ms → short press (focus Warp). Annule tout.
      clearTimeout(wipeTimer);
      this.pressTimers.delete(id);
      if (killTimer) {
        clearTimeout(killTimer);
        this.killTimers.delete(id);
      }
      await this.runShortPress(ev);
      return;
    }
    // Pour un agent bg, killTimer n'a jamais été armé → toujours undefined ici ; cette branche est alors un no-op (killArmingSince n'a jamais été posé non plus).
    if (killTimer) {
      // Relâché entre 500ms et 3s → le wipe a déjà eu lieu. Annule le kill et
      // l'arming visuel ; le render-loop reprend l'état normal au prochain tick.
      clearTimeout(killTimer);
      this.killTimers.delete(id);
      const slot = this.state.get(id);
      if (slot) slot.killArmingSince = undefined;
      return;
    }
    // Relâché après 3s → kill déjà fired, no-op.
  }

  /** Brings the session's terminal to the front. No paging on press: on an XL
   *  the slots outnumber the sessions, and attention-first ordering keeps the
   *  ones that need you in view.
   *  ponytail: add a dedicated page key if sessions routinely exceed the slots. */
  private async runShortPress(ev: KeyUpEvent): Promise<void> {
    const target = this.state.get(ev.action.id)?.pressedFocus;
    if (!target) {
      await ev.action.showAlert();
      return;
    }
    const res = await focusSession(target);
    streamDeck.logger.info(`focus: ${res.reason} for cwd=${target.cwd}`);
    if (!res.matched) await ev.action.showAlert();
  }

  private async runLongPress(ev: KeyDownEvent, sessionId: string): Promise<void> {
    try {
      await this.resetSlot(sessionId);
      // Pendant l'armement du kill (cas normal d'un long-press), l'anneau rouge
      // sert de confirmation : on évite le flash vert showOk qui le masquerait
      // et laisserait croire que l'action est terminée.
      const slot = this.state.get(ev.action.id);
      if (!slot?.killArmingSince) await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`long-press reset failed for ${sessionId}`, err);
      await ev.action.showAlert();
    }
  }

  private async runKill(ev: KeyDownEvent, pid: number, sessionId: string): Promise<void> {
    try {
      await this.killSlot(pid, sessionId);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`kill failed for ${sessionId} pid=${pid}`, err);
      await ev.action.showAlert();
    }
  }

  /** True if any visible slot is mid-hold past LONG_PRESS_MS — consumed by the
   *  animation tick so the progress ring keeps advancing. */
  anyKillArming(): boolean {
    for (const s of this.state.values()) {
      if (s.killArmingSince !== undefined) return true;
    }
    return false;
  }

  /**
   * Returns the action instances ordered by physical position on the deck
   * (top-to-bottom, left-to-right). This ordering is what defines slot 1..N.
   */
  orderedActions(): KeyAction[] {
    return [...this.instances.values()]
      .filter((a) => a.coordinates) // skip multi-action contexts
      .sort((a, b) => {
        const A = a.coordinates!;
        const B = b.coordinates!;
        return A.row !== B.row ? A.row - B.row : A.column - B.column;
      });
  }

  getState(id: string): SlotState | undefined {
    return this.state.get(id);
  }
}


