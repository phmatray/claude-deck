// Self-check: the stateless burn-rate projection (src/usage.ts `projectLimit`, and its
// wiring through readUsageSnapshot) plus the footer it draws (src/icons/usage-icon.ts).
// Hermetic: fixed timezone, fixed `now`, and a temp HOME holding a fake ~/.claude.json
// shaped like the real `cachedUsageUtilization` blob (map/usage.md §1, redacted).
// Run: pnpm exec tsx scripts/check-usage-projection.mts
process.env.TZ = "Europe/Paris"; // the expected clock strings below are local wall time
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageKind } from "../src/icons/usage-icon.ts";
import type { UsageWindow } from "../src/usage.ts";

const home = mkdtempSync(join(tmpdir(), "claude-deck-usage-"));
process.env.HOME = home; // before the imports: env.ts reads homedir() at load

const { invalidateUsageCache, projectLimit, readUsageSnapshot } = await import("../src/usage.ts");
const { renderUsageIcon } = await import("../src/icons/usage-icon.ts");

const MIN = 60_000;
const H = 60 * MIN;

// ── the pure function, on numbers small enough to check by hand ───────────────
// A 5-hour window running from 0 to 5h, read 3h in.
const W5 = 5 * H;
const read3h = { fetchedAtMs: 3 * H, resetsAtMs: W5, windowMs: W5 };

assert.equal(projectLimit({ ...read3h, percent: 75 }), 4 * H, "3h bought 75% → the lot goes in 4h");
assert.equal(projectLimit({ ...read3h, percent: 60 }), undefined, "landing exactly on the reset is not a limit you hit");
assert.equal(projectLimit({ ...read3h, percent: 59 }), undefined, "past the reset → the countdown keeps the footer");
assert.equal(projectLimit({ ...read3h, percent: 100 }), 3 * H, "already spent → the reading's own time");
assert.equal(projectLimit({ ...read3h, percent: 104, resetsAtMs: undefined }), 3 * H, "…even with no reset in the payload");
assert.equal(projectLimit({ ...read3h, percent: 0 }), undefined, "nothing burned, no pace");
assert.equal(projectLimit({ ...read3h, percent: -1 }), undefined, "a nonsense percentage never projects");
assert.equal(projectLimit({ ...read3h, percent: 50, resetsAtMs: undefined }), undefined, "no reset and no start → nothing to extrapolate from");
assert.equal(projectLimit({ percent: 5, fetchedAtMs: 9 * MIN, resetsAtMs: W5, windowMs: W5 }), undefined, "9 min in, the integer percent is still noise");
assert.equal(projectLimit({ percent: 5, fetchedAtMs: 10 * MIN, resetsAtMs: W5, windowMs: W5 }), 200 * MIN, "10 min at 5% → 3h20m");
assert.equal(projectLimit({ percent: 5, fetchedAtMs: 0, resetsAtMs: W5, windowMs: W5 }), undefined, "a reading at the window start");
// 1h start + (3h − 1h) × 100/75 = 1h + 2h40m
assert.equal(projectLimit({ ...read3h, percent: 75, startedAtMs: H }), 13_200_000, "a server-stated start wins over reset − windowMs");

// ── the real payload shape ───────────────────────────────────────────────────
const FETCHED_AT = Date.parse("2026-09-17T10:00:00.000Z");
const NOW = FETCHED_AT + 2 * MIN;
const RESET_5H = "2026-09-17T12:00:00.738326+00:00";
const RESET_7D = "2026-09-19T13:00:00.738383+00:00";
const WEEK_START = "2026-09-12T13:00:00.738383+00:00"; // = RESET_7D − 7d, as the server sends it

/** The redacted live blob, trimmed to the keys the parser looks at. */
function fixture(patch: (u: Record<string, any>) => void = () => {}): unknown {
  const u: Record<string, any> = {
    five_hour: { utilization: 8, resets_at: RESET_5H, limit_dollars: null, locked_reason: null },
    seven_day: { utilization: 84, resets_at: RESET_7D, limit_dollars: null, locked_reason: null },
    seven_day_opus: null,
    seven_day_sonnet: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, utilization: null },
    limits: [
      { kind: "session", group: "session", percent: 8, severity: "normal", resets_at: RESET_5H, scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 84, severity: "warning", resets_at: RESET_7D, scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 100, severity: "critical", resets_at: "2026-09-19T12:59:59.738618+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
    seven_day_breakdown: {
      as_of: "2026-09-17T10:00:00.000000+00:00",
      window_started_at: WEEK_START,
      rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }],
    },
  };
  patch(u);
  return { cachedUsageUtilization: { fetchedAtMs: FETCHED_AT, accountUuid: "<redacted>", utilization: u } };
}

async function snapshotOf(patch?: (u: Record<string, any>) => void) {
  writeFileSync(join(home, ".claude.json"), JSON.stringify(fixture(patch)));
  invalidateUsageCache(); // the read is mtime-gated; a same-millisecond rewrite would be missed
  const snapshot = await readUsageSnapshot();
  assert.ok(snapshot, "the fixture parses");
  return snapshot;
}

const live = await snapshotOf();

// 5h at 8%: three hours in, that pace only runs out on 2026-09-18 ~20:30 UTC, long past
// the 12:00 reset — no projection, and the tile keeps counting down as it always did.
assert.equal(live.fiveHour?.percent, 8);
assert.equal(live.fiveHour?.projectedLimitMs, undefined, "a pace the reset beats projects nothing");

// Week at 84%, started 2026-09-12T13:00Z, read 4d21h later → 100% around 2026-09-18 08:17 UTC.
const week = live.sevenDay?.projectedLimitMs;
assert.ok(week !== undefined, "the weekly window projects");
assert.equal(new Date(Math.floor(week / 1000) * 1000).toISOString(), "2026-09-18T08:17:08.000Z"); // the fraction is ~.43
assert.ok(week < Date.parse(RESET_7D), "kept because it lands before the reset");

