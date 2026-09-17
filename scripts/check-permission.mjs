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
// The two Bash prompts captured live (map/captures/perm-*.json), inlined so this stays hermetic:
// one whose suggestions hold no rule to store, one whose addRules suggestion is the "Toujours" key.
const MKDIR = {
  tool_input: { command: "mkdir probe-x", description: "Create probe-x directory" },
  permission_suggestions: [
    { type: "addDirectories", directories: ["/work/horizon-hub"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ],
};
const PYTHON = {
  tool_input: { command: "python3 -c 'print(42)'", description: "Run Python command" },
  permission_suggestions: [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "python3 -c 'print(42)'" }], behavior: "allow", destination: "localSettings" },
  ],
};
// Not captured live, but the shape the filter has to survive: several suggestions, a DENY
// rule first, and the allow rule carrying more than one rule.
const MIXED = {
  tool_input: { command: "git log --oneline", description: "Show the log" },
  permission_suggestions: [
    { type: "setMode", mode: "acceptEdits", destination: "session" },
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf *" }], behavior: "deny", destination: "localSettings" },
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "git log:*" }, { toolName: "Bash", ruleContent: "git show:*" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ],
};
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
// dashboard keeps awaiting_plan rather than the permission state. A hook "allow" does not
// approve a plan, so the keys are "keep planning" (deny + message) and the terminal.
const plan = { session_id: "s1", cwd: "/work/horizon-hub", permission_mode: "plan", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n1. x\n## Step 2\nfix issue #42\n#hashtag stays", planFilePath: "/tmp/p.md" }, permission_suggestions: null };
{
  const { home } = session();
  // With a suggestion attached (captured plans have none): still no "Toujours" key, because a
  // hook "allow" can't approve a plan — the key would store a rule and leave the dialog up.
  const { askDir, done } = run({ ...plan, permission_suggestions: PYTHON.permission_suggestions }, home);
  const q = await waitQuestion(askDir);
  assert.equal(q.kind, "plan");
  assert.equal(q.header, "Plan prêt");
  assert.equal(q.detail, "Plan\n1. x\nStep 2\nfix issue #42\n#hashtag stays", "heading markers stripped on every line, other # kept");
  assert.deepEqual(q.options, [{ id: "revise", label: "Continuer à planifier" }, { id: "terminal", label: "Approuver au terminal" }]);
  press(askDir, q, "revise");
  assert.deepEqual(decision((await done).out), {
    behavior: "deny",
    message: "L'utilisateur veut continuer à planifier : ne lance pas le plan, demande-lui ce qu'il faut changer.",
  });
}

// "Approuver au terminal" makes no decision at all: the plugin treats option id "terminal"
// as its Terminal key (cancelled answer), and a plain answer on it is no decision either.
for (const answer of [(q) => ({ id: q.id, cancelled: true, reason: "terminal" }), (q) => ({ id: q.id, index: 1, optionId: "terminal", label: q.options[1].label, cancelled: false })]) {
  const { home } = session();
  const { askDir, done } = run(plan, home);
  const q = await waitQuestion(askDir);
  writeFileSync(path.join(askDir, "answers", `${q.id}.json`), JSON.stringify(answer(q)));
  assert.deepEqual(await done, { code: 0, out: "" });
}

// A suggestion Claude Code would store → the "Toujours" key between Autoriser and Refuser,
// echoed back verbatim in updatedPermissions, with the rule spelled out on the last detail line
{
  const { home } = session();
  const { askDir, done } = run({ ...bash, ...PYTHON }, home);
  const q = await waitQuestion(askDir);
  assert.deepEqual(q.options, [
    { id: "allow", label: "Autoriser" },
    { id: "always", label: "Toujours" },
    { id: "deny", label: "Refuser" },
  ]);
  assert.equal(q.detail, "python3 -c 'print(42)'\n\nRun Python command\nToujours = Bash(python3 -c 'print(42)') · localSettings");
  press(askDir, q, "always");
  assert.deepEqual(decision((await done).out), { behavior: "allow", updatedPermissions: PYTHON.permission_suggestions });
}

// Only the addRules suggestion that ALLOWS is stored, and only it: a deny rule sitting earlier
// in the list must not be echoed as an allow, and the rest of the list (setMode…) never travels
// with it. Its extra rules are counted on the detail line, since the key stores them all.
{
  const { home } = session();
  const { askDir, done } = run({ ...bash, ...MIXED }, home);
  const q = await waitQuestion(askDir);
  assert.deepEqual(q.options, [
    { id: "allow", label: "Autoriser" },
    { id: "always", label: "Toujours" },
    { id: "deny", label: "Refuser" },
  ]);
  assert.equal(q.detail, "git log --oneline\n\nShow the log\nToujours = Bash(git log:*) (+1 more) · localSettings");
  press(askDir, q, "always");
  assert.deepEqual(decision((await done).out), {
    behavior: "allow",
    updatedPermissions: [MIXED.permission_suggestions[2]],
  });
}

// Suggestions with no rule to store (addDirectories + setMode, the captured mkdir) → no Toujours
{
  const { home } = session();
  const { askDir, done } = run({ ...bash, ...MKDIR }, home);
  const q = await waitQuestion(askDir);
  assert.deepEqual(q.options, [{ id: "allow", label: "Autoriser" }, { id: "deny", label: "Refuser" }]);
  assert.equal(q.detail, "mkdir probe-x\n\nCreate probe-x directory", "no Toujours line without a rule");
  press(askDir, q, "allow");
  assert.deepEqual(decision((await done).out), { behavior: "allow" });
}

// The detail keys spell out the call, per tool (a cancelled answer ends each run)
{
  const detailOf = async (tool_name, tool_input) => {
    const { home } = session();
    const { askDir, done } = run({ session_id: "s1", cwd: "/work/horizon-hub", tool_name, tool_input }, home);
    const q = await waitQuestion(askDir);
    writeFileSync(path.join(askDir, "answers", `${q.id}.json`), JSON.stringify({ id: q.id, cancelled: true, reason: "terminal" }));
    await done;
    return q;
  };
  const cases = [
    ["Bash", { command: "mkdir probe-x", description: "Create probe-x directory" }, "mkdir probe-x\n\nCreate probe-x directory"],
    ["Edit", { file_path: "/w/a.ts", old_string: "\n  const a = 1;\n  return a;", new_string: "  const a = 2;" }, "/w/a.ts\nconst a = 1; → const a = 2;"],
    ["MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] }, "/w/a.ts\nx → y (+1 more)"],
    ["Edit", { file_path: "/w/a.ts", old_string: "foo", new_string: "" }, '/w/a.ts\nfoo → ""'],
    ["Write", { file_path: "/w/notes.md", content: "a\nb\nc\n" }, "/w/notes.md\nnew file, 3 lines"],
    ["Write", { file_path: "/w/one.txt", content: "single line" }, "/w/one.txt\nnew file, 1 line"],
    ["Read", { file_path: "/w/a.ts" }, "/w/a.ts"],
    ["NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "x" }, "/w/n.ipynb"],
    ["WebFetch", { url: "https://example.com/docs", prompt: "summarize" }, "https://example.com/docs"],
    ["mcp__github__create_issue", { title: "Bug" }, 'github › create_issue\n{"title":"Bug"}'],
    // an MCP tool with a file_path is still an MCP call: server, tool and the whole input
    ["mcp__filesystem__write_file", { file_path: "/w/secrets.env", content: "TOKEN=abc" }, 'filesystem › write_file\n{"file_path":"/w/secrets.env","content":"TOKEN=abc"}', "write_file secrets.env"],
    ["mcp__srv__ns__do", { k: 1 }, 'srv › ns__do\n{"k":1}'],
    ["WebSearch", { query: "stream deck xl" }, '{"query":"stream deck xl"}'],
    // no tool_input at all: both keys fall back to the tool's name rather than the hook dying
    ["Bash", null, "Bash", "Bash"],
  ];
  const got = await Promise.all(cases.map(([tool, input]) => detailOf(tool, input)));
  assert.deepEqual(got.map((q) => q.detail), cases.map((c) => c[2]));
  cases.forEach((c, i) => c[3] && assert.equal(got[i].header, c[3], `${c[0]} header`));
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

// An option id the question doesn't offer (no suggestion here, so no "Toujours" key) →
// claude-ask exits 3 → no decision, the dialog decides.
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
