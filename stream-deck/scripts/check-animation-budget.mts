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

// Idle is a static, pure line-art motif drawn in the state's accent: same output
// for any frame and any clock, a prompt window centred on (72,60) within y 25..95.
const realNow = Date.now;
for (const def of [STATES.idle, STATES.bg_idle]) {
  Date.now = () => 0;
  const svg = def.motif(0, "#123456");
  Date.now = () => 1_234_567;
  assert.equal(def.motif(7, "#123456"), svg, "idle motif ignores the frame and the clock");
  assert.ok(svg.includes("#123456") && !/#de886d/i.test(svg), "idle motif uses the accent colour");
  const [x, y, w, h] = (svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/) ?? []).slice(1).map(Number);
  assert.deepEqual([x + w / 2, y + h / 2], [72, 60], "prompt window centred on (72,60)");
  assert.ok(y >= 25 && y + h <= 95, "prompt window within y 25..95");
  assert.match(svg, /<rect [^>]*fill="none"[^>]*stroke="#123456"/, "prompt window is an unfilled outline in the accent");
  assert.match(svg, /<path [^>]*stroke="#123456"/, "chevron drawn in the accent");
  assert.match(svg, /<line [^>]*stroke="#123456"/, "cursor drawn in the accent");
}
Date.now = realNow;
console.log("ok: animation budget");
