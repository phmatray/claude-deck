// Self-check: the answer-key art renders whatever a question file holds. A throw here
// rejects a fire-and-forget repaint, and enough of those kill the whole plugin.
// Run: pnpm exec tsx scripts/check-ask-render.mts
import assert from "node:assert/strict";
import * as render from "../src/ask/render.ts";

const svg = (url: string) => Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

// question files are untrusted: numbers and missing labels render as text
assert.match(svg(render.optionKey(1, 42 as any)), />42<\/text>/);
assert.match(svg(render.optionKey(2, undefined as any)), />undefined<\/text>/);
assert.match(svg(render.questionKey(2026 as any)), />2026<\/text>/);
assert.match(svg(render.contextKey(123 as any)), />123<\/text>/);

// one <text> per line with an explicit x, escaped, no text-anchor (the deck ignores it)
const art = svg(render.optionKey(3, "Keep <both> & merge them"));
assert.ok(art.includes("&lt;both&gt;") && art.includes("&amp;"));
assert.ok(!art.includes("text-anchor") && !art.includes("<tspan"));
assert.ok((art.match(/<text x="\d+" y="\d+"/g) ?? []).length >= 2, "wrapped onto several lines");

console.log("ok: ask render");
