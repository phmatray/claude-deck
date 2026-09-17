// Self-check: session liveness is an in-process kill(pid, 0). A running child is
// alive, a reaped one is dead, and a process owned by another user (EPERM) still
// counts as alive — pid 1 is launchd/init, never ours. bg sessions never trust the
// pid (a shared, always-alive daemon): fresh updatedAt and a non-terminal status.
// Run: pnpm exec tsx scripts/check-live-pids.mts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { filterLiveSessions, isPidAlive } from "../src/live-pids.ts";
import type { SessionInfo } from "../src/sessions.ts";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
const pid = child.pid!;
const session = (sessionId: string, p: number) => ({ sessionId, pid: p, kind: "interactive" }) as SessionInfo;

assert.equal(isPidAlive(pid), true, "running child is alive");
assert.equal(isPidAlive(1), true, "EPERM (another user's process) counts as alive");
assert.deepEqual(filterLiveSessions([session("a", pid), session("b", 1)]), new Set(["a", "b"]));

// bg: pid 1 is always alive, so only freshness + status may decide.
const now = Date.now();
const bg = (sessionId: string, bgStatus: string, updatedAt: number) =>
  ({ sessionId, pid: 1, kind: "bg", bgStatus, updatedAt }) as SessionInfo;
assert.deepEqual(
  filterLiveSessions([bg("running", "running", now), bg("done", "Completed", now), bg("stale", "running", now - 600_000)]),
  new Set(["running"]),
  "bg: fresh + non-terminal is live; terminal status or stale updatedAt is dead",
);

child.kill("SIGKILL");
await once(child, "exit");
assert.equal(isPidAlive(pid), false, "reaped child is dead");
assert.deepEqual(filterLiveSessions([session("a", pid)]), new Set());

console.log("ok: live pids");
