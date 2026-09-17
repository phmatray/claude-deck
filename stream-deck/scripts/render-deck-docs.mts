// Renders docs/deck-{permission,plan,ask}.png: the "Claude Deck" answer page as the XL
// shows it (8x4, build-profile.mjs's layout) for each kind of question, every key drawn
// by the plugin's own key art. The question fixtures mirror what claude-permission and
// claude-ask write. Not a check: the text needs the system fonts (Helvetica, Menlo).
// Run: pnpm docs:render
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detailLines, KEYS_PER_ROW, segmentLines } from "../src/ask/detail.ts";
import type { Question } from "../src/ask/queue.ts";
import * as render from "../src/ask/render.ts";

const KEY = 144;
const GAP = 18;
const COLS = KEYS_PER_ROW;
const ROWS = 4;

type Fixture = Pick<Question, "kind" | "context" | "header" | "detail" | "options"> & { session?: string; others: number };

const fixtures: Record<string, Fixture> = {
  permission: {
    kind: "permission",
    context: "horizon-hub",
    session: "horizon-hub-b7",
    header: "git fetch origin",
    detail:
      "git fetch origin && git rebase origin/main && corepack pnpm install --frozen-lockfile && corepack pnpm build && node scripts/check-permission.mjs" +
      "\n\nRebase on main, reinstall, rebuild and run the permission check",
    options: [{ id: "allow", label: "Autoriser" }, { id: "deny", label: "Refuser" }],
    others: 1,
  },
  plan: {
    kind: "plan",
    context: "horizon-hub",
    header: "ExitPlanMode",
    detail:
      "Context\n\nUser wants a simple test/scratch file created.\n\nPlan\n\n" +
      "1. Create `hello.txt` in the current working directory with the content `hi`.\n" +
      "2. Print the file's contents (e.g. `cat hello.txt`) to confirm.\n\nVerification\n\nRead the file back to confirm it contains `hi`.",
    options: [{ id: "allow", label: "Autoriser" }, { id: "deny", label: "Refuser" }],
    others: 0,
  },
  ask: {
    kind: "ask",
    context: "claude-deck",
    header: "Approach",
    detail:
      "Retries time out under load. Which fix?\n\n" +
      "1. Add jitter — Smallest change. Fixes the retry pile-up.\n" +
      "2. Token bucket — Fairer, but adds state to maintain.\n" +
      "3. Leave it — Not worth the churn right now.",
    options: [
      { id: "0", label: "Add jitter" },
      { id: "1", label: "Token bucket" },
      { id: "2", label: "Leave it" },
    ],
    others: 0,
  },
};

/** The key at (col,row), as the answer actions in src/ask/actions.ts paint it. */
function keyAt(q: Fixture, lines: string[], col: number, row: number): string | null {
  if (row === 1 || row === 2) return render.detailKey(segmentLines(lines, (row - 1) * COLS + col));
  if (row === 3) {
    const option = q.options[col];
    return option ? render.optionKey(col + 1, option.label) : render.emptyKey();
  }
  switch (col) {
    case 0: return render.contextKey(q.context!, q.session);
    case 1: return render.questionKey(q.header!, q.kind);
    case 5: return q.others > 0 ? render.queueKey(q.others) : render.emptyKey();
    case 6: return render.backKey();
    case 7: return render.cancelKey();
    default: return null; // no action on that key in the profile
  }
}

const width = COLS * KEY + (COLS + 1) * GAP;
const height = ROWS * KEY + (ROWS + 1) * GAP;
for (const [name, q] of Object.entries(fixtures)) {
  const lines = detailLines(q.detail!);
  let body = "";
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = GAP + col * (KEY + GAP);
      const y = GAP + row * (KEY + GAP);
      const url = keyAt(q, lines, col, row);
      body += url
        ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString("utf8").replace("<svg ", `<svg x="${x}" y="${y}" `)
        : `<rect x="${x}" y="${y}" width="${KEY}" height="${KEY}" rx="14" fill="#0B0D10"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" rx="28" fill="#000"/>${body}</svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
  const out = fileURLToPath(new URL(`../../docs/deck-${name}.png`, import.meta.url));
  writeFileSync(out, png);
  console.log(`  docs/deck-${name}.png (${width}x${height}, ${Math.round(png.length / 1024)} KB)`);
}
