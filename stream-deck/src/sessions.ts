import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import type { SessionState } from "./icons/index.js";
import { isUsageRefreshCwd, SESSIONS_DIR } from "./env.js";
import { pruneGitCache, readGitInfo } from "./git-info.js";
import { parseEventLog, reduceEvents, type DerivedState, type TodoStatus } from "./session-events.js";

/** Surface readdir errors to the polling loop so it can log them once. */
export let lastReadError: string | undefined;

/** Cache of derived state per event-log path. Re-reading + reducing the NDJSON
 *  every tick is wasteful since the log only grows when a hook fires; gate it
 *  on (mtimeMs, size) so unchanged logs short-circuit. Keyed by full path. */
interface EventLogCacheEntry {
  mtimeMs: number;
  size: number;
  derived: DerivedState;
  lastEventTs: number;
}
const eventLogCache = new Map<string, EventLogCacheEntry>();

/** Cache of parsed <pid>.json keyed by full path, gated on (mtimeMs, size) so a
 *  session file unchanged since last tick skips the readFile + JSON.parse — an
 *  idle session doesn't rewrite its json. Only validated sessions are cached. */
interface JsonCacheEntry {
  mtimeMs: number;
  size: number;
  raw: RawSession;
}
const jsonCache = new Map<string, JsonCacheEntry>();

interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status?: string;
  updatedAt?: number;
  name?: string;
  /** "derived" when Claude Code generated `name` itself from the cwd. Absent on
   *  older CC builds and on names the user pinned explicitly. */
  nameSource?: string;
  /** "interactive" | "bg" (Claude Code 2.1.x). Absent sur les anciennes versions. */
  kind?: string;
  /** Pour les bg en attente : ex. "permission prompt". */
  waitingFor?: string;
}

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Top line on the key: the json's `name` when the user pinned one, else the
   *  repo name. */
  label: string;
  /** Repo name from git plumbing; falls back to basename(cwd) outside a repo. */
  repo: string;
  /** Current branch, or a short SHA when HEAD is detached. undefined when the
   *  cwd isn't in a repo this process can reach. */
  branch?: string;
  /** Short disambiguator lifted from Claude Code's derived name (`…-b7`). Two
   *  sessions sharing one worktree differ by nothing else, so it survives as a
   *  corner badge even though it says nothing on its own. */
  badge?: string;
  startedAt: number;
  rawStatus: "busy" | "idle";
  /** Awaiting a generic input notification from the user (elicitation_dialog,
   *  or any in-turn Notification with no/unknown notifType). */
  awaiting: boolean;
  /** Awaiting tool-permission approval (Notification[permission_prompt]). */
  awaitingPermission: boolean;
  /** Awaiting answer to an AskUserQuestion UI prompt (PreToolUse fired but no
   *  matching PostToolUse yet). */
  awaitingQuestion: boolean;
  /** Awaiting plan approval (ExitPlanMode tool used). */
  awaitingPlan: boolean;
  /** Last turn ended with StopFailure and no UserPromptSubmit since. */
  errored: boolean;
  /** At least one subagent currently running. */
  subagentActive: boolean;
  /** Event-log's own busy projection (in-turn). Fallback for `rawStatus`. */
  busy: boolean;
  /** Snapshot of the last TodoWrite call's statuses; empty if none seen. */
  todos: TodoStatus[];
  /** Warp pane uuid the CLI runs in (from the hook env), if any. */
  warpSession?: string;
  /** `TERM_PROGRAM` of the CLI's terminal, if the hook saw one. */
  termProgram?: string;
  /** "interactive" par défaut si le json n'a pas de champ `kind`. */
  kind: "interactive" | "bg";
  /** Statut brut NON coercé du json pour les bg (ex. "waiting", "running"). undefined pour interactive ; à ne pas confondre avec rawStatus (coercé "busy"|"idle", inutilisé pour les bg). */
  bgStatus?: string;
  /** `waitingFor` du json pour les bg (ex. "permission prompt"). */
  bgWaitingFor?: string;
  /** mtime logique du json (ms) si le json l'expose. Utilisé pour la liveness des bg (fraîcheur). */
  updatedAt?: number;
  /** Sort key for the display: ts of the newest hook event, falling back to
   *  `startedAt` when the session has no event log yet. Most-recent-first
   *  ordering is what keeps the session you're actually working in on slot 1
   *  when there are more live sessions than keys on the deck. */
  lastActivityAt: number;
}

const isPositiveInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x > 0;

/** Pulls the `-b7` tail off a Claude-Code-derived name (`<cwd basename>-<suffix>`).
 *  Deliberately strict: on any other shape we return undefined (no badge) rather
 *  than guessing at the last `-` segment, which on a plain `streamdeck-claude`
 *  would put the word "claude" in the corner — the exact kind of meaningless
 *  fragment this whole layout exists to get rid of. */
function derivedSuffix(name: string, cwdBase: string): string | undefined {
  if (!cwdBase || !name.startsWith(`${cwdBase}-`)) return undefined;
  const tail = name.slice(cwdBase.length + 1);
  return /^[a-z0-9]{1,4}$/i.test(tail) ? tail : undefined;
}

async function readSessionFiles(): Promise<SessionInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch (err) {
    lastReadError = err instanceof Error ? err.message : String(err);
    return [];
  }
  const out: SessionInfo[] = [];
  await Promise.all(
    entries
      .filter((f) => /^\d+\.json$/.test(f))
      .map(async (f) => {
        const path = join(SESSIONS_DIR, f);
        let raw: RawSession;
        try {
          const st = await stat(path);
          const cached = jsonCache.get(path);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            raw = cached.raw;
          } else {
            const parsed = JSON.parse(await readFile(path, "utf8")) as RawSession;
            if (!isPositiveInt(parsed.pid) || typeof parsed.sessionId !== "string" || typeof parsed.cwd !== "string") {
              return;
            }
            jsonCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, raw: parsed });
            raw = parsed;
          }
        } catch {
          return;
        }
        // The `claude -p "/usage"` refresher writes a session file like any
        // other CLI session. It lives for ~3s and would sort to the top of the
        // non-attention group (its lastActivityAt is "now"), shoving every
        // other key down a slot. Its dedicated cwd is how we recognise it.
        if (isUsageRefreshCwd(raw.cwd)) return;

        const status = raw.status === "busy" ? "busy" : "idle";
        const kind: "interactive" | "bg" = raw.kind === "bg" ? "bg" : "interactive";

        let derived: DerivedState = {
          awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [], busy: false,
        };
        let lastEventTs = 0;
        // Un agent bg tourne en headless et ne nourrit pas le pipeline de hooks :
        // son json (status/waitingFor) est la source de vérité. On saute donc
        // entièrement la lecture/réduction de l'event-log pour les bg.
        if (kind !== "bg") {
          const eventsPath = join(SESSIONS_DIR, `${raw.sessionId}.events.ndjson`);
          try {
            const st = await stat(eventsPath);
            const cached = eventLogCache.get(eventsPath);
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
              derived = cached.derived;
              lastEventTs = cached.lastEventTs;
            } else {
              // Keep the parsed array: the reducer folds it away, but its last
              // entry is the recency the display sorts on.
              const events = parseEventLog(await readFile(eventsPath, "utf8"));
              derived = reduceEvents(events);
              lastEventTs = events.at(-1)?.ts ?? 0;
              eventLogCache.set(eventsPath, { mtimeMs: st.mtimeMs, size: st.size, derived, lastEventTs });
            }
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT") {
              streamDeck.logger.warn(
                `event-log read failed ${raw.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // no event log yet (ENOENT) — defaults are fine; don't cache
          }
        }

        // Display identity. Claude Code's own derived name is `<cwd basename>-<suffix>`,
        // which the icon used to split into meaningless fragments ("streamdeck",
        // "claude", "b7"); repo + branch says the same thing legibly, and the
        // suffix is demoted to a badge. A name the user pinned still wins.
        const cwdBase = basename(raw.cwd);
        const rawName = raw.name?.trim();
        const suffix = rawName ? derivedSuffix(rawName, cwdBase) : undefined;
        // `nameSource` only exists from CC 2.1.x on; older builds get the same
        // treatment when the name still has the derived shape.
        const isDerived = raw.nameSource === "derived" || (raw.nameSource === undefined && suffix !== undefined);
        const gitInfo = await readGitInfo(raw.cwd);
        const repo = gitInfo.repo || cwdBase;
        const label = !isDerived && rawName ? rawName : repo;
        const badge = isDerived ? suffix : undefined;

        const startedAt = typeof raw.startedAt === "number" ? raw.startedAt : 0;
        // A bg agent never fires a hook, so its only freshness signal is the
        // json's own updatedAt; everyone else rides the event log.
        const lastActivityAt = kind === "bg"
          ? (typeof raw.updatedAt === "number" ? raw.updatedAt : startedAt)
          : (lastEventTs || startedAt);

        out.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          label,
          repo,
          branch: gitInfo.branch,
          badge,
          startedAt,
          lastActivityAt,
          rawStatus: status,
          kind,
          bgStatus: kind === "bg" ? raw.status : undefined,
          bgWaitingFor: kind === "bg" ? raw.waitingFor : undefined,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
          awaiting: derived.awaiting,
          awaitingPermission: derived.awaitingPermission,
          awaitingQuestion: derived.awaitingQuestion,
          awaitingPlan: derived.awaitingPlan,
          errored: derived.errored,
          subagentActive: derived.subagentDepth > 0,
          busy: derived.busy,
          todos: derived.todos,
          warpSession: derived.warpSession,
          termProgram: derived.termProgram,
        });
      }),
  );
  return out;
}

/** Reads every <pid>.json in SESSIONS_DIR. Stale (dead-pid) files are still
 *  returned; liveness filtering happens upstream. */
export async function readAllSessions(): Promise<SessionInfo[]> {
  lastReadError = undefined;
  const sessions = await readSessionFiles();
  // Prune cache entries whose session is gone (SessionEnd unlinked the log, or
  // the .json disappeared) so the maps stay bounded by live-session count.
  const expectedLogs = new Set<string>();
  const expectedJson = new Set<string>();
  for (const s of sessions) {
    expectedLogs.add(join(SESSIONS_DIR, `${s.sessionId}.events.ndjson`));
    expectedJson.add(join(SESSIONS_DIR, `${s.pid}.json`));
  }
  for (const key of eventLogCache.keys()) {
    if (!expectedLogs.has(key)) eventLogCache.delete(key);
  }
  for (const key of jsonCache.keys()) {
    if (!expectedJson.has(key)) jsonCache.delete(key);
  }
  await pruneGitCache(sessions.map((s) => s.cwd));
  return sessions;
}

/** Grace before a confirmed-dead session's <pid>.json is deleted. A dead file
 *  never changes yet pre-prune was re-stat'd every tick; we wait
 *  this long past the last write so we never race a session that just dropped its
 *  json but whose first liveness probe flaked (or one shown briefly as finished). */
const PRUNE_GRACE_MS = 60_000;

/** Deletes the on-disk <pid>.json (and its now-orphan <sid>.events.ndjson) for
 *  every interactive session whose process is no longer live and whose file is
 *  older than PRUNE_GRACE_MS, bounding `~/.claude/sessions/` to live + just-died
 *  sessions instead of letting dead files pile up unread-but-re-stat'd forever.
 *  bg sessions are skipped: their PID is a shared daemon, so the file↔process
 *  mapping the rest of this assumes doesn't hold. Best-effort — every unlink
 *  error is swallowed and simply retried next tick. Returns the count removed. */
export async function pruneDeadSessions(
  sessions: SessionInfo[],
  liveIds: Set<string>,
  now: number,
): Promise<number> {
  let pruned = 0;
  await Promise.all(
    sessions
      .filter((s) => s.kind !== "bg" && !liveIds.has(s.sessionId))
      .map(async (s) => {
        const jsonPath = join(SESSIONS_DIR, `${s.pid}.json`);
        try {
          const st = await stat(jsonPath);
          if (now - st.mtimeMs < PRUNE_GRACE_MS) return; // too fresh to be sure it's dead junk
        } catch {
          return; // already gone or unreadable
        }
        try {
          await unlink(jsonPath);
          pruned++;
        } catch {
          return; // lost a race / no permission — leave the orphan log, retry next tick
        }
        const eventsPath = join(SESSIONS_DIR, `${s.sessionId}.events.ndjson`);
        try {
          await unlink(eventsPath);
        } catch {
          /* ENOENT or already gone — fine */
        }
        jsonCache.delete(jsonPath);
        eventLogCache.delete(eventsPath);
      }),
  );
  return pruned;
}

/** Unlinks one `<sid>.events.ndjson`. Idempotent (ENOENT counts as success) so
 *  a long-press reset on a slot whose agent hasn't emitted anything yet still
 *  feels like it "worked". */
export async function wipeSessionEventLog(sessionId: string): Promise<{ wiped: boolean; error?: string }> {
  try {
    await unlink(join(SESSIONS_DIR, `${sessionId}.events.ndjson`));
    return { wiped: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { wiped: true };
    return { wiped: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Unlinks every `<sid>.events.ndjson` in SESSIONS_DIR. Safe to call any time:
 *  hooks just recreate the files on the next event. Used by the Setup action to
 *  force every slot back to a clean idle state. */
export async function wipeAllEventLogs(): Promise<{ wiped: number; errors: string[] }> {
  let wiped = 0;
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch (err) {
    return { wiped, errors: [err instanceof Error ? err.message : String(err)] };
  }
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".events.ndjson"))
      .map(async (f) => {
        try {
          await unlink(join(SESSIONS_DIR, f));
          wiped++;
        } catch (err) {
          errors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
  );
  return { wiped, errors };
}

/** State for the icon, derived from session status + event-log projection + liveness.
 *  Priority: finished > error > awaiting_plan > awaiting_permission >
 *  awaiting_question > awaiting > subagent > working > idle. Plan approval ranks
 *  first among "needs you" states because users can sit on it longest; the more
 *  specific flags (permission, question) win over the generic catch-all so the
 *  distinct icon shows up. All awaiting* flags win over busy since CC keeps the
 *  session marked busy while waiting — the event log is the source of truth for
 *  "needs input." Spurious idle-reminder Notifications fired after Stop are
 *  already filtered upstream in reduceEvents via its `busy` guard. */
export function deriveState(s: SessionInfo, alive: boolean): SessionState {
  if (!alive) return "finished";
  if (s.kind === "bg") return deriveBgState(s);
  if (s.errored) return "error";
  if (s.awaitingPlan) return "awaiting_plan";
  if (s.awaitingPermission) return "awaiting_permission";
  if (s.awaitingQuestion) return "awaiting_question";
  if (s.awaiting) return "awaiting";
  // `status` is absent from <pid>.json on some entrypoints (observed on
  // `entrypoint: "sdk-ts"`, i.e. every SDK/ACP-hosted session), which would pin
  // those to "idle" for their whole lifetime. The event log's own in-turn
  // projection covers that gap without changing behaviour where status exists.
  const busy = s.rawStatus === "busy" || s.busy;
  if (busy && s.subagentActive) return "subagent";
  if (busy) return "working";
  return "idle";
}

/** Mappe le json d'un agent bg vers un état bg_*. Table best-effort (un seul
 *  échantillon connu : status="waiting"/waitingFor="permission prompt") ; tout
 *  statut non-terminal inconnu retombe sur bg_idle. Les statuts terminaux sont
 *  déjà filtrés en amont par la liveness (→ finished/retiré), donc absents ici. */
function deriveBgState(s: SessionInfo): SessionState {
  const waitingFor = (s.bgWaitingFor ?? "").toLowerCase();
  if (waitingFor.includes("permission")) return "bg_awaiting_permission";
  const status = (s.bgStatus ?? "").toLowerCase();
  if (status === "waiting") return "bg_awaiting";
  if (status === "busy" || status === "running") return "bg_working";
  return "bg_idle";
}
