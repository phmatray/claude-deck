// Self-check for bin/claude-permission, no deck needed: the "key press" is an
// answer.json written the way the Stream Deck plugin writes it.
// Run: node scripts/check-permission.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HOOK = new URL("../claude-code/bin/claude-permission", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(input, home) {
  const askDir = path.join(home, "ask");
  const child = spawn(HOOK, [], { env: { ...process.env, HOME: home, CLAUDE_ASK_DIR: askDir } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stdin.end(JSON.stringify(input));
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
  return { askDir, done };
}

async function waitQuestion(askDir) {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(readFileSync(path.join(askDir, "question.json"), "utf8"));
    } catch {}
    await sleep(50);
  }
  throw new Error("no question on the deck");
}

const press = (askDir, q, index) =>
  writeFileSync(path.join(askDir, "answer.json"), JSON.stringify({ id: q.id, index, label: q.options[index].label, cancelled: false }));

function session(events = []) {
  const home = mkdtempSync(path.join(tmpdir(), "claude-permission-"));
  mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  const log = path.join(home, ".claude", "sessions", "s1.events.ndjson");
  writeFileSync(log, events.map((e) => JSON.stringify(e) + "\n").join(""));
  return { home, log };
}
const bash = { session_id: "s1", cwd: "/work/horizon-hub", tool_name: "Bash", tool_input: { command: "git push --force origin main" } };

// Autoriser → allow
{
  const { home } = session([{ event: "PreToolUse" }]);
  const { askDir, done } = run(bash, home);
  const q = await waitQuestion(askDir);
  assert.equal(q.header, "git push --force");
  assert.equal(q.context, "horizon-hub");
  press(askDir, q, 0);
  const { out } = await done;
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: "allow" });
}

// Refuser → deny
{
  const { home } = session();
  const { askDir, done } = run(bash, home);
  press(askDir, await waitQuestion(askDir), 1);
  assert.equal(JSON.parse((await done).out).hookSpecificOutput.decision.behavior, "deny");
}

// Answered in the terminal → question withdrawn, no decision; the idle Notification alone doesn't withdraw
{
  const { home, log } = session([{ event: "PreToolUse" }]);
  const { askDir, done } = run(bash, home);
  await waitQuestion(askDir);
  appendFileSync(log, JSON.stringify({ event: "Notification", notifType: "permission_prompt" }) + "\n");
  await sleep(500);
  assert.ok(existsSync(path.join(askDir, "question.json")), "Notification must not withdraw the question");
  appendFileSync(log, JSON.stringify({ event: "PostToolUse", tool: "Bash" }) + "\n");
  const { out } = await done;
  assert.equal(out, "");
  assert.ok(!existsSync(path.join(askDir, "question.json")), "deck released");
  assert.ok(!existsSync(path.join(askDir, "lock")), "lock released");
}

// AskUserQuestion has its own dialog → untouched
{
  const { home } = session();
  const { askDir, done } = run({ ...bash, tool_name: "AskUserQuestion", tool_input: {} }, home);
  assert.deepEqual(await done, { code: 0, out: "" });
  assert.ok(!existsSync(path.join(askDir, "question.json")));
}

console.log("ok: claude-permission");
