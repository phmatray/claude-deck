import streamDeck from "@elgato/streamdeck";
import { mkdir } from "node:fs/promises";
import { envWithCliPath, USAGE_REFRESH_DIR } from "./env.js";
import { spawnCapture } from "./spawn-capture.js";
import { invalidateUsageCache, readUsageSnapshot } from "./usage.js";

/**
 * Keeps `~/.claude.json` → `cachedUsageUtilization` fresh.
 *
 * Claude Code only refetches its usage snapshot when something asks to *see*
 * it (startup, `/usage`, the status line, a limit warning). Sessions driven
 * through an SDK/GUI front-end hit none of those, so the cache can sit
 * untouched for hours while usage keeps accruing — measured at 25+ minutes of
 * continuous work with no refresh at all.
 *
 * So we ask for it: `claude -p "/usage"` runs the slash command locally (no
 * model turn, ~3s) and writes the refreshed snapshot back to the config blob,
 * which `usage.ts` then reads. That keeps the plugin off the undocumented
 * `/api/oauth/usage` endpoint and away from the OAuth token in the Keychain
 * altogether.
 *
 * The one cost is a transient session file, which the CLI writes as
 * `kind:"interactive"` like any other. Running in USAGE_REFRESH_DIR is what
 * lets `sessions.ts` drop it instead of flashing a slot on the deck.
 */

/** Claude Code refuses to rewrite the snapshot while it is under 5 minutes old,
 *  so asking below that can only waste the ~3s the child costs. The margin on
 *  top keeps us clear of the floor: landing exactly on it would no-op, and
 *  because a no-op is indistinguishable from a real refresh at the call site,
 *  it would also make the staleness check below fire spurious warnings. */
const CC_WRITE_FLOOR_MS = 5 * 60 * 1000;
const REFRESH_WHEN_OLDER_THAN_MS = CC_WRITE_FLOOR_MS + 30_000;
/** `claude -p "/usage"` measured at ~3s; well clear of that, and bounded so a
 *  wedged child can never pile up behind the tick. */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * What an attempt actually accomplished. The tick only acts on `"refreshed"`,
 * but a key press needs all three: "nothing left to fetch" and "the fetch
 * broke" have to look different on the key, or a press that could not possibly
 * help is indistinguishable from one that silently failed.
 */
export type UsageRefreshResult = "refreshed" | "current" | "failed";

/** The attempt currently in flight, if any. A promise rather than a boolean:
 *  a caller arriving on top of one needs that attempt's actual verdict, not a
 *  guess about it — see refreshUsageCache(). */
let inFlight: Promise<UsageRefreshResult> | undefined;
/** When we last actually spawned. The snapshot's own age cannot carry this on
 *  its own: if there is no snapshot at all, or the child leaves it untouched,
 *  the age gate never closes and the tick would relaunch the moment the last
 *  child exited — a spawn every ~3s, forever, and silently, since warnOnce()
 *  only speaks the first time. */
let lastAttemptMs = 0;
/** Only warn once per failure reason — this is driven off the tick, and a
 *  missing `claude` on PATH would otherwise fill the log. */
let lastFailure = "";

function warnOnce(message: string): void {
  if (message === lastFailure) return;
  lastFailure = message;
  streamDeck.logger.warn(message);
}

/**
 * Refreshes the snapshot unless one is already in flight or what we have is
 * still fresh. Resolves `"refreshed"` only when `fetchedAtMs` actually moved,
 * so the caller knows there is something new to draw.
 *
 * `force` is the key press. It skips the `lastAttemptMs` bookkeeping gate but
 * NOT the snapshot-age check, and that distinction is the whole point. The tick
 * runs every second, so it claims the attempt slot within ~1s of the snapshot
 * ageing past the threshold — which leaves a human press a sub-second window to
 * land in, i.e. none. Dropping the bookkeeping gate makes the press do
 * something exactly when the user reaches for it: after a failed or wedged
 * refresh, where the tick would otherwise sit out the next 5m30s and the key
 * would keep showing a frozen number. Keeping the age check means a press can
 * never spawn a child that Claude Code would refuse to honour anyway — under
 * its rewrite floor the reading on the key already is the freshest obtainable
 * one, so `"current"` is the honest answer, not a failure.
 *
 * A caller arriving while an attempt is in flight is handed that attempt's own
 * promise, so it reports what actually happened instead of assuming success.
 *
 * Reads the "before" value itself rather than taking it as an argument: the
 * comparison below is only meaningful against what is genuinely on disk at
 * spawn time, and a caller passing a value it read earlier would quietly break
 * it. `readUsageSnapshot()` is mtime-gated, so this costs a stat().
 */
