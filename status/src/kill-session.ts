import streamDeck from "@elgato/streamdeck";

/** Délai avant d'escalader SIGTERM → SIGKILL si le process refuse de partir. */
const SIGKILL_ESCALATION_MS = 2000;

/**
 * Best-effort : termine le process d'une session Claude Code. SIGTERM d'abord,
 * puis SIGKILL après SIGKILL_ESCALATION_MS s'il est toujours vivant. La session
 * vit dans notre propre namespace de process, donc `process.kill` direct suffit.
 */
export function killSession(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return; // déjà mort
    streamDeck.logger.warn(`SIGTERM ${pid} failed: ${code ?? String(err)}`);
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // sonde : throw ESRCH si mort
      process.kill(pid, "SIGKILL");
      streamDeck.logger.info(`escalated to SIGKILL for ${pid}`);
    } catch {
      // déjà mort entre-temps — rien à faire
    }
  }, SIGKILL_ESCALATION_MS);
}
