import { BORDER_INSET, BORDER_RADIUS, BORDER_SIZE, BORDER_STROKE } from "./theme.js";
import { xmlEscape } from "./text.js";
import type { ScopedUsageWindow, UsageSnapshot, UsageWindow } from "../usage.js";

/**
 * Tiles for the plan-usage keys (5-hour window, weekly window, per-model
 * weekly windows). Deliberately static — no motif, no animation: the user
 * asked for a quiet, stepped colour scale, so the only thing that moves is the
 * number itself.
 */

/** Which window a usage key is bound to. */
export type UsageKind = "five_hour" | "seven_day" | "model_scoped";

const BG = "#0f1115";
const MUTED = "#9ca3af";
const TRACK = "#1f2430";
const IDLE_ACCENT = "#374151";

const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const SANS = "-apple-system,'Segoe UI',system-ui,sans-serif";

/** The numbers only refresh while a Claude Code session is actually talking to
 *  the API, so a reading routinely sits still for half an hour or more. Past
 *  this, a small amber dot warns that the *percentage* may be behind. The reset
 *  countdown is not affected — `resets_at` is an absolute wall-clock timestamp
 *  and stays exactly as true as the moment it was fetched — so the footer keeps
 *  showing it, and only falls back to stating the snapshot's age when there is
 *  no future reset left to count down to. */
const AGING_MS = 15 * 60 * 1000;

/** Quiet stepped scale: comfortable → watch it → tight → about to bite. */
function accentFor(percent: number): string {
  if (percent >= 90) return "#ef4444";
  if (percent >= 75) return "#f97316";
  if (percent >= 50) return "#fbbf24";
  return "#22c55e";
}

const TITLES: Record<UsageKind, string> = {
  five_hour: "SESSION · 5H",
  seven_day: "WEEK · ALL",
  model_scoped: "WEEK · MODEL",
};

function frame(accent: string, opacity: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${BG}"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${accent}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="${opacity}"/>
${body}
</svg>`;
}

/** Full opacity on purpose: at 11px the title counts as normal text for WCAG,
 *  and dimming the red accent to 0.85 dropped it to 3.9:1 — worst legibility
 *  exactly at the 90%+ reading that most needs to be read. */
function title(text: string, color: string): string {
  return `<text x="72" y="26" font-family="${SANS}" font-size="11" font-weight="700" letter-spacing="0.12em" fill="${color}" text-anchor="middle">${xmlEscape(text)}</text>`;
}

function footer(text: string, color = MUTED): string {
  return text
    ? `<text x="72" y="130" font-family="${SANS}" font-size="12" font-weight="600" fill="${color}" text-anchor="middle">${xmlEscape(text)}</text>`
    : "";
}

/** Quiet "this reading is not fresh" marker — mirrors the slot badge position
 *  so it never lands on the centred title. */
function staleDot(): string {
  return `<circle cx="128" cy="16" r="4" fill="#f59e0b" opacity="0.9"/>`;
}

/** Horizontal capsule gauge. `percent` is clamped, so a server value above 100
 *  (possible once a window is exceeded) still draws inside the track. */
function bar(x: number, y: number, w: number, h: number, percent: number, accent: string): string {
  const filled = Math.max(0, Math.min(100, percent)) / 100;
  const r = (h / 2).toFixed(1);
  const fw = Math.max(filled > 0 ? h : 0, w * filled);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${TRACK}"/>`
    + (fw > 0 ? `<rect x="${x}" y="${y}" width="${fw.toFixed(1)}" height="${h}" rx="${r}" fill="${accent}"/>` : "");
}

/** "2h41m" / "43m" / "3d 4h" — coarse on purpose, so the tile only re-renders
 *  about once a minute and the dedup in the render loop stays effective. */
