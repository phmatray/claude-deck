// Self-check: the plugin half of the questions/<id>.json + answers/<id>.json protocol —
// queue.ts reads only live, well-formed questions in arrival order; ask.ts puts the deck
// on "Claude Deck" while one waits (even one already there before any deck connected)
// and sends it back afterwards; the answer keys write exactly what claude-ask reads.
// Hermetic: temp CLAUDE_ASK_DIR, temp cwd for the SDK's manifest/logs, fake devices
// and profile switcher.
// Run: pnpm exec tsx scripts/check-ask-keys.mts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "claude-deck-ask-keys-"));
const askDir = join(tmp, "ask");
process.env.CLAUDE_ASK_DIR = askDir; // before the import: env.ts reads it at load
// The SDK reads manifest.json from cwd at import and logs into cwd/logs.
copyFileSync(fileURLToPath(new URL("../com.phmatray.claudedeck.sdPlugin/manifest.json", import.meta.url)), join(tmp, "manifest.json"));
process.chdir(tmp);

const streamDeck = (await import("@elgato/streamdeck")).default;
const { ask, pendingQuestion, startAsk } = await import("../src/ask/ask.ts");
const { AskBackAction, AskOptionAction, AskQueueAction, AskTerminalAction } = await import("../src/ask/actions.ts");
const { createQueue, parseQuestion } = await import("../src/ask/queue.ts");
// The SDK only logs uncaught exceptions, and the watcher keeps the loop alive: fail loudly.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});

// --- fakes: the SDK getters are configurable, ask.ts reads them at call time ----
type FakeDevice = { id: string; type: number; size: { columns: number; rows: number }; isConnected: boolean };
const devices: FakeDevice[] = [
  { id: "xl-off", type: 2, size: { columns: 8, rows: 4 }, isConnected: false },
  { id: "pedal", type: 5, size: { columns: 3, rows: 1 }, isConnected: false },
  { id: "mk2", type: 0, size: { columns: 5, rows: 3 }, isConnected: false },
  { id: "xl", type: 2, size: { columns: 8, rows: 4 }, isConnected: false },
];
let onConnect: (() => void) | undefined;
const switches: unknown[][] = [];
Object.defineProperty(streamDeck, "devices", {
  get: () => ({ [Symbol.iterator]: () => devices[Symbol.iterator](), onDeviceDidConnect: (l: () => void) => (onConnect = l) }),
});
Object.defineProperty(streamDeck, "profiles", {
  get: () => ({ switchToProfile: async (...args: unknown[]) => void switches.push(args) }),
});

const QUESTIONS = join(askDir, "questions");
const ANSWERS = join(askDir, "answers");
async function until(what: string, cond: () => boolean): Promise<void> {
  for (const end = Date.now() + 3000; !cond(); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
  }
}
const deadPid = spawnSync("true").pid!;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const question = (id: string, extra: object = {}) => ({
  id, kind: "permission", sessionId: `s-${id}`, pid: process.pid, cwd: "/work/repo", context: "repo", header: "Bash",
  options: [{ id: "allow", label: "Autoriser" }, { id: "deny", label: "Refuser" }],
  createdAt: at(0), expiresAt: at(60_000), ...extra,
});
const put = (q: { id: string }) => writeFileSync(join(QUESTIONS, `${q.id}.json`), JSON.stringify(q));
const answerOf = (id: string) => {
  const a = JSON.parse(readFileSync(join(ANSWERS, `${id}.json`), "utf8"));
  assert.equal(typeof a.answeredAt, "string");
  return { ...a, answeredAt: undefined };
};
const key = (id: string, slot: number) => {
  const action = { id, isKey: () => true, coordinates: { column: slot, row: 3 }, setImage: async (img: string) => void images.set(id, img), showAlert: async () => {} };
  return { action, payload: { settings: { slot } } } as any;
};
const images = new Map<string, string>();
const svg = (id: string) => Buffer.from(images.get(id)!.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

// --- queue.ts on its own: validation, liveness, expiry, order ------------------------
assert.equal(parseQuestion(question("x"), "x")?.id, "x", "the shape claude-ask writes parses");
for (const bad of [
  null, "text", question("other"), question("x", { kind: "shell" }), question("x", { pid: "1" }), question("x", { options: [] }),
  question("x", { options: [{ label: "no id" }] }), question("x", { header: 5 }), question("x", { sessionId: 3 }),
  question("x", { createdAt: "soon" }), question("x", { expiresAt: "never" }),
]) {
  assert.equal(parseQuestion(bad, "x"), null, `rejected: ${JSON.stringify(bad)}`);
}
{
  const dir = join(tmp, "queue-only");
  const logs: string[] = [];
  const q = createQueue(dir, (m) => logs.push(m));
  q.start();
  const w = (x: { id: string }, name = `${x.id}.json`) => writeFileSync(join(dir, "questions", name), JSON.stringify(x));
  w(question("late", { createdAt: at(5_000) }));
  w(question("early", { createdAt: at(-5_000) }));
  w(question("dead", { pid: deadPid }));
  w(question("expired", { expiresAt: at(-6_000) }));
  w(question("mid-write"), ".mid-write.tmp");
  writeFileSync(join(dir, "questions", "broken.json"), "{not json");
  w(question("mislabelled"), "other-name.json");
  q.refresh();
  q.refresh();
  assert.deepEqual(q.pending().map((x) => x.id), ["early", "late"], "live and well-formed only, oldest first");
  assert.equal(q.bySession("s-late")?.id, "late");
  assert.equal(q.bySession("s-dead"), undefined);
  assert.equal(logs.filter((l) => l.includes("broken.json")).length, 1, "a malformed file is logged once");
  let changes = 0;
  q.onChange(() => changes++);
  q.answer("early", 1);
  assert.deepEqual(q.pending().map((x) => x.id), ["late"], "answered: gone at once, before claude-ask removes the file");
  assert.equal(changes, 1);
  q.refresh();
  assert.deepEqual(q.pending().map((x) => x.id), ["late"], "and stays gone while its file lingers");
  const early = JSON.parse(readFileSync(join(dir, "answers", "early.json"), "utf8"));
  assert.deepEqual(Object.keys(early), ["id", "index", "optionId", "label", "cancelled", "answeredAt"]);
  assert.deepEqual({ ...early, answeredAt: 0 }, { id: "early", index: 1, optionId: "deny", label: "Refuser", cancelled: false, answeredAt: 0 });
  q.answer("late", 7); // no such option: nothing written
  assert.ok(!existsSync(join(dir, "answers", "late.json")));
  q.cancel("late");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "answers", "late.json"), "utf8"))), ["id", "cancelled", "reason", "answeredAt"]);
  assert.deepEqual(readdirSync(join(dir, "answers")).sort(), ["early.json", "late.json"], "atomic: no tmp left behind");
  q.stop();
}

