// Self-check for bin/claude-permission, no deck needed: the "key press" is an
// answers/<id>.json written the way the Stream Deck plugin writes it.
// Run: node scripts/check-permission.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return { askDir, child, done };
}

const questions = (askDir) => {
  try {
    return readdirSync(path.join(askDir, "questions")).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
};

async function waitQuestion(askDir) {
  for (let i = 0; i < 100; i++) {
    const [file] = questions(askDir);
    if (file) return JSON.parse(readFileSync(path.join(askDir, "questions", file), "utf8"));
    await sleep(50);
  }
  throw new Error("no question on the deck");
}

// What the plugin writes; `index` is deliberately not trusted by the hook.
const press = (askDir, q, optionId, index = q.options.findIndex((o) => o.id === optionId)) =>
  writeFileSync(
    path.join(askDir, "answers", `${q.id}.json`),
    JSON.stringify({ id: q.id, index, optionId, label: q.options[index]?.label, cancelled: false, answeredAt: new Date().toISOString() }),
  );

const homes = [];
function session(events = []) {
  const home = mkdtempSync(path.join(tmpdir(), "claude-permission-"));
  homes.push(home);
  mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  const log = path.join(home, ".claude", "sessions", "s1.events.ndjson");
  writeFileSync(log, events.map((e) => JSON.stringify(e) + "\n").join(""));
  return { home, log };
}
const bash = { session_id: "s1", cwd: "/work/horizon-hub", tool_name: "Bash", tool_input: { command: "git push --force origin main" } };
const decision = (out) => JSON.parse(out).hookSpecificOutput.decision;

// Autoriser → allow; the question carries the session, kind, detail and option ids
{
  const { home } = session([{ event: "PreToolUse" }]);
  const { askDir, done } = run(bash, home);
  const q = await waitQuestion(askDir);
  assert.equal(q.header, "git push --force");
  assert.equal(q.context, "horizon-hub");
  assert.equal(q.sessionId, "s1");
  assert.equal(q.kind, "permission");
  assert.equal(q.detail, "git push --force origin main");
  assert.deepEqual(q.options, [{ id: "allow", label: "Autoriser" }, { id: "deny", label: "Refuser" }]);
  press(askDir, q, "allow");
  const { code, out } = await done;
  assert.equal(code, 0);
  assert.deepEqual(decision(out), { behavior: "allow" });
  assert.deepEqual(questions(askDir), [], "question file removed");
  assert.deepEqual(readdirSync(path.join(askDir, "answers")), [], "answer file removed");
}

// Plan approval (ExitPlanMode, payload shape as captured live) → kind "plan", so the
// dashboard keeps awaiting_plan rather than the permission state
{
  const { home } = session();
  const plan = { session_id: "s1", cwd: "/work/horizon-hub", permission_mode: "plan", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n1. x", planFilePath: "/tmp/p.md" }, permission_suggestions: null };
  const { askDir, done } = run(plan, home);
  const q = await waitQuestion(askDir);
  assert.equal(q.kind, "plan");
  press(askDir, q, "deny");
  assert.equal(decision((await done).out).behavior, "deny");
}

// Refuser → deny
{
  const { home } = session();
  const { askDir, done } = run(bash, home);
  press(askDir, await waitQuestion(askDir), "deny");
  assert.deepEqual(decision((await done).out), { behavior: "deny", message: "Refusé depuis le Stream Deck." });
}

// Mapped by option id, never by index: index 0 with optionId "deny" still denies
{
  const { home } = session();
  const { askDir, done } = run(bash, home);
  press(askDir, await waitQuestion(askDir), "deny", 0);
  assert.equal(decision((await done).out).behavior, "deny");
}

// An option id the hook doesn't know → no decision, the dialog decides
{
  const { home } = session();
  const { askDir, done } = run(bash, home);
  press(askDir, await waitQuestion(askDir), "always", 0);
  assert.deepEqual(await done, { code: 0, out: "" });
}

// Terminal key (cancelled answer) → no decision
{
  const { home } = session();
  const { askDir, done } = run(bash, home);
  const q = await waitQuestion(askDir);
  writeFileSync(path.join(askDir, "answers", `${q.id}.json`), JSON.stringify({ id: q.id, cancelled: true, reason: "terminal" }));
  assert.deepEqual(await done, { code: 0, out: "" });
  assert.deepEqual(questions(askDir), []);
}

// Answered in the terminal → question withdrawn, no decision. Neither the permission-prompt
// Notification nor a PermissionRequest line (a parallel hook on the same event) withdraws it.
{
  const { home, log } = session([{ event: "PreToolUse" }]);
  const { askDir, done } = run(bash, home);
  await waitQuestion(askDir);
  appendFileSync(log, JSON.stringify({ event: "Notification", notifType: "permission_prompt" }) + "\n");
  appendFileSync(log, JSON.stringify({ event: "PermissionRequest", tool: "Bash" }) + "\n");
  await sleep(500);
  assert.equal(questions(askDir).length, 1, "Notification/PermissionRequest must not withdraw the question");
  appendFileSync(log, JSON.stringify({ event: "PostToolUse", tool: "Bash" }) + "\n");
  const { out } = await done;
  assert.equal(out, "");
  assert.deepEqual(questions(askDir), [], "withdrawn: off the deck");
}

// The hook itself killed (Claude Code gave up on it) → its question leaves the deck too
{
  const { home } = session();
  const { askDir, child, done } = run(bash, home);
  await waitQuestion(askDir);
  child.kill("SIGTERM");
  await done;
  for (let i = 0; i < 40 && questions(askDir).length; i++) await sleep(50);
  assert.deepEqual(questions(askDir), [], "claude-ask child cleaned up");
}

// AskUserQuestion has its own dialog → untouched
{
  const { home } = session();
  const { askDir, done } = run({ ...bash, tool_name: "AskUserQuestion", tool_input: {} }, home);
  assert.deepEqual(await done, { code: 0, out: "" });
  assert.deepEqual(questions(askDir), []);
}

for (const home of homes) rmSync(home, { recursive: true, force: true });
console.log("ok: claude-permission");
