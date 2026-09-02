"use strict";

const FONT = "Helvetica, Arial, sans-serif";
const SIZE = 144;
const ACCENT = "#63A4FF";
const LABEL_SIZES = [48, 44, 40, 37, 34, 31, 28, 25, 22, 20, 18];

// Helvetica-Bold advance widths, units per 1000em, so text can be measured
// exactly instead of guessed at from a character count.
const W = {
  " ": 278, "!": 333, '"': 474, "#": 556, $: 556, "%": 889, "&": 722, "'": 238,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  ":": 333, ";": 333, "<": 584, "=": 584, ">": 584, "?": 611, "@": 975,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 333, "\\": 278, "]": 333, "^": 584, _: 556, "`": 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  "{": 389, "|": 280, "}": 389, "~": 584,
};
for (let d = 0; d <= 9; d++) W[String(d)] = 556;

function widthAt(text, size) {
  let units = 0;
  for (const ch of String(text)) units += W[ch] === undefined ? 611 : W[ch];
  return (units / 1000) * size * 1.06;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Greedy wrap on measured width. Returns null if a single word cannot fit.
function wrap(text, size, boxW) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (widthAt(word, size) > boxW) return null;
    const candidate = line ? line + " " + word : word;
    if (widthAt(candidate, size) <= boxW) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function fit(text, boxW, boxH, maxLines, sizes) {
  for (const size of sizes) {
    const lines = wrap(text, size, boxW);
    if (lines && lines.length <= maxLines && lines.length * size * 1.1 <= boxH) {
      return { size, lines };
    }
  }
  // Nothing fits: use the smallest size and clip with an ellipsis.
  const size = sizes[sizes.length - 1];
  const lines = wrap(text, size, boxW) || [String(text)];
  const kept = lines.slice(0, maxLines);
  let last = kept[kept.length - 1];
  while (last && widthAt(last + "...", size) > boxW) last = last.slice(0, -1);
  kept[kept.length - 1] = last + "...";
  return { size, lines: kept };
}

function block(text, { boxW, boxH, centerY, color, maxLines = 3, sizes = LABEL_SIZES }) {
  const { size, lines } = fit(text, boxW, boxH, maxLines, sizes);
  const lh = Math.round(size * 1.1);
  const top = centerY - ((lines.length - 1) * lh) / 2 + size * 0.35;
  // One <text> per line with an explicit left x: Stream Deck's SVG renderer does
  // not honour per-tspan x/y or text-anchor, which pushed text outside the key.
  return lines
    .map((l, i) => {
      const x = Math.round((SIZE - widthAt(l, size)) / 2);
      const y = Math.round(top + i * lh);
      return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="bold" fill="${color}">${esc(l)}</text>`;
    })
    .join("");
}

function key(bg, stroke, inner) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect x="1.5" y="1.5" width="${SIZE - 3}" height="${SIZE - 3}" rx="14" fill="${bg}" stroke="${stroke}" stroke-width="3"/>` +
    inner + `</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

function optionKey(number, label) {
  const badge = `<text x="12" y="29" font-family="${FONT}" font-size="21" font-weight="bold" fill="${ACCENT}">${number}</text>`;
  const body = block(label, { boxW: 124, boxH: 108, centerY: 84, color: "#FFFFFF" });
  return key("#111820", "#43536B", badge + body);
}

function contextKey(label) {
  const body = block(label, { boxW: 124, boxH: 84, centerY: 96, color: "#EAFFF8", maxLines: 2 });
  const tag = `<text x="12" y="34" font-family="${FONT}" font-size="24" font-weight="bold" fill="#63D7B0">~/</text>`;
  return key("#16232B", "#3E7F73", tag + body);
}

function idleContextKey() {
  return key("#080B10", "#151C26", "");
}

function emptyKey() {
  return key("#080B10", "#151C26", "");
}

function questionKey(text) {
  const body = block(text, { boxW: 124, boxH: 118, centerY: 74, color: "#FFFFFF" });
  return key("#0E2545", ACCENT, body);
}

function idleQuestionKey() {
  const body = block("no question", { boxW: 122, boxH: 90, centerY: 72, color: "#55636F", maxLines: 2, sizes: [30, 26, 22] });
  return key("#080B10", "#151C26", body);
}

function cancelKey() {
  const body = block("Use terminal", { boxW: 124, boxH: 118, centerY: 74, color: "#FFE2E2" });
  return key("#3A1517", "#A24A4A", body);
}

module.exports = { optionKey, emptyKey, questionKey, idleQuestionKey, cancelKey, contextKey, idleContextKey };
