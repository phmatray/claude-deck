// Self-check for bin/claude-ask input validation: whatever reaches a question file is
// painted on the keys, so bad input exits 1 before anything is written (and without
// touching another session's pending question).
// Run: node scripts/check-ask-input.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = new URL("../claude-code/bin/claude-ask", import.meta.url).pathname;
const dir = mkdtempSync(path.join(tmpdir(), "claude-ask-input-"));
const ask = (spec, askDir = dir, args = []) =>
  spawnSync(CLI, args, { input: JSON.stringify(spec), env: { ...process.env, CLAUDE_ASK_DIR: askDir, HOME: askDir }, encoding: "utf8" });

// another session's question is pending; rejected input must leave it alone
mkdirSync(path.join(dir, "questions"));
const other = path.join(dir, "questions", "other.json");
const pending = JSON.stringify({ id: "other", pid: process.pid, options: [{ id: "0", label: "A" }] });
writeFileSync(other, pending);

for (const [spec, args] of [
  [null],
  [{ options: "A B" }],
  [{ options: [] }],
  [{ options: [1, 2] }],
  [{ options: [{ description: "no label" }] }],
  [{ options: [{ label: "A", description: 7 }] }],
  [{ options: [{ id: 1, label: "A" }] }],
  [{ options: [{ id: "x", label: "A" }, { id: "x", label: "B" }] }],
  [{ options: ["A", { id: "0", label: "B" }] }], // the default id "0" collides with an explicit one
  [{ header: 5, options: ["A"] }],
  [{ question: ["x"], options: ["A"] }],
  [{ context: {}, options: ["A"] }],
  [{ detail: 3, options: ["A"] }],
  [{ sessionId: 42, options: ["A"] }],
  [{ kind: "shell", options: ["A"] }],
  [{ timeout: "soon", options: ["A"] }],
  [{ timeout: -1, options: ["A"] }],
  [{ options: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }],
  [{ options: ["A"] }, ["--session"]],
]) {
  const what = `${JSON.stringify(spec)} ${args ?? ""}`;
  const r = ask(spec, dir, args);
  assert.equal(r.status, 1, `${what}: exit 1 (${r.stderr.trim()})`);
  assert.deepEqual(readdirSync(path.join(dir, "questions")), ["other.json"], `${what}: nothing on the deck`);
  assert.equal(readFileSync(other, "utf8"), pending, `${what}: the other question untouched`);
}

// eight options, strings and objects mixed, pass validation (timeout 0 → exit 3, own files removed)
const free = mkdtempSync(path.join(tmpdir(), "claude-ask-input-"));
const r = ask({ header: "H", context: null, options: ["1", "2", "3", "4", "5", "6", "7", { label: "8", description: "d" }], timeout: 0 }, free);
assert.equal(r.status, 3, r.stderr);
assert.deepEqual(readdirSync(path.join(free, "questions")), []);
assert.deepEqual(readdirSync(path.join(free, "answers")), []);

rmSync(dir, { recursive: true, force: true });
rmSync(free, { recursive: true, force: true });
console.log("ok: claude-ask input");
