import type { SessionInfo } from "./sessions.js";

/** Un agent bg compte comme vivant tant que son json a été rafraîchi récemment.
 *  Généreux exprès : un job bg silencieux mais vivant ne doit pas disparaître.
 *  Tunable. */
const FRESH_MS = 90_000;
/** Statuts bg considérés comme terminaux → le job est fini, on le retire.
 *  Best-effort (cf. spec §6) ; à confirmer en observant d'autres jobs. */
const TERMINAL_BG_STATUS = new Set(["completed", "failed", "cancelled", "done"]);

/** Liveness d'une session bg, sans toucher au PID (daemon --bg-spare partagé) :
 *  fraîcheur de updatedAt ET statut non-terminal. */
function bgAlive(s: SessionInfo, now: number): boolean {
  if (s.updatedAt == null) return false;
  if (now - s.updatedAt >= FRESH_MS) return false;
  return !TERMINAL_BG_STATUS.has((s.bgStatus ?? "").toLowerCase());
}

/** In-process `kill(pid, 0)`: delivers no signal, only runs the existence and
 *  permission checks. No throw → alive; EPERM → alive but owned by another user;
 *  ESRCH (or anything else) → gone. No spawn per tick, nothing to cache. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Returns the sessionIds whose process is currently running. bg sessions skip
 *  the pid check: their pid is a shared daemon, so freshness decides instead. */
export function filterLiveSessions(sessions: SessionInfo[]): Set<string> {
  const now = Date.now();
  const live = new Set<string>();
  for (const s of sessions) {
    if (s.kind === "bg" ? bgAlive(s, now) : isPidAlive(s.pid)) live.add(s.sessionId);
  }
  return live;
}
