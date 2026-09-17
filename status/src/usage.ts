import { readFile, stat } from "node:fs/promises";
import { CLAUDE_CONFIG_FILE } from "./env.js";

/**
 * Plan usage (5-hour / weekly limits) for the Claude subscription behind the
 * running CLI sessions.
 *
 * Source of truth is `~/.claude.json` → `cachedUsageUtilization`, where Claude
 * Code parks the verbatim `/api/oauth/usage` payload it fetched (its own cache
 * TTL is 5 minutes). Reading the file instead of the endpoint means no
 * credentials, no network and no undocumented HTTP call from the plugin — at
 * the cost of the numbers freezing whenever no CC session is running. That
 * trade is deliberate; `fetchedAtMs` is surfaced so a stale snapshot is
 * visible on the key rather than silently wrong.
 *
 * Everything here is defensive: unknown/renamed windows fall out silently and
 * a malformed blob degrades to `undefined`, never a throw.
 */

/** One usage window. */
export interface UsageWindow {
  /** Percentage of the window consumed, 0-100. */
  percent: number;
  /** Epoch ms at which the window resets; undefined when the server omits it. */
  resetsAtMs?: number;
}

/** A weekly window scoped to one model bucket (e.g. "Fable"). */
export interface ScopedUsageWindow extends UsageWindow {
  /** Server-supplied bucket label — rendered verbatim, never hardcoded. */
  label: string;
}

export interface UsageSnapshot {
  /** Epoch ms at which Claude Code fetched this from the server. */
  fetchedAtMs: number;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Per-model weekly windows, highest utilisation first. */
  modelScoped: ScopedUsageWindow[];
}

/** Model-scoped windows the API exposes as named top-level keys rather than
 *  through `limits[]`. Claude Code's own `/usage` lists these *alongside* the
 *  `limits[]` buckets, not instead of them, so we merge both sources. Values
 *  are the label we draw when the server gives us no `display_name`. */
const NAMED_MODEL_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** ISO 8601 → epoch ms. The cached payload uses ISO strings (the statusLine
 *  payload uses epoch seconds — don't confuse the two). */
function parseResetsAt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** `{utilization, resets_at}` → UsageWindow. Windows that don't apply to the
 *  account come back as `null` and are dropped here. */
function toWindow(raw: unknown): UsageWindow | undefined {
  const o = asRecord(raw);
  if (!o || typeof o.utilization !== "number") return undefined;
  return { percent: o.utilization, resetsAtMs: parseResetsAt(o.resets_at) };
}

/** Pulls the per-model weekly buckets out of the `limits[]` array. Entries can
 *  be scoped to a model OR to a surface (e.g. an OAuth app); only model-scoped
 *  ones belong on the per-model key. */
function toModelScoped(raw: unknown): ScopedUsageWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: ScopedUsageWindow[] = [];
  for (const entry of raw) {
    const e = asRecord(entry);
    if (!e || typeof e.percent !== "number") continue;
    const model = asRecord(asRecord(e.scope)?.model);
    const label = model?.display_name;
    if (typeof label !== "string" || label.length === 0) continue;
    out.push({ label, percent: e.percent, resetsAtMs: parseResetsAt(e.resets_at) });
  }
  return out;
}

/** Every per-model weekly window the payload carries, worst first. The
 *  `limits[]` buckets win on collision because they come with the server's own
 *  label; the named windows only fill in what `limits[]` didn't mention.
 *  Dedup is by exact label, so a server that spells the same bucket two ways
 *  ("Opus" vs "Claude Opus 4.5") would surface both rows — which is what
 *  Claude Code's own usage screen does too, and is the safe way to fail. */
function collectModelScoped(u: Record<string, unknown>): ScopedUsageWindow[] {
  const byLabel = new Map<string, ScopedUsageWindow>();
  for (const w of toModelScoped(u.limits)) byLabel.set(w.label, w);
  for (const [key, label] of NAMED_MODEL_WINDOWS) {
    if (byLabel.has(label)) continue;
    const w = toWindow(u[key]);
    if (w) byLabel.set(label, { ...w, label });
  }
  return [...byLabel.values()].sort((a, b) => b.percent - a.percent);
}

function parseSnapshot(blob: unknown): UsageSnapshot | undefined {
  const cached = asRecord(asRecord(blob)?.cachedUsageUtilization);
  if (!cached) return undefined;
  const fetchedAtMs = cached.fetchedAtMs;
  const u = asRecord(cached.utilization);
  if (typeof fetchedAtMs !== "number" || !u) return undefined;

  return {
    fetchedAtMs,
    fiveHour: toWindow(u.five_hour),
    sevenDay: toWindow(u.seven_day),
    modelScoped: collectModelScoped(u),
  };
}

/** Re-parsing a ~250KB config blob every tick would be silly; `~/.claude.json`
 *  is rewritten often but `cachedUsageUtilization` only every 5 minutes, so we
 *  gate on mtime and keep the last parse. */
let cachedMtimeMs = -1;
let cachedSnapshot: UsageSnapshot | undefined;

/** Forces the next `readUsageSnapshot()` to re-read from disk (key press). */
export function invalidateUsageCache(): void {
  cachedMtimeMs = -1;
}

/** Latest usage snapshot, or undefined when the file is missing/unreadable or
 *  carries no usage cache yet (e.g. an API-key-only install). */
export async function readUsageSnapshot(): Promise<UsageSnapshot | undefined> {
  try {
    const { mtimeMs } = await stat(CLAUDE_CONFIG_FILE);
    if (mtimeMs === cachedMtimeMs) return cachedSnapshot;
    const raw = await readFile(CLAUDE_CONFIG_FILE, "utf8");
    cachedSnapshot = parseSnapshot(JSON.parse(raw));
    cachedMtimeMs = mtimeMs;
    return cachedSnapshot;
  } catch {
    // Missing file, mid-write truncation, malformed JSON — all render as
    // "no data" on the key; the next tick retries.
    cachedMtimeMs = -1;
    return cachedSnapshot;
  }
}
