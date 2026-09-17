import streamDeck from "@elgato/streamdeck";
import { iconNeedsAnimation, type SessionState } from "./icons/index.js";
import {
  deriveState,
  pruneDeadSessions,
  readAllSessions,
  lastReadError,
  type SessionInfo,
} from "./sessions.js";
import { filterLiveSessions } from "./live-pids.js";
import type { QuestionKind } from "./ask/queue.js";

const FINISHED_TTL_MS = 3_000;

/** States where the session cannot progress until the user does something.
 *  They outrank everything else regardless of recency: the moment a session
 *  starts waiting its event log stops growing, so on pure recency any actively
 *  working session buries it — the exact opposite of what the plugin is for. */
const ATTENTION_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "awaiting_plan",
  "awaiting_permission",
  "awaiting_question",
  "awaiting",
  "error",
  "bg_awaiting_permission",
  "bg_awaiting",
]);

/** A pending deck question needs no clause of its own: deriveState already maps
 *  it to one of the awaiting_* states above. */
const attentionRank = (e: DisplayEntry): number => (ATTENTION_STATES.has(e.state) ? 0 : 1);

export interface DisplayEntry {
  session: SessionInfo;
  state: SessionState;
  /** When state became "finished"; used to expire the entry after FINISHED_TTL_MS. */
  finishedAt?: number;
  /** 1-based position in the sorted list — what the key's corner badge shows.
   *  Stamped when the visible entries are sliced off the front; absent on the
   *  ones that didn't fit on the deck. */
  slotNumber?: number;
}

/**
 * Owns the cross-tick bookkeeping needed to keep "just died" sessions on screen
 * for FINISHED_TTL_MS after their process exits. Pure given inputs (sessions,
 * live PIDs, now) but mutates its private maps to track transitions.
 */
export function createStateTracker(
  /** The session's pending deck question, if any (the answer-key queue). */
  pendingQuestion: (sessionId: string) => { id: string; kind: QuestionKind } | undefined = () => undefined,
) {
  /** Carry-over map keyed by sessionId so a session stays visible briefly after its process dies. */
  const recentlyFinished = new Map<string, DisplayEntry>();
  /** Sessions seen alive in the previous tick — used to detect "just died" transitions. */
  let prevLiveIds = new Set<string>();
  /** Every live/just-finished session, sorted. May be longer than the deck. */
  let sortedEntries: DisplayEntry[] = [];
  /** The head of `sortedEntries` actually on the keys; consumed by render(). */
  let visibleEntries: DisplayEntry[] = [];

  let lastDiag = "";
  function maybeLog(msg: string): void {
    // Avoid spamming the same line every second.
    if (msg !== lastDiag) {
      streamDeck.logger.info(msg);
      lastDiag = msg;
    }
  }

  /**
   * Reads sessions, filters by live PIDs, promotes "just died" into the
   * recently-finished bucket, expires stale carry-overs, and returns the
   * sorted display entries. Also caches the entries internally for
   * `getEntries()` and `needsAnimation()`.
   */
  async function tick(actionCount: number): Promise<DisplayEntry[]> {
    const sessions = await readAllSessions();
    for (const s of sessions) {
      const q = pendingQuestion(s.sessionId);
      s.pendingQuestion = q && { id: q.id, kind: q.kind };
    }
    const live = filterLiveSessions(sessions);
    const liveEntries: DisplayEntry[] = sessions
      .filter((s) => live.has(s.sessionId))
      .map((session) => ({ session, state: deriveState(session, true) }));

    // Promote a session into "finished" only if it was alive last tick and is gone now.
    // Stale session files (whose process hasn't been seen alive since we started)
    // are simply ignored — those are junk left over from previous CC runs.
    const liveIds = new Set(liveEntries.map((e) => e.session.sessionId));
    for (const session of sessions) {
      if (prevLiveIds.has(session.sessionId) && !liveIds.has(session.sessionId) && !recentlyFinished.has(session.sessionId)) {
        // Re-stamp lastActivityAt: SessionEnd's hook unlinks the event log, so
        // by the time we notice the process is gone the session has usually
        // collapsed back to startedAt — hours old, which would sort the green
        // check straight off a short deck. Dying *is* the activity.
        const finishedAt = Date.now();
        recentlyFinished.set(session.sessionId, {
          session: { ...session, lastActivityAt: finishedAt },
          state: "finished",
          finishedAt,
        });
      }
    }
    for (const [sid, entry] of recentlyFinished) {
      if (liveIds.has(sid) || (entry.finishedAt && Date.now() - entry.finishedAt > FINISHED_TTL_MS)) {
        recentlyFinished.delete(sid);
      }
    }
    prevLiveIds = liveIds;

    // Delete dead-process session files so the source dir stays bounded — left
    // unchecked they pile up (months of <pid>.json) and every one gets re-stat'd
    // each tick. Snapshots for the finished-TTL carry-over are
    // already held in recentlyFinished, so removing the file here is safe.
    const pruned = await pruneDeadSessions(sessions, live, Date.now());
    if (pruned > 0) streamDeck.logger.info(`pruned ${pruned} dead session file(s)`);

    // Sessions blocked on the user first, then most-recently-active — with
    // fewer keys than live sessions, that keeps whatever needs you on slot 1
    // and otherwise shows the one you're actually working in. Answering a
    // prompt is seamless: clearing the flag drops the session to the second
    // group, where its now-newest event keeps it exactly where it was.
    // Ties are broken explicitly: sessions restored together (e.g. an editor
    // reopening its threads) share a SessionStart ts to the millisecond, and
    // leaning on sort stability there would hand the order to readSessionFiles's
    // Promise.all push order — which varies per tick and would repaint every
    // key for nothing.
    sortedEntries = [...liveEntries, ...recentlyFinished.values()].sort(
      (a, b) =>
        attentionRank(a) - attentionRank(b)
        || b.session.lastActivityAt - a.session.lastActivityAt
        || b.session.startedAt - a.session.startedAt
        || a.session.pid - b.session.pid,
    );

    // The keys show the head of the list: the sort above already puts whatever
    // needs you first, and on an XL the slots outnumber the sessions.
    visibleEntries = sortedEntries.slice(0, actionCount).map((e, i) => ({ ...e, slotNumber: i + 1 }));

    maybeLog(
      `tick: sessions=${sessions.length} live=${live.size}` +
        ` actions=${actionCount} shown=${visibleEntries.length}/${sortedEntries.length}` +
        (lastReadError ? ` readError=${lastReadError}` : ""),
    );

    return visibleEntries;
  }

  function getEntries(): DisplayEntry[] {
    return visibleEntries;
  }

  /** Any live or just-finished session, on the keys or not. */
  function findSession(sessionId: string): SessionInfo | undefined {
    return sortedEntries.find((e) => e.session.sessionId === sessionId)?.session;
  }

  /**
   * Whether anything on screen needs frame-to-frame redraw (animated motif or a
   * pulsing in-progress todo). Lets the animation loop short-circuit the render
   * call when nothing would actually change — which, with labels truncated
   * rather than scrolled, is most of the time.
   */
  function needsAnimation(): boolean {
    return visibleEntries.some((e) => iconNeedsAnimation(e.state));
  }

  return { tick, getEntries, findSession, needsAnimation };
}
