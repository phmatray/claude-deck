import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { ANIMATION_FRAMES } from "./icons/index.js";
import { SlotAction } from "./slot-action.js";
import { SetupAction } from "./setup-action.js";
import { watchForReload } from "./reload-watcher.js";
import { createStateTracker } from "./state-tracker.js";
import { renderAll } from "./render-loop.js";
import { wipeAllEventLogs, wipeSessionEventLog } from "./sessions.js";
import { killSession } from "./kill-session.js";
import { checkHooks, HOOK_FIX_HINT } from "./hook-check.js";
import {
  UsageModelsAction,
  UsageSessionAction,
  UsageWeekAction,
} from "./usage-action.js";
import { invalidateUsageCache, readUsageSnapshot } from "./usage.js";
import { refreshUsageCache, type UsageRefreshResult } from "./usage-refresh.js";
import { LauncherAction } from "./launcher/launcher-action.js";
import {
  AskBackAction,
  AskContextAction,
  AskDetailAction,
  AskHeaderAction,
  AskOptionAction,
  AskQueueAction,
  AskTerminalAction,
} from "./ask/actions.js";
import { ask, pendingQuestion, startAsk } from "./ask/ask.js";
import { focusSession } from "./warp-focus.js";

streamDeck.logger.setLevel(LogLevel.DEBUG);

const POLL_MS = 1000;
const ANIMATION_MS = 120;

const tracker = createStateTracker(pendingQuestion);
let frame = 0;
let slowTickRunning = false;

async function runSlowTick(): Promise<void> {
  if (slowTickRunning) return;
  slowTickRunning = true;
  try {
    const entries = await tracker.tick(slotAction.orderedActions().length);
    await renderAll(slotAction, entries, frame);
    await renderUsage();
    // Detached on purpose: the refresh spawns a ~3s child, and awaiting it here
    // would hold `slowTickRunning` for that long, freezing every session key.
    // refreshUsageCache() throttles itself on the snapshot's age, so calling
    // this every second costs a comparison in the overwhelming majority of
    // ticks.
    void runUsageRefresh().catch((err) => streamDeck.logger.error("usage refresh failed", err));
  } catch (err) {
    streamDeck.logger.error("tick failed", err);
  } finally {
    slowTickRunning = false;
  }
}

async function refreshNow() {
  const result = await wipeAllEventLogs();
  if (result.errors.length) {
    streamDeck.logger.warn(`wipeAllEventLogs errors: ${result.errors.join("; ")}`);
  }
  // Force a re-poll + re-render so the user sees the wipe take effect immediately.
  // If a tick is already in flight, the regular interval picks up the change in <1s.
  await runSlowTick();
  return result;
}

async function resetSlot(sessionId: string): Promise<void> {
  const r = await wipeSessionEventLog(sessionId);
  if (!r.wiped) {
    streamDeck.logger.warn(`wipeSessionEventLog(${sessionId}) failed: ${r.error}`);
    throw new Error(r.error ?? "wipe failed");
  }
  await runSlowTick();
}

async function killSlot(pid: number, sessionId: string): Promise<void> {
  streamDeck.logger.info(`kill requested for ${sessionId} pid=${pid}`);
  killSession(pid);
  // Refresh : l'agent passera "finished" puis disparaîtra au tick suivant.
  await runSlowTick();
}

/** Pushes the current usage snapshot onto whichever usage keys are on the
 *  deck. Reading is mtime-gated in usage.ts, so calling this every tick costs
 *  a stat() in the common case. */
async function renderUsage(): Promise<void> {
  if (!usageActions.some((a) => a.hasInstances())) return;
  const snapshot = await readUsageSnapshot();
  await Promise.all(usageActions.map((a) => a.render(snapshot)));
}

/** Key press on any usage key: pull a fresh snapshot if the one we have is old
 *  enough for Claude Code to replace it, then re-read and repaint all three.
 *
 *  Forced, so the press is not held off by the tick's own attempt throttle —
 *  see refreshUsageCache(). The outcome travels back to the action, which is
 *  the only place that can acknowledge the press on the key itself. */
async function refreshUsage(): Promise<UsageRefreshResult> {
  const result = await runUsageRefresh({ force: true });
  invalidateUsageCache();
  await renderUsage();
  return result;
}

/** Asks Claude Code to refetch its usage snapshot, but only when a usage key is
 *  actually on the deck — this spawns a process, and users who never placed one
 *  should never pay for it.
 *
 *  Driven from the slow tick rather than its own interval: action instances are
 *  populated by `willAppear`, which arrives after `connect()` resolves, so any
 *  check made at startup would read an empty list and skip. */