// --- a question already waiting when the plugin starts, before any deck has connected ----
mkdirSync(QUESTIONS, { recursive: true });
mkdirSync(ANSWERS, { recursive: true });
for (const f of ["question.json", "answer.json", "lock"]) writeFileSync(join(askDir, f), "{}");
writeFileSync(join(ANSWERS, "orphan.json"), "{}"); // answered after its claude-ask gave up
put(question("q1"));
const focused: string[] = [];
startAsk(() => {}, (q) => focused.push(q.id));
for (const f of ["question.json", "answer.json", "lock"]) assert.ok(!existsSync(join(askDir, f)), `legacy ${f} removed`);
assert.ok(!existsSync(join(ANSWERS, "orphan.json")), "orphan answer removed");
assert.equal(ask.active()?.id, "q1", "read at startup");
assert.equal(pendingQuestion("s-q1")?.id, "q1");
assert.deepEqual(switches, [], "no connected deck yet");
for (const d of devices) d.isConnected = d.id !== "xl-off";
assert.ok(onConnect, "ask.ts listens for deviceDidConnect");
onConnect();
assert.deepEqual(switches, [["xl", "Claude Deck", 0]], "connected XL preferred over a keypad listed first");
onConnect();
assert.equal(switches.length, 1, "already shown: no second switch");

// a second session's question queues behind the first; the queue key counts it
put(question("q2", { createdAt: at(1_000) }));
await until("q2 queued", () => ask.othersCount() === 1);
const queueKey = new AskQueueAction();
queueKey.onWillAppear(key("queue", 0));
await until("queue key painted", () => images.has("queue"));
assert.match(svg("queue"), />\+1<\/text>/);

// option key: the answer names the option by id; the next question comes up, no switch
const option = new AskOptionAction();
option.onWillAppear(key("opt1", 1));
await option.onKeyDown(key("opt1", 1));
assert.deepEqual(answerOf("q1"), { id: "q1", index: 1, optionId: "deny", label: "Refuser", cancelled: false, answeredAt: undefined });
assert.equal(ask.active()?.id, "q2");
assert.equal(switches.length, 1, "still on the profile");

// claude-ask reads the answer and removes both files
rmSync(join(QUESTIONS, "q1.json"));
rmSync(join(ANSWERS, "q1.json"));

// Back: q2 set aside, nothing else pending → the deck goes back
const back = new AskBackAction();
back.onWillAppear(key("back", 0));
await back.onKeyDown(key("back", 0));
assert.equal(ask.active(), null);
assert.deepEqual(switches.at(-1), ["xl"], "switch back: no profile name");
assert.equal(pendingQuestion("s-q2")?.id, "q2", "still pending for its session key");

// its session key brings it back, on that key's deck
assert.ok(ask.showSession("s-q2", "mk2"));
assert.deepEqual(switches.at(-1), ["mk2", "Claude Deck", 0]);

// Terminal key: cancelled answer, the session's terminal comes forward, the deck goes back
const terminal = new AskTerminalAction();
terminal.onWillAppear(key("term", 0));
await terminal.onKeyDown(key("term", 0));
assert.deepEqual(answerOf("q2"), { id: "q2", cancelled: true, reason: "terminal", answeredAt: undefined });
assert.deepEqual(focused, ["q2"]);
assert.deepEqual(switches.at(-1), ["mk2"]);
rmSync(join(QUESTIONS, "q2.json"));
rmSync(join(ANSWERS, "q2.json"));

// withdrawn from the CLI side (timeout, answered in the terminal): the deck goes back
const before = switches.length;
put(question("q3"));
await until("q3 shown", () => switches.length === before + 1);
assert.deepEqual(switches.at(-1), ["xl", "Claude Deck", 0]);
rmSync(join(QUESTIONS, "q3.json"));
await until("q3 withdrawn", () => ask.active() === null);
assert.deepEqual(switches.at(-1), ["xl"]);
assert.deepEqual(readdirSync(ANSWERS), [], "a withdrawal writes no answer");

// its claude-ask died without cleaning up: dropped all the same
put(question("q4", { pid: deadPid }));
await new Promise((r) => setTimeout(r, 700));
assert.equal(ask.active(), null, "dead pid never shown");

rmSync(tmp, { recursive: true, force: true });
console.log("ok: ask keys");
process.exit(0); // the watcher and poll keep the loop alive
