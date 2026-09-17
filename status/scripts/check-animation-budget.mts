// Self-check: only states that need the user animate. Every animated key streams
// a frame to the deck each ANIMATION_MS, and busy sessions are the common case.
// Run: pnpm exec tsx scripts/check-animation-budget.mts
import assert from "node:assert/strict";
import { STATES } from "../src/icons/states.ts";

const animated = Object.entries(STATES).filter(([, def]) => def.animated).map(([name]) => name).sort();
assert.deepEqual(animated, [
  "awaiting", "awaiting_permission", "awaiting_plan", "awaiting_question",
  "bg_awaiting", "bg_awaiting_permission", "error",
]);

// Idle is a static, pure line-art motif drawn in the state's accent.
for (const def of [STATES.idle, STATES.bg_idle]) {
  const svg = def.motif(0, "#123456");
  assert.equal(def.motif(7, "#123456"), svg, "idle motif ignores the frame");
  assert.ok(svg.includes("#123456") && !/#de886d/i.test(svg), "idle motif uses the accent colour");
}
console.log("ok: animation budget");