async function runUsageRefresh(opts: { force?: boolean } = {}): Promise<UsageRefreshResult> {
  // "Nothing to fetch", not "the fetch broke" — this runs off the tick every
  // second, and calling that a failure would be a lie about the overwhelming
  // majority of callers.
  if (!usageActions.some((a) => a.hasInstances())) return "current";
  // refreshUsageCache() leaves the freshly-parsed snapshot in usage.ts's cache,
  // so renderUsage() picks it up without another invalidation.
  const result = await refreshUsageCache(opts);
  if (result === "refreshed") await renderUsage();
  return result;
}

const slotAction = new SlotAction(resetSlot, killSlot, (sessionId, device) => ask.showSession(sessionId, device));
const setupAction = new SetupAction(refreshNow);

const usageActions = [
  new UsageSessionAction(refreshUsage),
  new UsageWeekAction(refreshUsage),
  new UsageModelsAction(refreshUsage),
];

const askKeys = {
  // The session as the dashboard names it; the badge is all that tells apart two sessions in one repo.
  context: new AskContextAction((sessionId) => {
    const s = tracker.findSession(sessionId);
    return s?.badge ? `${s.label}-${s.badge}` : s?.label;
  }),
  header: new AskHeaderAction(),
  option: new AskOptionAction(),
  queue: new AskQueueAction(),
  back: new AskBackAction(),
  terminal: new AskTerminalAction(),
  detail: new AskDetailAction(),
};

// Every manifest action, in manifest order. Keep this list and the manifest's
// Actions in lockstep: registerAction throws on a UUID the manifest lacks.
for (const a of [
  slotAction,
  setupAction,
  ...usageActions,
  new LauncherAction(),
  askKeys.context,
  askKeys.header,
  askKeys.detail,
  askKeys.option,
  askKeys.queue,
  askKeys.back,
  askKeys.terminal,
]) {
  streamDeck.actions.registerAction(a);
}
await streamDeck.connect();

startAsk(
  () => {
    for (const key of Object.values(askKeys)) void key.repaint();
  },
  // The Terminal key: the session's own terminal when the dashboard knows it,
  // else the directory claude-ask ran in.
  (question) => {
    const s = question.sessionId ? tracker.findSession(question.sessionId) : undefined;
    const target = s ? { cwd: s.cwd, warpSession: s.warpSession, termProgram: s.termProgram } : question.cwd ? { cwd: question.cwd } : undefined;
    if (!target) return;
    void focusSession(target)
      .then((res) => streamDeck.logger.info(`ask: focus ${res.reason} for cwd=${target.cwd}`))
      .catch((err) => streamDeck.logger.warn(`ask: focus failed: ${err instanceof Error ? err.message : String(err)}`));
  },
);

watchForReload({ pollMs: POLL_MS });

setInterval(runSlowTick, POLL_MS);

let animateRunning = false;
setInterval(async () => {
  if (animateRunning) return;
  animateRunning = true;
  frame = (frame + 1) % ANIMATION_FRAMES;
  // Skip render if nothing on screen needs to change frame-to-frame
  // (no animated motif AND no pulsing in-progress todo — labels are static).
  if (!tracker.needsAnimation() && !slotAction.anyKillArming()) {
    animateRunning = false;
    return;
  }
  try {
    await renderAll(slotAction, tracker.getEntries(), frame);
  } catch (err) {
    streamDeck.logger.error("animation render failed", err);
  } finally {
    animateRunning = false;
  }
}, ANIMATION_MS);

streamDeck.logger.info(`claude-deck plugin started, polling=${POLL_MS}ms anim=${ANIMATION_MS}ms`);

// Surface stale/missing hook registration loudly — otherwise the plugin runs
// fine but renders wrong icons (e.g. a permission padlock that never clears
// because PostToolUse isn't catch-all). The Setup key also badges this.
checkHooks().then(({ ok, problems, warnings }) => {
  if (!ok) {
    streamDeck.logger.warn(`hook config check failed — ${HOOK_FIX_HINT}\n  ${problems.join("\n  ")}`);
  }
  for (const w of warnings) streamDeck.logger.warn(`hook config: ${w}`);
}).catch((err) => {
  streamDeck.logger.warn(`hook config check threw: ${err instanceof Error ? err.message : String(err)}`);
});
