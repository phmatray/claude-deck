import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "../live-pids.js";

/**
 * The plugin half of the `claude-ask` file protocol: every pending question is its
 * own `questions/<id>.json` (written by the CLI, tmp + rename), every answer its own
 * `answers/<id>.json` (written here, same way). No lock: any number of sessions ask
 * at once and this keeps them in arrival order. SDK-free, so a check can drive it.
 */

export type QuestionKind = "ask" | "permission" | "plan";

export interface AskOption {
  id: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  kind: QuestionKind;
  /** Claude Code session asking; null when claude-ask couldn't tell. */
  sessionId: string | null;
  /** The waiting claude-ask process. */
  pid: number;
  cwd?: string;
  context?: string;
  header?: string;
  detail?: string;
  question?: string;
  options: AskOption[];
  createdAt: string;
  expiresAt?: string;
}

/** fs.watch drops events (and misses a directory created after it started), so a
 *  poll backs it up; it is also what notices dead pids and expired questions. */
const POLL_MS = 500;
/** claude-ask gives up at `expiresAt` by itself; the grace only covers a slow exit. */
const EXPIRY_GRACE_MS = 5_000;
/** The single-question protocol before 3.0. A pre-3.0 claude-ask left alive keeps
 *  polling answer.json forever, so its files are only noise now. */
const LEGACY_FILES = ["question.json", "answer.json", "lock"];
const KINDS: ReadonlySet<string> = new Set<QuestionKind>(["ask", "permission", "plan"]);

const isText = (v: unknown): v is string => typeof v === "string";
const textOr = (v: unknown): boolean => v === undefined || isText(v);
const isDate = (v: unknown): boolean => isText(v) && !Number.isNaN(Date.parse(v));

/** Question files are untrusted input painted onto the keys: anything that isn't
 *  the shape claude-ask writes is dropped, never half-rendered. */
export function parseQuestion(raw: unknown, id: string): Question | null {
  if (typeof raw !== "object" || raw === null) return null;
  const q = raw as Record<string, unknown>;
  const options = q.options;
  const ok =
    q.id === id &&
    KINDS.has(q.kind as string) &&
    (q.sessionId === null || isText(q.sessionId)) &&
    Number.isInteger(q.pid) && (q.pid as number) > 0 &&
    ["cwd", "context", "header", "detail", "question"].every((k) => textOr(q[k])) &&
    Array.isArray(options) && options.length > 0 &&
    options.every((o) => typeof o === "object" && o !== null && isText(o.id) && isText(o.label) && textOr(o.description)) &&
    isDate(q.createdAt) &&
    (q.expiresAt === undefined || isDate(q.expiresAt));
  return ok ? (q as unknown as Question) : null;
}

export interface AskQueue {
  /** Live questions, oldest first. */
  pending(): Question[];
  /** The oldest live question of a session. */
  bySession(sessionId: string): Question | undefined;
  /** Called whenever the set of pending questions changes. */
  onChange(cb: () => void): void;
  /** Writes the answer for option `index`; the question leaves `pending()` at once. */
  answer(id: string, index: number): void;
  /** Writes a cancelled answer ("Terminal"): claude-ask exits 2 and the caller asks in the terminal. */
  cancel(id: string): void;
  /** Re-reads the directory now (the poll does it every POLL_MS). */
  refresh(): void;
  start(): void;
  stop(): void;
}

