// Renders .github/banner.png: the repo's header image, built from the plugin's own key
// art so it can never drift from what the hardware shows. A strip of dashboard keys in
// the states you actually look for, the wordmark, and the one-line pitch.
// Needs the system fonts (Helvetica) like the other renderers, so it is not a check.
// Run: pnpm banner:render
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderIcon } from "../src/icons/index.ts";

const KEY = 144;
const GAP = 16;
const KEYS = [
  { state: "awaiting_permission", slot: 1, label: "api-proxy", branch: "release", deck: true, frame: 6 },
  { state: "working", slot: 2, label: "claude-deck", branch: "main", badge: "a6", frame: 3 },
  { state: "awaiting_plan", slot: 3, label: "publish", branch: "feat/plan", frame: 6 },
  { state: "subagent", slot: 4, label: "research", branch: "feat/agents", frame: 3 },
  { state: "idle", slot: 5, label: "horizon-hub", branch: "main", frame: 0 },
] as const;

// The strip sits on the right; the wordmark gets the left third.
const STRIP_W = KEYS.length * KEY + (KEYS.length - 1) * GAP;
const PAD = 56;
const TEXT_W = 620;
const WIDTH = PAD + TEXT_W + STRIP_W + PAD;
const HEIGHT = KEY + PAD * 2;

const BG = "#0b0d12";
const TITLE = "#f4f6fb";
const SUB = "#94a3c4";
const ACCENT = "#d97757"; // the permission amber the keys use

const strip = KEYS.map((key, i) => {
  // Each key is a full 144x144 tile from the runtime renderer, dropped in unchanged.
  const inner = renderIcon({ ...key }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const x = PAD + TEXT_W + i * (KEY + GAP);
  return `<g transform="translate(${x} ${PAD})">${inner}</g>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
<text x="${PAD}" y="${PAD + 58}" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="700" fill="${TITLE}">Claude Deck</text>
<text x="${PAD}" y="${PAD + 102}" font-family="Helvetica, Arial, sans-serif" font-size="25" font-weight="500" fill="${SUB}">Every Claude Code session on a key.</text>
<text x="${PAD}" y="${PAD + 136}" font-family="Helvetica, Arial, sans-serif" font-size="25" font-weight="500" fill="${ACCENT}">Answer it with one press.</text>
${strip}
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH * 2 } }).render().asPng();
const out = fileURLToPath(new URL("../../.github/banner.png", import.meta.url));
writeFileSync(out, png);
console.log(`.github/banner.png (${WIDTH * 2}x${HEIGHT * 2}, ${Math.round(png.length / 1024)} KB)`);
