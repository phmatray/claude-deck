import streamDeck from "@elgato/streamdeck";

/** Delay before escalating SIGTERM → SIGKILL when the process refuses to exit. */
const SIGKILL_ESCALATION_MS = 2000;

/**
 * Best-effort: terminate a Claude Code session's process. SIGTERM first, then
 * SIGKILL after SIGKILL_ESCALATION_MS if it is still alive. The session runs in
 * our own process namespace, so a direct `process.kill` is enough.
 */
export function killSession(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return; // already dead
    streamDeck.logger.warn(`SIGTERM ${pid} failed: ${code ?? String(err)}`);
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // probe: throws ESRCH if dead
      process.kill(pid, "SIGKILL");
      streamDeck.logger.info(`escalated to SIGKILL for ${pid}`);
    } catch {
      // died in the meantime — nothing to do
    }
  }, SIGKILL_ESCALATION_MS);
}
