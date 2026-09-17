import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./env.js";
import { spawnCapture } from "./spawn-capture.js";

/**
 * Warp stores per-pane cwd + per-tab/window structure in a sqlite DB under
 * its per-user app data. Reading it (read-only, WAL-safe via
 * `sqlite3 -readonly`) lets us recover `(window_id, tab_index)` for a given
 * cwd — Warp exposes no IPC surface for it (no AX content, no URL verb that
 * focuses a tab by cwd).
 *
 * Stable and Preview ship the same Diesel-managed schema.
 */
const GROUP_ROOT = join(HOME, "Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support");
const DB_CANDIDATES = [
  join(GROUP_ROOT, "dev.warp.Warp-Stable/warp.sqlite"),
  join(GROUP_ROOT, "dev.warp.Warp-Preview/warp.sqlite"),
];

/** Ships with macOS. */
const SQLITE = "/usr/bin/sqlite3";

export interface WarpPaneRow {
  windowId: number;
  tabIndex: number;
  paneCwd: string;
}

export interface WarpSnapshot {
  panes: WarpPaneRow[];
  /** windowId → current active tab_index (used to compute cycle delta). */
  activeTabByWindow: Map<number, number>;
  /** windowId → total tab count (used to pick shorter cycle direction). */
  tabCountByWindow: Map<number, number>;
}

export type WarpDbResult =
  | { ok: true; snapshot: WarpSnapshot }
  | { ok: false; error: string };

