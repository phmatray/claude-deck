// Self-check for the per-session question files of bin/claude-ask: two sessions ask at
// once, are answered out of order, and each process only ever removes its own files.
// Hermetic: temp HOME (for the ancestor-pid session lookup) and CLAUDE_ASK_DIR.
// Run: node scripts/check-ask-queue.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = new URL("../claude-code/bin/claude-ask", import.meta.url).pathname;
const home = mkdtempSync(path.join(tmpdir(), "claude-ask-queue-"));
const askDir = path.join(home, "ask");
const questionsDir = path.join(askDir, "questions");
const answersDir = path.join(askDir, "answers");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(spec, args = []) {
  const child = spawn(CLI, args, { env: { ...process.env, HOME: home, CLAUDE_ASK_DIR: askDir } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stdin.end(JSON.stringify(spec));
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
  return { child, done };
}

const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
async function waitFor(what, pred) {
  for (let i = 0; i < 100; i++) {
    const found = pred();
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** The pending question of `session`, parsed. */
const questionOf = (session) =>
  waitFor(`${session}'s question`, () =>
    files(questionsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(questionsDir, f), "utf8")))
      .find((q) => q.sessionId === session),
  );
const answer = (q, optionId) =>
  writeFileSync(
    path.join(answersDir, `${q.id}.json`),
    JSON.stringify({ id: q.id, index: q.options.findIndex((o) => o.id === optionId), optionId, label: "?", cancelled: false }),
  );

// --- two sessions at once, answered out of order --------------------------------
const a = ask({ header: "A", sessionId: "sess-a", options: ["Oui", "Non"], timeout: 30 });
const b = ask({ header: "B", question: "Keep the cache?", options: [{ id: "keep", label: "Garder" }, { id: "drop", label: "Jeter", description: "d" }], timeout: 30 }, ["--session", "sess-b"]);
const qa = await questionOf("sess-a");
const qb = await questionOf("sess-b");

// the file protocol: atomic (no tmp left behind), ids, pid, timestamps
assert.deepEqual(files(questionsDir), [`${qa.id}.json`, `${qb.id}.json`].sort(), "one file per question, no tmp left");
assert.equal(qa.pid, a.child.pid);
assert.equal(qa.kind, "ask");
assert.equal(qa.cwd, process.cwd());
assert.deepEqual(qa.options, [{ id: "0", label: "Oui" }, { id: "1", label: "Non" }], "ids default to the index");
assert.deepEqual(qb.options, [{ id: "keep", label: "Garder" }, { id: "drop", label: "Jeter", description: "d" }]);
assert.equal(Date.parse(qa.expiresAt) - Date.parse(qa.createdAt), 30_000);
// no detail given: the detail keys get the question with every option spelled out
assert.equal(qa.detail, "1. Oui\n2. Non");
assert.equal(qb.detail, "Keep the cache?\n\n1. Garder\n2. Jeter — d");

answer(qb, "drop");
const rb = await b.done;
assert.equal(rb.code, 0);
assert.deepEqual(JSON.parse(rb.out), { index: 1, optionId: "drop", label: "Jeter", cancelled: false });
assert.deepEqual(files(questionsDir), [`${qa.id}.json`], "B removed only its own question");
assert.deepEqual(files(answersDir), [], "B removed its answer");

answer(qa, "0");
const ra = await a.done;
assert.equal(ra.code, 0);
assert.deepEqual(JSON.parse(ra.out), { index: 0, optionId: "0", label: "Oui", cancelled: false });
assert.deepEqual([files(questionsDir), files(answersDir)], [[], []]);

// --- Terminal key → exit 2 --------------------------------------------------------
{
  const c = ask({ sessionId: "sess-c", options: ["X"] });
  const qc = await questionOf("sess-c");
  assert.equal(Date.parse(qc.expiresAt) - Date.parse(qc.createdAt), 180_000, "default timeout: 180 s");
  writeFileSync(path.join(answersDir, `${qc.id}.json`), JSON.stringify({ id: qc.id, cancelled: true, reason: "terminal" }));
  assert.deepEqual(await c.done, { code: 2, out: "" });
  assert.deepEqual([files(questionsDir), files(answersDir)], [[], []]);
}

// --- SIGTERM on one leaves the other's files ---------------------------------------
{
  const d = ask({ sessionId: "sess-d", options: ["X"] });
  const e = ask({ sessionId: "sess-e", options: ["Y"] });
  const qd = await questionOf("sess-d");
  const qe = await questionOf("sess-e");
  d.child.kill("SIGTERM");
  assert.equal((await d.done).code, 3);
  assert.deepEqual(files(questionsDir), [`${qe.id}.json`], "D removed its question, and only that");
  answer(qe, "0");
  assert.equal((await e.done).code, 0, "E still gets its answer");
}

// --- session id from the ancestor pids: this process is claude-ask's parent ----------
{
  mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "from-ancestor" }));
  const f = ask({ options: ["X"], timeout: 30 });
  const qf = await questionOf("from-ancestor");
  assert.equal(qf.pid, f.child.pid);
  f.child.kill("SIGTERM");
  await f.done;
  // and past an intermediate process, as when the skill runs it from a Bash tool call
  const sh = spawn("/bin/sh", ["-c", '"$0"; exit $?', CLI], { env: { ...process.env, HOME: home, CLAUDE_ASK_DIR: askDir } });
  sh.stdin.end(JSON.stringify({ options: ["X"], timeout: 30 }));
  const qs = await questionOf("from-ancestor");
  assert.notEqual(qs.pid, sh.pid, "a shell sits between this process and claude-ask");
  process.kill(qs.pid, "SIGTERM");
  await new Promise((resolve) => sh.on("exit", resolve));
  // an explicit id wins over the walk
  const g = ask({ sessionId: "explicit", options: ["X"], timeout: 30 });
  await questionOf("explicit");
  g.child.kill("SIGTERM");
  await g.done;
}

// --- no session anywhere → null; timeout → exit 3, files gone --------------------------
{
  rmSync(path.join(home, ".claude"), { recursive: true, force: true });
  const h = ask({ options: ["X"], timeout: 1 });
  const q = await waitFor("an unattributed question", () => files(questionsDir).find((f) => f.endsWith(".json")));
  assert.equal(JSON.parse(readFileSync(path.join(questionsDir, q), "utf8")).sessionId, null);
  assert.equal((await h.done).code, 3);
  assert.deepEqual([files(questionsDir), files(answersDir)], [[], []]);
}

rmSync(home, { recursive: true, force: true });
console.log("ok: claude-ask queue");
