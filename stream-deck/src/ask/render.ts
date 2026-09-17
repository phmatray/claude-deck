/** Key art for the answer keys, as base64 SVG data URLs for `setImage`. */

import { DETAIL_FONT_SIZE, DETAIL_LINE_HEIGHT, DETAIL_PAD_X, LINES_PER_KEY } from "./detail.js";
import type { QuestionKind } from "./queue.js";

const FONT = "Helvetica, Arial, sans-serif";
const SIZE = 144;
const ACCENT = "#63A4FF";
const LABEL_SIZES = [48, 44, 40, 37, 34, 31, 28, 25, 22, 20, 18];

// Helvetica-Bold advance widths, units per 1000em, so text can be measured
// exactly instead of guessed at from a character count.
const W: Record<string, number> = {
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

function widthAt(text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += W[ch] ?? 611;
  return (units / 1000) * size * 1.06;
}

/** Text for inside `<text>`. Every key's text passes here, straight from a command or a
 *  file: a character XML forbids (ESC from a colour code, BEL…) makes the whole SVG
 *  unparseable, so it becomes U+FFFD — one column for one, the detail strip stays aligned,
 *  and a hidden control character in a command shows up rather than vanishing. */
function esc(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "\uFFFD")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Greedy wrap on measured width. Returns null if a single word cannot fit.
function wrap(text: string, size: number, boxW: number): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
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

function fit(text: string, boxW: number, boxH: number, maxLines: number, sizes: number[]): { size: number; lines: string[] } {
  for (const size of sizes) {
    const lines = wrap(text, size, boxW);
    if (lines && lines.length <= maxLines && lines.length * size * 1.1 <= boxH) {
      return { size, lines };
    }
  }
  // Nothing fits: use the smallest size and clip with an ellipsis.
  const size = sizes[sizes.length - 1];
  const lines = wrap(text, size, boxW) || [text];
  const kept = lines.slice(0, maxLines);
  let last = kept[kept.length - 1];
  while (last && widthAt(last + "...", size) > boxW) last = last.slice(0, -1);
  kept[kept.length - 1] = last + "...";
  return { size, lines: kept };
}

interface BlockOptions {
  boxW: number;
  boxH: number;
  centerY: number;
  color: string;
  maxLines?: number;
  sizes?: number[];
}

function block(text: string, { boxW, boxH, centerY, color, maxLines = 3, sizes = LABEL_SIZES }: BlockOptions): string {
  // Every key's text comes through here from a question file, which is untrusted:
  // a number or a missing label must render, not throw.
  const { size, lines } = fit(String(text), boxW, boxH, maxLines, sizes);
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

function svgUrl(inner: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${inner}</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

function key(bg: string, stroke: string, inner: string): string {
  return svgUrl(
    `<rect x="1.5" y="1.5" width="${SIZE - 3}" height="${SIZE - 3}" rx="14" fill="${bg}" stroke="${stroke}" stroke-width="3"/>` + inner,
  );
}

export function optionKey(number: number, label: string): string {
  const badge = `<text x="12" y="29" font-family="${FONT}" font-size="21" font-weight="bold" fill="${ACCENT}">${number}</text>`;
  const body = block(label, { boxW: 124, boxH: 108, centerY: 84, color: "#FFFFFF" });
  return key("#111820", "#43536B", badge + body);
}

/** The project, and below it the dashboard's name for the session when that adds
 *  something (two sessions in one repo differ only there). */
export function contextKey(project: string, session?: string): string {
  const tag = `<text x="12" y="34" font-family="${FONT}" font-size="24" font-weight="bold" fill="#63D7B0">~/</text>`;
  const body = session
    ? block(project, { boxW: 124, boxH: 56, centerY: 76, color: "#EAFFF8", maxLines: 2, sizes: LABEL_SIZES.slice(4) }) +
      block(session, { boxW: 124, boxH: 24, centerY: 120, color: "#63D7B0", maxLines: 1, sizes: [22, 20, 18, 16] })
    : block(project, { boxW: 124, boxH: 84, centerY: 96, color: "#EAFFF8", maxLines: 2 });
  return key("#16232B", "#3E7F73", tag + body);
}

export function idleContextKey(): string {
  return key("#080B10", "#151C26", "");
}

export function emptyKey(): string {
  return key("#080B10", "#151C26", "");
}

/** Header key colours: which kind of question is up shows before any text is read. */
const KIND_COLORS: Record<QuestionKind, { bg: string; stroke: string }> = {
  permission: { bg: "#3A2708", stroke: "#F2A93B" },
  plan: { bg: "#2A1848", stroke: "#A77BFF" },
  ask: { bg: "#0E2545", stroke: ACCENT },
};

export function questionKey(text: string, kind: QuestionKind = "ask"): string {
  const body = block(text, { boxW: 124, boxH: 118, centerY: 74, color: "#FFFFFF" });
  const { bg, stroke } = KIND_COLORS[kind] ?? KIND_COLORS.ask;
  return key(bg, stroke, body);
}

const DETAIL_FONT = "ui-monospace, Menlo, monospace";

/** One key of the detail strip: its slice of the lines (detail.ts), monospace, left
 *  aligned at the same x on every key so columns continue across the row. No frame,
 *  so the sixteen keys read as one surface; with no text it is just that surface. */
export function detailKey(lines: string[]): string {
  const text = lines
    .slice(0, LINES_PER_KEY)
    .map((l, i) =>
      l.trim()
        ? `<text x="${DETAIL_PAD_X}" y="${DETAIL_FONT_SIZE + i * DETAIL_LINE_HEIGHT}" font-family="${DETAIL_FONT}" font-size="${DETAIL_FONT_SIZE}" fill="#D6DEE8">${esc(l)}</text>`
        : "",
    )
    .join("");
  return svgUrl(`<rect width="${SIZE}" height="${SIZE}" fill="#05080C"/>` + text);
}

export function idleQuestionKey(): string {
  const body = block("no question", { boxW: 122, boxH: 90, centerY: 72, color: "#55636F", maxLines: 2, sizes: [30, 26, 22] });
  return key("#080B10", "#151C26", body);
}

export function cancelKey(): string {
  const body = block("Terminal", { boxW: 124, boxH: 118, centerY: 74, color: "#FFE2E2" });
  return key("#3A1517", "#A24A4A", body);
}

/** How many other questions wait behind the one on the keys. */
export function queueKey(others: number): string {
  const body = block(`+${others}`, { boxW: 124, boxH: 118, centerY: 74, color: "#FFFFFF", maxLines: 1 });
  return key("#0E2545", ACCENT, body);
}

export function backKey(): string {
  const body = block("Retour", { boxW: 124, boxH: 118, centerY: 74, color: "#D6DEE8" });
  return key("#111820", "#43536B", body);
}