export function createQueue(dir: string, log: (msg: string) => void): AskQueue {
  const questionsDir = join(dir, "questions");
  const answersDir = join(dir, "answers");
  /** Parsed files by name. A question file never changes after its rename, so each
   *  is read once; null marks a malformed one (logged once, skipped after). */
  const parsed = new Map<string, Question | null>();
  /** Answered here but not yet removed by claude-ask (it polls every 150 ms). */
  const answered = new Set<string>();
  const listeners: (() => void)[] = [];
  let list: Question[] = [];
  let listKey = "";
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  function publish(next: Question[]): void {
    list = next;
    const key = next.map((q) => q.id).join("\n");
    if (key === listKey) return;
    listKey = key;
    for (const cb of listeners) cb();
  }

  function refresh(): void {
    let names: string[] = [];
    try {
      names = readdirSync(questionsDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`ask: cannot list ${questionsDir}: ${String(err)}`);
    }
    const present = new Set(names);
    for (const name of parsed.keys()) if (!present.has(name)) parsed.delete(name);
    for (const id of answered) if (!present.has(`${id}.json`)) answered.delete(id);

    const now = Date.now();
    const next: Question[] = [];
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      if (!parsed.has(name)) {
        try {
          const q = parseQuestion(JSON.parse(readFileSync(join(questionsDir, name), "utf8")), id);
          if (!q) log(`ask: ignoring malformed question ${name}`);
          parsed.set(name, q);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // removed since the listing
          log(`ask: ignoring unreadable question ${name}: ${err instanceof Error ? err.message : String(err)}`);
          parsed.set(name, null);
        }
      }
      const q = parsed.get(name);
      if (!q || answered.has(id) || !isPidAlive(q.pid)) continue;
      if (q.expiresAt && Date.parse(q.expiresAt) + EXPIRY_GRACE_MS < now) continue;
      next.push(q);
    }
    next.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    publish(next);
  }

  function writeAnswer(id: string, body: object): void {
    mkdirSync(answersDir, { recursive: true });
    const tmp = join(answersDir, `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify({ id, ...body, answeredAt: new Date().toISOString() }));
    renameSync(tmp, join(answersDir, `${id}.json`));
    answered.add(id);
    publish(list.filter((q) => q.id !== id));
  }

  /** Removes the old protocol's files, and answers nobody will read: the plugin can
   *  answer in the few seconds after claude-ask timed out, and claude-ask only ever
   *  removes files of its own. */
  function removeStrayFiles(): void {
    const stray = LEGACY_FILES.map((f) => join(dir, f));
    try {
      const questions = new Set(readdirSync(questionsDir));
      for (const f of readdirSync(answersDir)) if (!questions.has(f)) stray.push(join(answersDir, f));
    } catch {}
    for (const file of stray) {
      try {
        unlinkSync(file);
        log(`ask: removed stray ${file}`);
      } catch {}
    }
  }

  return {
    pending: () => list,
    bySession: (sessionId) => list.find((q) => q.sessionId === sessionId),
    onChange: (cb) => void listeners.push(cb),
    answer(id, index) {
      const option = list.find((q) => q.id === id)?.options[index];
      if (!option) return;
      writeAnswer(id, { index, optionId: option.id, label: option.label, cancelled: false });
    },
    cancel(id) {
      if (list.some((q) => q.id === id)) writeAnswer(id, { cancelled: true, reason: "terminal" });
    },
    refresh,
    start() {
      try {
        mkdirSync(questionsDir, { recursive: true });
        mkdirSync(answersDir, { recursive: true });
      } catch (err) {
        // Not fatal: this process also runs the session dashboard, the poll copes
        // with a missing directory, and claude-ask creates it anyway.
        log(`ask: cannot create ${dir}: ${String(err)}`);
      }
      removeStrayFiles();
      try {
        watcher = watch(questionsDir, () => refresh());
        // An unhandled watcher error would take the whole plugin down; the poll carries on alone.
        watcher.on("error", (err) => {
          log(`ask: watching ${questionsDir} failed, polling only: ${String(err)}`);
          watcher?.close();
        });
      } catch (err) {
        log(`ask: cannot watch ${questionsDir}, polling only: ${String(err)}`);
      }
      timer = setInterval(refresh, POLL_MS);
      refresh();
    },
    stop() {
      watcher?.close();
      clearInterval(timer);
    },
  };
}
