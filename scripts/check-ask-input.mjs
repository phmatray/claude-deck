// Self-check for bin/claude-ask input validation: whatever reaches question.json is
// painted on the keys, so bad input exits 1 before the deck (or another question's
// lock) is touched.
// Run: node scripts/check-ask-input.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = new URL("../claude-code/bin/claude-ask", import.meta.url).pathname;
const dir = mkdtempSync(path.join(tmpdir(), "claude-ask-input-"));
const ask = (spec, askDir = dir) =>
  spawnSync(CLI, [], { input: JSON.stringify(spec), env: { ...process.env, CLAUDE_ASK_DIR: askDir }, encoding: "utf8" });

// another session's question holds the deck; rejected input must leave it alone
const lock = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
writeFileSync(path.join(dir, "lock"), lock);

for (const spec of [
  null,
  { options: "A B" },
  { options: [] },
  { options: [1, 2] },
  { options: [{ description: "no label" }] },
  { options: [{ label: "A", description: 7 }] },
  { header: 5, options: ["A"] },
  { question: ["x"], options: ["A"] },
  { context: {}, options: ["A"] },
  { options: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
]) {
  const r = ask(spec);
  assert.equal(r.status, 1, `${JSON.stringify(spec)}: exit 1 (${r.stderr.trim()})`);
  assert.ok(!existsSync(path.join(dir, "question.json")), `${JSON.stringify(spec)}: nothing on the deck`);
  assert.equal(readFileSync(path.join(dir, "lock"), "utf8"), lock, `${JSON.stringify(spec)}: lock untouched`);
}

// eight options, strings and objects mixed, pass validation (timeout 0 → exit 3, deck released)
const free = mkdtempSync(path.join(tmpdir(), "claude-ask-input-"));
const r = ask({ header: "H", context: null, options: ["1", "2", "3", "4", "5", "6", "7", { label: "8", description: "d" }], timeout: 0 }, free);
assert.equal(r.status, 3, r.stderr);
assert.ok(!existsSync(path.join(free, "question.json")) && !existsSync(path.join(free, "lock")));

rmSync(dir, { recursive: true, force: true });
rmSync(free, { recursive: true, force: true });
console.log("ok: claude-ask input");
