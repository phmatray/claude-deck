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
console.log("ok: animation budget");