function untilText(resetsAtMs: number | undefined, now: number): string {
  if (resetsAtMs === undefined) return "";
  const left = resetsAtMs - now;
  if (left <= 0) return "resets now";
  const mins = Math.floor(left / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `resets in ${hours}h${String(mins % 60).padStart(2, "0")}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** True while the window's reset is still ahead of us — the only condition
 *  under which a countdown means anything. */
function hasFutureReset(resetsAtMs: number | undefined, now: number): boolean {
  return resetsAtMs !== undefined && resetsAtMs > now;
}

function ageText(fetchedAtMs: number, now: number): string {
  const mins = Math.round((now - fetchedAtMs) / 60000);
  if (mins < 60) return `${mins}m old`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
}

/** Neutral tile for "nothing to show" — missing snapshot, window absent from
 *  this plan, or a platform we don't read. Never an error tile: the plugin's
 *  session keys are unaffected and the user needn't act. */
function placeholder(kind: UsageKind, line: string): string {
  return frame(IDLE_ACCENT, "0.5", [
    title(TITLES[kind], MUTED),
    `<text x="72" y="80" font-family="${MONO}" font-size="30" font-weight="700" fill="${IDLE_ACCENT}" text-anchor="middle">--</text>`,
    footer(line, "#6b7280"),
  ].join("\n"));
}

function renderSingle(kind: UsageKind, w: UsageWindow, snapshot: UsageSnapshot, now: number): string {
  const accent = accentFor(w.percent);
  const age = now - snapshot.fetchedAtMs;
  const counting = hasFutureReset(w.resetsAtMs, now);
  const bottom = counting ? untilText(w.resetsAtMs, now) : ageText(snapshot.fetchedAtMs, now);
  return frame(accent, "0.95", [
    title(TITLES[kind], accent),
    age > AGING_MS ? staleDot() : "",
    `<text x="72" y="82" font-family="${MONO}" font-size="40" font-weight="700" fill="${accent}" text-anchor="middle">${Math.round(w.percent)}%</text>`,
    bar(18, 94, 108, 12, w.percent, accent),
    footer(bottom, counting ? MUTED : "#f59e0b"),
  ].join("\n"));
}

/** Up to three model buckets, worst first. Anything beyond that is dropped —
 *  three rows is what stays legible at 72px on hardware. */
const MAX_ROWS = 3;

function renderScoped(windows: ScopedUsageWindow[], snapshot: UsageSnapshot, now: number): string {
  const rows = windows.slice(0, MAX_ROWS);
  const worst = Math.max(...rows.map((r) => r.percent));
  const accent = accentFor(worst);
  const age = now - snapshot.fetchedAtMs;
  // Three rows of (label + gauge) plus the footer only fit if the stride stays
  // tight; a single row gets centred instead of hugging the title.
  const y0 = rows.length === 1 ? 72 : 50;
  const stride = 24;
  const body = rows.map((r, i) => {
    const y = y0 + i * stride;
    const c = accentFor(r.percent);
    return `<text x="18" y="${y}" font-family="${SANS}" font-size="13" font-weight="600" fill="${MUTED}" text-anchor="start">${xmlEscape(r.label)}</text>`
      + `<text x="126" y="${y}" font-family="${MONO}" font-size="13" font-weight="700" fill="${c}" text-anchor="end">${Math.round(r.percent)}%</text>`
      + bar(18, y + 6, 108, 8, r.percent, c);
  });
  const dropped = windows.length - rows.length;
  // Per-model buckets often carry no reset at all (`resets_at: null`), in which
  // case the snapshot's age is the only honest thing left to print.
  const counting = hasFutureReset(rows[0]?.resetsAtMs, now);
  const bottom = dropped > 0
    ? `+${dropped} more`
    : counting
      ? untilText(rows[0]?.resetsAtMs, now)
      : ageText(snapshot.fetchedAtMs, now);
  return frame(accent, "0.95", [
    title(TITLES.model_scoped, accent),
    age > AGING_MS ? staleDot() : "",
    body.join("\n"),
    footer(bottom, dropped > 0 || counting ? MUTED : "#f59e0b"),
  ].join("\n"));
}

export interface UsageIconOptions {
  kind: UsageKind;
  snapshot?: UsageSnapshot;
  /** False on platforms where we don't read the usage cache. */
  supported: boolean;
  /** Wall-clock ms; injectable for the drill script. */
  now?: number;
}

export function renderUsageIcon({ kind, snapshot, supported, now }: UsageIconOptions): string {
  const t = now ?? Date.now();
  if (!supported) return placeholder(kind, "macOS only");
  if (!snapshot) return placeholder(kind, "no data yet");
  if (kind === "model_scoped") {
    return snapshot.modelScoped.length > 0
      ? renderScoped(snapshot.modelScoped, snapshot, t)
      : placeholder(kind, "no model limit");
  }
  const w = kind === "five_hour" ? snapshot.fiveHour : snapshot.sevenDay;
  return w ? renderSingle(kind, w, snapshot, t) : placeholder(kind, "not on plan");
}
