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

// header key: the kind shows in its colours; an unknown kind (untrusted file) falls back to "ask"
const frame = (url: string) => svg(url).match(/stroke="(#[0-9A-F]+)"/)?.[1];
const strokes = (["permission", "plan", "ask"] as const).map((k) => frame(render.questionKey("x", k)));
assert.equal(new Set(strokes).size, 3, "one accent per kind");
assert.equal(frame(render.questionKey("x", "shell" as any)), strokes[2]);

// context key: the session name only adds a line when there is one
assert.equal((svg(render.contextKey("repo")).match(/<text /g) ?? []).length, 2, "~/ tag + project");
assert.match(svg(render.contextKey("repo", "repo-b7")), />repo-b7<\/text>/);

// detail key: frameless, monospace, one <text> per non-blank line at the same x, escaped, NBSP kept
{
  const art = svg(render.detailKey(["a\u00A0<b>", "", "\u00A0\u00A0", "&"]));
  assert.ok(!art.includes("stroke"), "no frame: the strip reads as one surface");
  const texts = [...art.matchAll(/<text x="(\d+)" y="(\d+)"[^>]*font-family="ui-monospace, Menlo, monospace"[^>]*>([^<]*)<\/text>/g)];
  assert.deepEqual(texts.map((t) => t[3]), ["a\u00A0&lt;b&gt;", "&amp;"], "blank lines draw nothing");
  assert.deepEqual(new Set(texts.map((t) => t[1])).size, 1, "one left x for every line");
  assert.ok(Number(texts[1][2]) > Number(texts[0][2]), "line 4 below line 1");
  assert.ok(!svg(render.detailKey([])).includes("<text"), "no text: a blank key");
}

console.log("ok: ask render");
