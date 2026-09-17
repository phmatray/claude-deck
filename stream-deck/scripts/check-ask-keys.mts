// Self-check: the plugin half of the question.json/answer.json protocol — ask.ts puts
// the deck on "Claude Deck" while a question waits (even one that was already there
// before any deck connected) and sends it back afterwards, and the answer keys write
// exactly what claude-ask and claude-permission read. Hermetic: temp CLAUDE_ASK_DIR,
// temp cwd for the SDK's manifest/logs, fake devices and profile switcher.
// Run: pnpm exec tsx scripts/check-ask-keys.mts
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { startAsk, currentQuestion } = await import("../src/ask/ask.ts");
const { AskOptionAction, AskTerminalAction } = await import("../src/ask/actions.ts");
// The SDK only logs uncaught exceptions, and watchFile keeps the loop alive: fail loudly.
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

const QUESTION = join(askDir, "question.json");
const ANSWER = join(askDir, "answer.json");
async function until(what: string, cond: () => boolean): Promise<void> {
  for (const end = Date.now() + 3000; !cond(); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
  }
}
const question = (id: string) => ({ id, header: "Bash", context: "repo", options: [{ label: "Autoriser" }, { label: "Refuser" }] });
const key = (id: string, slot: number) => {
  const action = { id, isKey: () => true, coordinates: { column: slot, row: 3 }, setImage: async () => {}, showAlert: async () => {} };
  return { action, payload: { settings: { slot } } } as any;
};

// a question already waiting when the plugin starts, before any deck has connected
mkdirSync(askDir);
writeFileSync(QUESTION, JSON.stringify(question("q1")));
startAsk(() => {});
assert.equal(currentQuestion()?.id, "q1", "read at startup");
assert.deepEqual(switches, [], "no connected deck yet");
for (const d of devices) d.isConnected = d.id !== "xl-off";
assert.ok(onConnect, "ask.ts listens for deviceDidConnect");
onConnect();
assert.deepEqual(switches, [["xl", "Claude Deck", 0]], "connected XL preferred over a keypad listed first");
onConnect();
assert.equal(switches.length, 1, "already shown: no second switch");

// option key: answer carries the question id and the pressed slot
const option = new AskOptionAction();
option.onWillAppear(key("opt1", 1));
await option.onKeyDown(key("opt1", 1));
const a1 = JSON.parse(readFileSync(ANSWER, "utf8"));
assert.equal(typeof a1.answeredAt, "string");
assert.deepEqual({ ...a1, answeredAt: undefined }, { id: "q1", index: 1, label: "Refuser", cancelled: false, answeredAt: undefined });
assert.equal(currentQuestion(), null);
assert.deepEqual(switches.at(-1), ["xl"], "switch back: no profile name");

// claude-ask reads the answer and removes both files; the next question shows again
rmSync(QUESTION);
rmSync(ANSWER);
await new Promise((r) => setTimeout(r, 400));
assert.equal(currentQuestion(), null);
writeFileSync(QUESTION, JSON.stringify(question("q2")));
await until("q2 shown", () => switches.length === 3);
assert.deepEqual(switches.at(-1), ["xl", "Claude Deck", 0]);

// Terminal key: cancelled answer for that question
const terminal = new AskTerminalAction();
terminal.onWillAppear(key("term", 0));
await terminal.onKeyDown(key("term", 0));
const a2 = JSON.parse(readFileSync(ANSWER, "utf8"));
assert.deepEqual({ ...a2, answeredAt: undefined }, { id: "q2", cancelled: true, answeredAt: undefined });
assert.deepEqual(switches.at(-1), ["xl"]);
rmSync(QUESTION);
rmSync(ANSWER);

// withdrawn from the CLI side (timeout, answered in the terminal): the deck goes back
writeFileSync(QUESTION, JSON.stringify(question("q3")));
await until("q3 shown", () => switches.length === 5);
rmSync(QUESTION);
await until("q3 withdrawn", () => currentQuestion() === null);
assert.deepEqual(switches.at(-1), ["xl"]);
assert.ok(!existsSync(ANSWER), "a withdrawal writes no answer");

rmSync(tmp, { recursive: true, force: true });
console.log("ok: ask keys");
process.exit(0); // watchFile keeps the loop alive
