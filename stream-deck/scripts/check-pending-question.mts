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
import { Resvg } from "@resvg/resvg-js";

const home = mkdtempSync(join(tmpdir(), "claude-deck-pending-"));
process.env.HOME = home; // before the imports: env.ts reads homedir() at load
copyFileSync(fileURLToPath(new URL("../com.phmatray.claudedeck.sdPlugin/manifest.json", import.meta.url)), join(home, "manifest.json"));
process.chdir(home);

const { createStateTracker } = await import("../src/state-tracker.ts");
const { deriveState } = await import("../src/sessions.ts");
const { renderIcon } = await import("../src/icons/index.ts");
const { renderAll } = await import("../src/render-loop.ts");
// The SDK's logger swallows uncaught exceptions (a failed assert would exit 0): fail loudly.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});

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

// the deck badge in any colour: the label colour differs per state
const deckRect = /<rect x="16" y="10" width="14" height="10" rx="2.5" fill="#[0-9a-f]{6}"\/>/i;
// render-loop.ts carries the entry's question onto the key it paints (one key: the first entry)
let painted = "";
const oneKey = { orderedActions: () => [{ id: "k1", setImage: async (url: string) => void (painted = url) }], getState: () => ({}) };
const paintedSvg = async () => {
  await renderAll(oneKey as any, tracker.getEntries(), 0);
  return Buffer.from(painted.slice(painted.indexOf(",") + 1), "base64").toString("utf8");
};
assert.match(await paintedSvg(), deckRect, "the key of a session with a question gets the badge");

pending.clear();
assert.deepEqual(await view(), ["new:idle", "old:working"], "gone with the question");
assert.doesNotMatch(await paintedSvg(), deckRect, "no question, no badge");

// error keeps precedence
const errored = { ...tracker.getEntries()[1].session, errored: true, pendingQuestion: { id: "q", kind: "permission" as const } };
assert.equal(deriveState(errored, true), "error");
// a bg agent keeps its bg look but still reads as waiting on you
const bg = { ...errored, errored: false, kind: "bg" as const, bgStatus: "running" };
assert.equal(deriveState(bg, true), "bg_awaiting_permission");
assert.equal(deriveState({ ...bg, pendingQuestion: { id: "q", kind: "ask" as const } }, true), "bg_awaiting");
assert.equal(deriveState({ ...bg, pendingQuestion: undefined }, true), "bg_working");
// Only the head of the list reaches the keys, numbered from 1 — that number is the
// corner badge, the only feedback that a short press landed on the session you meant.
assert.deepEqual(
  (await tracker.tick(1)).map((e) => [e.session.sessionId, e.slotNumber]),
  [["new", 1]],
  "one key, one entry, slot 1",
);
assert.equal(tracker.findSession("old")?.cwd, join(home, "old"), "found even when scrolled off the keys");

// the deck badge: a 14x10 key at the badge position, the b7 badge pushed after it
const svg = (deck: boolean, badge?: string) => renderIcon({ state: "awaiting_permission", slot: 1, label: "repo", badge, deck });
assert.match(svg(true), /<rect x="16" y="10" width="14" height="10" rx="2.5" fill="#fde68a"\/>/, "in the label colour");
assert.equal((svg(true).match(/<circle [^>]*r="1.3"/g) ?? []).length, 3, "three dots");
assert.doesNotMatch(svg(false), deckRect);
assert.match(svg(true, "b7"), /<text x="34" y="19"[^>]*>b7<\/text>/);
assert.match(svg(false, "b7"), /<text x="16" y="19"[^>]*>b7<\/text>/);
assert.doesNotMatch(renderIcon({ state: "empty", slot: 1, label: "", deck: true }), deckRect, "never on a free slot");

// the label is a directory name and the badge a session name: a character XML forbids in
// either one must not cost the key its art (the same escaper the answer keys go through)
{
  const art = renderIcon({ state: "awaiting_permission", slot: 1, label: "re\x1bpo", badge: "b\x07" });
  assert.doesNotThrow(() => new Resvg(art).render(), "a control character still parses");
  assert.match(art, />re\uFFFDpo</, "and shows as one U+FFFD");
}

rmSync(home, { recursive: true, force: true });
console.log("ok: pending question on the dashboard");