export async function readWarpPanes(): Promise<WarpDbResult> {
  const db = DB_CANDIDATES.find((p) => existsSync(p));
  if (!db) return { ok: false, error: "warp-db-not-found" };

  // Two result blocks separated by a SECTION marker row, run in one sqlite3
  // invocation. SQL passed as a CLI arg (NOT via stdin) so `-separator $'\t'`
  // applies cleanly — stdin mode would need `.mode tabs` and dot-commands are
  // whitespace-sensitive in ways that bit us before.
  const sql =
    "SELECT 'PANES';" +
    "WITH tabs_ordered AS (" +
    "  SELECT id, window_id," +
    "    ROW_NUMBER() OVER (PARTITION BY window_id ORDER BY id) - 1 AS tab_index" +
    "  FROM tabs" +
    ") " +
    "SELECT t.window_id, t.tab_index, tp.cwd " +
    "FROM terminal_panes tp " +
    "JOIN pane_nodes pn ON pn.id = tp.id " +
    "JOIN tabs_ordered t ON t.id = pn.tab_id " +
    "WHERE tp.cwd IS NOT NULL AND tp.cwd != '' " +
    "ORDER BY t.window_id, t.tab_index;" +
    "SELECT 'WINDOWS';" +
    "SELECT w.id, w.active_tab_index, (SELECT COUNT(*) FROM tabs WHERE window_id = w.id) FROM windows w;";

  const r = await spawnCapture(SQLITE, ["-readonly", "-separator", "\t", db, sql], { timeoutMs: 1500 });
  if (r.timedOut) return { ok: false, error: "timeout" };
  if (r.err) return { ok: false, error: `spawn: ${r.err}` };
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit-${r.code}` };
  try {
    return { ok: true, snapshot: parseSnapshot(r.stdout) };
  } catch (err) {
    return { ok: false, error: `parse: ${(err as Error).message}` };
  }
}

function parseSnapshot(stdout: string): WarpSnapshot {
  const panes: WarpPaneRow[] = [];
  const activeTabByWindow = new Map<number, number>();
  const tabCountByWindow = new Map<number, number>();

  let section: "PANES" | "WINDOWS" | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line === "PANES") { section = "PANES"; continue; }
    if (line === "WINDOWS") { section = "WINDOWS"; continue; }
    const parts = line.split("\t");
    if (section === "PANES" && parts.length >= 3) {
      const w = parseInt(parts[0], 10);
      const t = parseInt(parts[1], 10);
      if (Number.isInteger(w) && Number.isInteger(t)) {
        panes.push({ windowId: w, tabIndex: t, paneCwd: parts.slice(2).join("\t") });
      }
    } else if (section === "WINDOWS" && parts.length >= 3) {
      const w = parseInt(parts[0], 10);
      const a = parseInt(parts[1], 10);
      const c = parseInt(parts[2], 10);
      if (Number.isInteger(w)) {
        if (Number.isInteger(a)) activeTabByWindow.set(w, a);
        if (Number.isInteger(c)) tabCountByWindow.set(w, c);
      }
    }
  }
  return { panes, activeTabByWindow, tabCountByWindow };
}

/**
 * Pick the best (windowId, tabIndex) for the given cwd, by:
 *   1. Exact match — strongest signal.
 *   2. Prefix or parent match — handles `cd <subdir>` drift inside a pane.
 *   3. Token overlap on path components — fuzzy fallback.
 * Returns null if nothing scores > 0 or if the top score is tied across
 * different (window, tab) pairs.
 */
export function pickBestPane(
  cwd: string,
  rows: WarpPaneRow[],
): { windowId: number; tabIndex: number; score: number; paneCwd: string } | null {
  const target = normalize(cwd);
  if (!target) return null;
  const targetTokens = tokenize(target);

  const scored = rows.map((r) => ({ row: r, score: scorePane(target, targetTokens, r.paneCwd) }));

  let top = { score: 0, row: null as WarpPaneRow | null };
  let tied = false;
  for (const s of scored) {
    if (s.score > top.score) {
      top = { score: s.score, row: s.row };
      tied = false;
    } else if (s.score === top.score && s.score > 0 && top.row) {
      const sameTab = s.row.windowId === top.row.windowId && s.row.tabIndex === top.row.tabIndex;
      if (sameTab) continue;
      // Exact (1000) and prefix/parent (500) matches are strong, unambiguous
      // signals: when the same cwd (or its parent) resolves to multiple tabs
      // — the user has the dir open in two tabs, or (common with monorepo
      // subdirs) Warp hasn't yet flushed the exact pane cwd so only the parent
      // dir is in the DB and several tabs sit on it — we pick the lowest
      // (windowId, tabIndex) deterministically rather than refusing. "Lowest"
      // = leftmost tab in the lowest-id window, since Warp renumbers tab ids
      // to track visual order, so re-opens of the same dir consistently land
      // on the leftmost tab. Refusing here was the cause of intermittent
      // "no-match" silent no-ops for subdir sessions. Only token-overlap ties
      // (< 500) keep the strict tie-break — they have no canonical winner.
      if (s.score >= 500) {
        const better =
          s.row.windowId < top.row.windowId ||
          (s.row.windowId === top.row.windowId && s.row.tabIndex < top.row.tabIndex);
        if (better) top = { score: s.score, row: s.row };
      } else {
        tied = true;
      }
    }
  }
  if (!top.row || top.score === 0 || tied) return null;
  return { windowId: top.row.windowId, tabIndex: top.row.tabIndex, score: top.score, paneCwd: top.row.paneCwd };
}

/**
 * Score one pane's cwd against an already-normalized target + its tokens:
 *   1000 exact, 500 prefix/parent, else count of shared path tokens.
 */
function scorePane(target: string, targetTokens: Set<string>, paneCwd: string): number {
  const p = normalize(paneCwd);
  if (p === target) return 1000;
  if (p.startsWith(target + "/") || target.startsWith(p + "/")) return 500;
  let score = 0;
  for (const tok of tokenize(p)) if (targetTokens.has(tok)) score++;
  return score;
}

/**
 * Short human-readable summary of the top-scoring panes for `cwd`, for logging
 * on a no-match (helps diagnose ties / stale cwds without dumping the whole DB).
 */
export function describeTopPanes(cwd: string, rows: WarpPaneRow[], limit = 3): string {
  const target = normalize(cwd);
  if (!target) return "no-target";
  const targetTokens = tokenize(target);
  return rows
    .map((r) => ({ r, score: scorePane(target, targetTokens, r.paneCwd) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r, score }) => `w${r.windowId}t${r.tabIndex}@${score}:"${r.paneCwd}"`)
    .join(", ");
}

function normalize(p: string): string {
  return p.replace(/\/+$/, "").trim();
}

function tokenize(p: string): Set<string> {
  return new Set(p.toLowerCase().split(/[\/\\\-_.\s:]+/).filter((t) => t.length >= 2));
}
