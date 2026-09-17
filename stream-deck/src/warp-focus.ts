import { focusWarpTabOnMac } from "./warp-focus-mac.js";
import { spawnCapture } from "./spawn-capture.js";

/** Outcome of attempting to focus a Warp tab matching a session's cwd. */
export interface WarpFocusResult {
  matched: boolean;
  reason: string;
}

/** Where a session runs, as far as the hooks could tell. */
export interface FocusTarget {
  cwd: string;
  warpSession?: string;
  termProgram?: string;
}

/**
 * Brings a session's terminal to the front. Warp hands every pane a
 * `warp://session/<uuid>` deep link, and the hook records that uuid, so this
 * targets the exact pane — no Accessibility permission, and no guessing from a
 * cwd that `claude --worktree` sessions don't share with their tab. VS Code
 * gets its window (a terminal panel can't be targeted from outside). Anything
 * else — or a log written before the hook recorded the uuid — falls back to the
 * cwd → tab heuristic.
 */
export async function focusSession(target: FocusTarget): Promise<WarpFocusResult> {
  if (target.warpSession) {
    return openUrl(`warp://session/${target.warpSession}`);
  }
  if (target.termProgram === "vscode") {
    const r = await spawnCapture("/usr/bin/open", ["-a", "Visual Studio Code", target.cwd]);
    return r.code === 0 ? { matched: true, reason: "vscode window" } : { matched: false, reason: `vscode-open-failed: ${r.err ?? r.stderr.trim()}` };
  }
  return focusWarpTabOnMac(target.cwd);
}

async function openUrl(url: string): Promise<WarpFocusResult> {
  const r = await spawnCapture("/usr/bin/open", [url]);
  return r.code === 0 ? { matched: true, reason: url } : { matched: false, reason: `open-failed: ${r.err ?? r.stderr.trim()}` };
}
