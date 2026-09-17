// Self-check: a session with a question waiting on the deck shows it on the dashboard —
// the state follows the question's kind (over working/idle, never over error), the
// session sorts with the ones that need you, and its key carries the deck badge.
// Hermetic: temp HOME with fake session files, temp cwd for the SDK's manifest/logs.
// Run: pnpm exec tsx scripts/check-pending-question.mts
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "claude-deck-pending-"));
process.env.HOME = home; // before the imports: env.ts reads homedir() at load
copyFileSync(fileURLToPath(new URL("../com.phmatray.claudedeck.sdPlugin/manifest.json", import.meta.url)), join(home, "manifest.json"));
process.chdir(home);

const { createStateTracker } = await import("../src/state-tracker.ts");
const { deriveState } = await import("../src/sessions.ts");
const { renderIcon } = await import("../src/icons/index.ts");

// two live sessions (this process and its parent): "old" started first, "new" later
const sessions = join(home, ".claude", "sessions");
mkdirSync(sessions, { recursive: true });
const write = (pid: number, sessionId: string, startedAt: number, status: string) =>
  writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: join(home, sessionId), startedAt, status, kind: "interactive" }));
write(process.pid, "old", 1_000, "busy");
write(process.ppid, "new", 2_000, "idle");

const pending = new Map<string, { id: string; kind: "ask" | "permission" | "plan" }>();
const tracker = createStateTracker((sid) => pending.get(sid));
const view = async () => (await tracker.tick(8)).map((e) => `${e.session.sessionId}:${e.state}`);

assert.deepEqual(await view(), ["new:idle", "old:working"], "most recent first");
for (const [kind, state] of [["permission", "awaiting_permission"], ["plan", "awaiting_plan"], ["ask", "awaiting_question"]] as const) {
  pending.set("old", { id: "q1", kind });
  assert.deepEqual(await view(), [`old:${state}`, "new:idle"], `${kind}: overrides working, sorts first`);
}
assert.equal(tracker.getEntries()[0].session.pendingQuestion?.id, "q1", "joined on the entry");
assert.equal(tracker.findSession("new")?.cwd, join(home, "new"));
pending.clear();
assert.deepEqual(await view(), ["new:idle", "old:working"], "gone with the question");

// error keeps precedence
const errored = { ...tracker.getEntries()[1].session, errored: true, pendingQuestion: { id: "q", kind: "permission" as const } };
assert.equal(deriveState(errored, true), "error");

// the deck badge: a 14x10 key at the badge position, the b7 badge pushed after it
const svg = (deck: boolean, badge?: string) => renderIcon({ state: "awaiting_permission", slot: 1, label: "repo", badge, deck });
const deckRect = /<rect x="16" y="10" width="14" height="10" rx="2.5" fill="#fde68a"\/>/;
assert.match(svg(true), deckRect);
assert.equal((svg(true).match(/<circle [^>]*r="1.3"/g) ?? []).length, 3, "three dots");
assert.doesNotMatch(svg(false), deckRect);
assert.match(svg(true, "b7"), /<text x="34" y="19"[^>]*>b7<\/text>/);
assert.match(svg(false, "b7"), /<text x="16" y="19"[^>]*>b7<\/text>/);
assert.doesNotMatch(renderIcon({ state: "empty", slot: 1, label: "", deck: true }), deckRect, "never on a free slot");

rmSync(home, { recursive: true, force: true });
console.log("ok: pending question on the dashboard");
