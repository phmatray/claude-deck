#!/usr/bin/env node
// Re-renders icons/<state>.svg from the same templates the runtime uses.
// Run with:  pnpm icons:render   (which invokes the local `tsx` devDep).
//
// Why tsx? The icons modules use `.js` specifiers for ESM imports (project
// convention) but the underlying files are `.ts`. Node's bare
// --experimental-strip-types loader doesn't rewrite those specifiers, so we
// route through tsx instead. The SVGs already in icons/ are the canonical
// preview, so most users don't need to run this at all — tweak src/icons/*
// and re-run only if the design changes.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "icons");
mkdirSync(outDir, { recursive: true });

const { renderIcon } = await import(resolve(root, "src/icons/index.ts"));

const SAMPLES = [
  { state: "working",       slot: 1, label: "streamdeck-claude", branch: "main",             badge: "a6", frame: 3 },
  { state: "subagent",      slot: 2, label: "delegated-research", branch: "feat/agents",                  frame: 3 },
  { state: "idle",          slot: 3, label: "wolfgangparis",      branch: "main",                         frame: 0 },
  { state: "awaiting",            slot: 4, label: "ascory-website",    branch: "fix/nav",                 frame: 6 },
  { state: "awaiting_permission", slot: 5, label: "deploy-to-prod",    branch: "release",                 frame: 6 },
  { state: "awaiting_question",   slot: 5, label: "pick-an-option",    branch: "main",                    frame: 6 },
  { state: "awaiting_plan",       slot: 5, label: "publish",           branch: "feat/plan",               frame: 6 },
  { state: "error",         slot: 1, label: "rate-limited",       branch: "main",                         frame: 6 },
  { state: "finished",      slot: 2, label: "loadtestvideo",      branch: "a1b2c3d",                      frame: 0 },
  { state: "empty",         slot: 3, label: "",                                                           frame: 0 },
  // Bonus: both lines overflowing, which is what exercises the ellipsis.
  { state: "working", slot: 1, label: "very-long-singleword-that-overflows", branch: "feat/sort-by-last-activity", frame: 0 },
];

for (const sample of SAMPLES) {
  // Distinguish the "long-name overflow" sample by file name.
  const overflow = sample.label.includes("overflows");
  const filename = overflow ? `${sample.state}-overflow.svg` : `${sample.state}.svg`;
  writeFileSync(resolve(outDir, filename), renderIcon(sample));
  console.log(`wrote icons/${filename}`);
}