// `seven_day_breakdown.window_started_at` is what sets the weekly start: a start a day
// later means the same 84% was burned in less time, so the limit arrives sooner.
const later = (await snapshotOf((u) => (u.seven_day_breakdown.window_started_at = "2026-09-13T13:00:00.738383+00:00"))).sevenDay?.projectedLimitMs;
assert.ok(later !== undefined && later < week, "a later window start projects a nearer limit");
// …and with no breakdown at all the start falls back to reset − 7d, which is what the
// server's own `window_started_at` says here — same answer, different route.
const fallback = (await snapshotOf((u) => delete u.seven_day_breakdown)).sevenDay?.projectedLimitMs;
assert.equal(fallback, week, "no breakdown → reset − 7d");

// The per-model key is untouched: its buckets carry no window start, and the row layout
// has no room for a projection anyway.
assert.equal(live.modelScoped[0]?.label, "Fable");
assert.equal(live.modelScoped[0]?.percent, 100);
assert.equal(live.modelScoped[0]?.projectedLimitMs, undefined, "scoped windows never project");
assert.doesNotMatch(renderUsageIcon({ kind: "model_scoped", snapshot: live, now: NOW }), /limite/, "…and the models tile says nothing about one");

// ── the footer ───────────────────────────────────────────────────────────────
const FOOTER = /<text x="72" y="130"[^>]*fill="(#[0-9a-f]{6})"[^>]*>([^<]*)<\/text>/;

function tile(kind: UsageKind, w: UsageWindow, now = NOW): string {
  const snapshot = { fetchedAtMs: FETCHED_AT, modelScoped: [], [kind === "five_hour" ? "fiveHour" : "sevenDay"]: w };
  return renderUsageIcon({ kind, snapshot, now });
}
function footerOf(kind: UsageKind, w: UsageWindow, now = NOW): [text: string, fill: string] {
  const m = FOOTER.exec(tile(kind, w, now));
  assert.ok(m, "the tile carries a footer line");
  return [m[2], m[1]];
}

// The live snapshot, unprojectable: the countdown the key showed before N5.
assert.deepEqual(footerOf("five_hour", live.fiveHour!), ["resets in 1h58m", "#9ca3af"]);
// The live weekly window, projected — accent colour (orange at 84%), day name because
// the weekly limit routinely lands days out.
assert.deepEqual(footerOf("seven_day", live.sevenDay!), ["limite ~ven 10:15", "#f97316"]);
// Same 5-hour window at a pace that does run out first: 3h in at 75% → 10:59:59 UTC,
// 12:59:59 in Paris, rounded up to the next 5 minutes. No day name on the 5h key.
assert.deepEqual(footerOf("five_hour", { percent: 75, resetsAtMs: Date.parse(RESET_5H), projectedLimitMs: Date.parse("2026-09-17T10:59:59.754Z") }), ["limite ~13:00", "#f97316"]);

// Spent: the number is red and the footer says so outright.
const reset7d = Date.parse(RESET_7D);
assert.deepEqual(footerOf("seven_day", { percent: 100, resetsAtMs: reset7d, projectedLimitMs: FETCHED_AT }), ["limite atteinte", "#ef4444"]);
assert.deepEqual(footerOf("five_hour", { percent: 104, resetsAtMs: Date.parse(RESET_5H), projectedLimitMs: FETCHED_AT }), ["limite atteinte", "#ef4444"]);

// A projection belongs to a window that is still running. Once the reset is behind us the
// reading describes a window that no longer exists, so the tile goes back to saying how old
// it is (amber) rather than forecasting inside a dead window.
assert.deepEqual(footerOf("seven_day", live.sevenDay!, reset7d + 5 * MIN), ["2d old", "#f59e0b"]);

// ── clock formatting ─────────────────────────────────────────────────────────
const FAR_RESET = Date.parse("2026-09-30T00:00:00Z");
const at = (local: string, percent = 20): UsageWindow => ({ percent, resetsAtMs: FAR_RESET, projectedLimitMs: Date.parse(local) });

assert.equal(footerOf("five_hour", at("2026-09-17T14:32:00+02:00"))[0], "limite ~14:30", "rounded down to 5 min");
assert.equal(footerOf("five_hour", at("2026-09-17T14:33:00+02:00"))[0], "limite ~14:35", "rounded up to 5 min");
assert.equal(footerOf("five_hour", at("2026-09-17T09:04:00+02:00"))[0], "limite ~09:05", "hours and minutes zero-padded");
assert.equal(footerOf("seven_day", at("2026-09-18T23:58:00+02:00"))[0], "limite ~sam 00:00", "rounding the instant rolls the day over too");
assert.equal(footerOf("seven_day", at("2026-09-20T06:00:00+02:00"))[0], "limite ~dim 06:00", "French 3-letter day names");
assert.equal(footerOf("seven_day", at("2026-09-21T06:00:00+02:00"))[0], "limite ~lun 06:00");

// The 5-minute rounding is what keeps the SVG dedup in usage-action.ts working: two
// readings whose projections drift by a couple of minutes repaint nothing.
assert.equal(tile("five_hour", at("2026-09-17T14:29:00+02:00")), tile("five_hour", at("2026-09-17T14:31:00+02:00")), "2 min of drift inside a bucket → the same tile");
assert.notEqual(tile("five_hour", at("2026-09-17T14:32:00+02:00")), tile("five_hour", at("2026-09-17T14:33:00+02:00")), "…but crossing a bucket does repaint");

console.log("check-usage-projection: OK");