export async function refreshUsageCache({ force = false } = {}): Promise<UsageRefreshResult> {
  // An attempt already in flight answers this call too. Reporting "current"
  // here instead would be a guess about something that has not finished, and
  // when that attempt fails the guess is wrong in the one direction that
  // matters: a key press acknowledged with a tick, over a number that never
  // moved. Handing back the same promise also keeps two children from
  // overlapping, which is all the old boolean guard did.
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastAttemptMs < REFRESH_WHEN_OLDER_THAN_MS) return "current";
  // Assigned before the first await, not after: the tick and a key press can
  // both arrive inside one turn of the event loop, and a gap here would let
  // both through and spawn two children.
  inFlight = attemptRefresh();
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

/** The attempt itself. Split out so `refreshUsageCache()` can publish the
 *  promise before awaiting it. */
async function attemptRefresh(): Promise<UsageRefreshResult> {
  try {
    const before = (await readUsageSnapshot())?.fetchedAtMs;
    if (before !== undefined && Date.now() - before < REFRESH_WHEN_OLDER_THAN_MS) {
      return "current";
    }
    // Nothing to age-check against — an API-key-only install, or a config that
    // has never carried a snapshot. The gate above can never close there, so a
    // forced press would spawn a child on *every* press, and warnOnce would
    // stay silent after the first. The attempt throttle is the only bound left,
    // so the forced path honours it here and only here — a genuinely stale
    // snapshot still forces straight through, which is the case a user
    // actually presses for.
    if (before === undefined && Date.now() - lastAttemptMs < REFRESH_WHEN_OLDER_THAN_MS) {
      return "failed";
    }
    lastAttemptMs = Date.now();
    await mkdir(USAGE_REFRESH_DIR, { recursive: true });
    let r = await spawnCapture("claude", ["-p", "/usage"], {
      cwd: USAGE_REFRESH_DIR,
      timeoutMs: SPAWN_TIMEOUT_MS,
      env: envWithCliPath(),
    });
    // CLI_DIRS covers the standard install locations, but not a `claude` that
    // npm put under a node version manager (mise, nvm, fnm, volta): those bin
    // directories are version-scoped and unguessable. The user's own shell
    // knows where it is, so ask it. Reached only when the direct spawn found
    // nothing at all, so it can turn a certain failure into a possible success
    // and nothing else.
    //
    // `-i` is not decoration. zsh sources `.zshrc` only for *interactive*
    // shells, and `.zshrc` is where a PATH export overwhelmingly lives — `-lc`
    // alone reads just `.zshenv`/`.zprofile` and was measured returning
    // "not found" on a machine where `-ilc` resolves the binary fine. bash
    // splits the same way (`.bashrc` interactive, `.bash_profile` login), so
    // both flags earn their place. The cost is the rc's own startup, ~2.9s
    // here, paid only on a path that is otherwise a guaranteed failure and
    // bounded by SPAWN_TIMEOUT_MS like any other child.
    const notOnPath = r.err?.includes("ENOENT") === true;
    if (notOnPath) {
      r = await spawnCapture(process.env.SHELL ?? "/bin/sh", ["-ilc", 'claude -p "/usage"'], {
        cwd: USAGE_REFRESH_DIR,
        timeoutMs: SPAWN_TIMEOUT_MS,
        env: envWithCliPath(),
      });
    }
    if (r.code === 0 && !r.timedOut) {
      // Exit 0 is not proof of a refresh: `claude -p "/usage"` returns 0 even
      // when it never reaches the API (observed with a stripped environment —
      // "Total duration (API): 0s", snapshot untouched). Since we only get here
      // when the snapshot is past Claude Code's rewrite floor, a fetchedAtMs
      // that hasn't moved means the refresh did not happen, and the keys would
      // otherwise sit on a frozen number with nothing in the log.
      invalidateUsageCache();
      const after = (await readUsageSnapshot())?.fetchedAtMs;
      if (after === undefined || after === before) {
        warnOnce('claude -p "/usage" exited 0 but left the usage snapshot untouched — keys are showing a stale reading');
        return "failed";
      }
      lastFailure = "";
      return "refreshed";
    }
    // A missing binary gets its own hint. It is the one failure the user can
    // act on, and the reason is never obvious: the plugin's PATH is launchd's,
    // not the one their terminal shows them. Keyed off the *direct* spawn,
    // because the fallback reports a shell that ran fine and found nothing
    // (exit 127), not an ENOENT of its own.
    const hint = notOnPath
      ? " — `claude` is not on the plugin's PATH and the login-shell fallback did not find it either; the Stream Deck app inherits launchd's environment, not your shell's"
      : " — keys will keep showing the last snapshot";
    warnOnce(`usage refresh failed (${r.err ?? (r.timedOut ? "timed out" : `exit ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`)})${hint}`);
    return "failed";
  } catch (err) {
    warnOnce(`usage refresh threw: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}
