// Self-check: the detail strip's text layout (src/ask/detail.ts) — wrapped once at the
// row width, cut into per-key columns that line up across keys, clipped to two rows.
// Run: pnpm exec tsx scripts/check-ask-detail.mts
import assert from "node:assert/strict";
import { COLS_PER_KEY, detailLines, KEYS_PER_ROW, LINES_PER_KEY, segmentLines } from "../src/ask/detail.ts";

const W = KEYS_PER_ROW * COLS_PER_KEY; // 104
const MAX = 2 * LINES_PER_KEY; // 12
const NBSP = "\u00A0";

// word wrap at the row width: no word split, the space at the break dropped
{
  const words = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, "0")}`); // 6 chars each
  const lines = detailLines(words.join(" "));
  assert.ok(lines.every((l) => l.length <= W), "no line wider than the row");
  assert.equal(lines[0], words.slice(0, 15).join(" "), "15 words = 104 chars fit exactly");
  assert.equal(lines[1], words.slice(15).join(" "), "the next line starts on a word, no leading space");
  assert.equal(detailLines("a " + "x".repeat(103))[1], "x".repeat(103), "a word that would overflow moves down whole");
}

// hard break: a token longer than a whole line starts where the line is and breaks at the width
{
  const url = "https://example.com/" + "p".repeat(200); // 220 chars
  const lines = detailLines(`curl ${url}`);
  assert.deepEqual(lines.map((l) => l.length), [104, 104, 17]);
  assert.equal(lines.join(""), `curl ${url}`);
}

// newlines kept (blank lines too), CRLF normalized, tabs as two spaces, indentation kept, trailing blank lines gone
assert.deepEqual(detailLines("one\r\n\r\ntwo\n\tthree\n  four\n\n"), ["one", "", "two", "  three", "  four"]);
assert.deepEqual(detailLines(""), []);

// truncation: two rows of lines at most, the last one ends with "…"
{
  const exactly = Array.from({ length: MAX }, (_, i) => `line ${i}`).join("\n");
  assert.deepEqual(detailLines(exactly), exactly.split("\n"), "12 lines fit: no ellipsis");
  const more = detailLines(exactly + "\nline 12");
  assert.equal(more.length, MAX);
  assert.equal(more[MAX - 1], "line 11…", "a short last line gets the ellipsis appended");
  const full = detailLines("x".repeat(W * 20));
  assert.equal(full.length, MAX);
  assert.equal(full[MAX - 1], "x".repeat(W - 1) + "…", "a full last line gives up its last char");
  // a huge input (a big MCP payload as JSON) stops wrapping once the strip is full
  const t = Date.now();
  assert.equal(detailLines(("{\"k\": \"" + "v".repeat(50) + "\"} ").repeat(40_000)).length, MAX);
  assert.ok(Date.now() - t < 1000, "huge input: early exit");
}

// segments: key k shows its row's lines, cut to columns [c*13, (c+1)*13)
{
  const lines = Array.from({ length: MAX }, (_, row) =>
    Array.from({ length: W }, (_, col) => String.fromCharCode(65 + (Math.floor(col / COLS_PER_KEY) + row) % 26)).join(""),
  );
  // row r, key column c holds letter (c + r) all the way through
  assert.deepEqual(segmentLines(lines, 0), lines.slice(0, 6).map((_, r) => String.fromCharCode(65 + r).repeat(13)));
  assert.deepEqual(segmentLines(lines, 9), lines.slice(6, 12).map((_, r) => String.fromCharCode(65 + 1 + 6 + r).repeat(13)), "segment 9: row 2, key 1");
  assert.deepEqual(segmentLines(lines, 15), lines.slice(6, 12).map((_, r) => String.fromCharCode(65 + 7 + 6 + r).repeat(13)));
  // a short text: keys past its end get empty lines, row 2 gets none
  const short = detailLines("git status --short");
  assert.deepEqual(segmentLines(short, 0), ["git\u00A0status\u00A0--"]);
  assert.deepEqual(segmentLines(short, 1), ["short"]);
  assert.deepEqual(segmentLines(short, 2), [""]);
  assert.deepEqual(segmentLines(short, 8), []);
}

// NBSP: every space survives SVG whitespace collapsing, so a column sits at the same x on each key
{
  const [seg] = segmentLines(detailLines("a    b"), 0);
  assert.equal(seg, `a${NBSP.repeat(4)}b`);
  assert.ok(!segmentLines(detailLines("x ".repeat(80)), 3).some((l) => l.includes(" ")), "no ordinary space left");
}

// a cut never splits a code point: an emoji at a column boundary stays whole
{
  const lines = detailLines("x".repeat(12) + "🙂" + "y");
  assert.equal(segmentLines(lines, 0)[0], "x".repeat(12) + "🙂");
  assert.equal(segmentLines(lines, 1)[0], "y");
}

console.log("ok: ask detail");
