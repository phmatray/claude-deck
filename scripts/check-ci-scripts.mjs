// Self-check for .github/workflows/ci.yml: it names every check script by hand, on
// purpose (a glob would eventually pick up a `probe-*`, which needs the real deck and
// the real ~/.claude). A hand-written list drifts silently — add a check, forget the
// workflow line, and CI stays green while the new logic goes untested. So: every
// `check-*` on disk is invoked on a `run:` line, and no `probe-*` is. The reverse
// direction needs no assert — a listed script that was deleted fails the job with ENOENT.
//
// The two directions match differently, on purpose. A check must appear as a real
// invocation: ci.yml's comments name scripts in prose, and a substring match over the
// whole file let a comment stand in for a deleted run line. A probe is matched against
// the raw text instead — the invocation forms are open-ended (`bash …`, a bare path),
// and a probe named anywhere in this workflow is worth failing over.
// Run: node scripts/check-ci-scripts.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

const names = ["scripts", path.join("stream-deck", "scripts")].flatMap((dir) =>
  readdirSync(path.join(root, dir)).map((f) => [dir, f]),
);
const checks = names.filter(([, f]) => f.startsWith("check-"));
const probes = names.filter(([, f]) => f.startsWith("probe-"));
assert.ok(checks.length > 10, `found ${checks.length} check scripts — the readdir is looking in the wrong place`);

/** Asserts against a workflow text — passed a mutated copy by the self-test below. */
function verify(yaml) {
  const invoked = new Set(
    [...yaml.matchAll(/^\s+(?:node|corepack pnpm exec tsx) scripts\/(\S+)/gm)].map((m) => m[1]),
  );
  for (const [dir, f] of checks) assert.ok(invoked.has(f), `ci.yml runs ${path.join(dir, f)}`);
  for (const [dir, f] of probes) {
    assert.ok(!yaml.includes(f), `ci.yml must never run the probe ${path.join(dir, f)}`);
  }
}

verify(workflow);

// Delete one run line, leave the script's name in a comment: that used to pass.
const [, first] = checks[0];
const mutated = `${workflow.replace(new RegExp(`^\\s+.*scripts/${first}\\n`, "m"), "")}\n# ${first}\n`;
assert.notEqual(mutated, workflow, `the run line for ${first} no longer looks like an invocation`);
assert.throws(() => verify(mutated), new RegExp(first), "a comment naming a check stands in for its run line");

console.log(`ok: ci.yml runs all ${checks.length} checks and no probe`);
