// Self-check for .github/workflows/ci.yml: it names every check script by hand, on
// purpose (a glob would eventually pick up a `probe-*`, which needs the real deck and
// the real ~/.claude). A hand-written list drifts silently — add a check, forget the
// workflow line, and CI stays green while the new logic goes untested. So: every
// `check-*` on disk is named there, and no `probe-*` is. The reverse direction needs
// no assert — a listed script that was deleted fails the job with ENOENT.
// Run: node scripts/check-ci-scripts.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

const names = ["scripts", path.join("stream-deck", "scripts")].flatMap((dir) =>
  readdirSync(path.join(root, dir)).map((f) => [dir, f]),
);
const checks = names.filter(([, f]) => f.startsWith("check-"));
assert.ok(checks.length > 10, `found ${checks.length} check scripts — the readdir is looking in the wrong place`);

for (const [dir, f] of checks) assert.ok(workflow.includes(f), `ci.yml runs ${path.join(dir, f)}`);
for (const [dir, f] of names.filter(([, f]) => f.startsWith("probe-"))) {
  assert.ok(!workflow.includes(f), `ci.yml must never run the probe ${path.join(dir, f)}`);
}

console.log(`ok: ci.yml lists all ${checks.length} checks and no probe`);
