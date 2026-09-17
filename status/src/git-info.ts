import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolves "which repo / which branch" for a session cwd by reading git's own
 * plumbing files — no `git` spawn. The slow tick runs once a second across every
 * live session, so shelling out N times per tick is not an option; `.git/HEAD`
 * is a two-line file that only changes on checkout.
 *
 * Both layouts are handled: a plain repo (`.git/` is a directory) and a linked
 * worktree (`.git` is a file holding `gitdir: <path>`, with `commondir` next to
 * that pointing back at the main repo). The repo name is always taken from the
 * *main* worktree's root, so every worktree of the same project reports the
 * same repo and is told apart by its branch.
 */

export interface GitInfo {
  /** Repository name = basename of the main worktree root. */
  repo?: string;
  /** Current branch, or a short SHA when HEAD is detached. */
  branch?: string;
}

const NONE: GitInfo = {};

/** How far up from cwd we look for `.git` before giving up. */
const MAX_DEPTH = 40;

interface RepoEntry {
  /** Path to this worktree's git dir. */
  headPath: string;
  repo: string;
}

/** cwd → resolved repo, or null when cwd isn't in a repo we can reach. A repo
 *  never moves under a live session, so entries only drop when the session goes
 *  away (see pruneGitCache). The value is the in-flight promise rather than the
 *  result, so two sessions sharing a worktree walk the tree once. */
const repoCache = new Map<string, Promise<RepoEntry | null>>();

/** headPath → parsed branch, gated on (mtimeMs, size) exactly like the caches in
 *  sessions.ts: HEAD changes only on checkout, so re-parsing it every tick is
 *  pure waste. */
interface HeadEntry {
  mtimeMs: number;
  size: number;
  branch: string;
}
const headCache = new Map<string, HeadEntry>();

/** Reads `gitdir:` out of a `.git` *file* (linked worktree / submodule). */
async function readGitDirPointer(dotGit: string, dir: string): Promise<string | undefined> {
  let txt: string;
  try {
    txt = await readFile(dotGit, "utf8");
  } catch {
    return undefined;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(txt);
  if (!m) return undefined;
  // `resolve` keeps an absolute pointer as-is and anchors a relative one to `dir`.
  return resolve(dir, m[1]);
}

/** Walks up from `cwd` to the first `.git`, then resolves the main repo root. */
async function resolveRepo(cwd: string): Promise<RepoEntry | null> {
  let dir = cwd;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const dotGit = join(dir, ".git");
    let isDir: boolean;
    try {
      isDir = (await stat(dotGit)).isDirectory();
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null; // hit the filesystem root
      dir = parent;
      continue;
    }

    if (isDir) return { headPath: join(dotGit, "HEAD"), repo: basename(dir) };

    const gitDir = await readGitDirPointer(dotGit, dir);
    if (!gitDir) return null;
    // `commondir` (relative to gitDir) points at the main repo's `.git`; its
    // parent is the main worktree root, which is the name we want to show.
    let repoRoot = dirname(gitDir);
    try {
      const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      if (common) repoRoot = dirname(resolve(gitDir, common));
    } catch {
      // No commondir (plain submodule, or unreadable) — the fallback above is fine.
    }
    return { headPath: join(gitDir, "HEAD"), repo: basename(repoRoot) };
  }
  return null;
}

/** Parses `.git/HEAD`: a symbolic ref for a branch, a raw SHA when detached. */
function parseHead(txt: string): string {
  const t = txt.trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(t);
  if (m) return m[1];
  // 40 hex chars for a SHA-1 repo, 64 for `--object-format=sha256`.
  return /^[0-9a-f]{7,64}$/i.test(t) ? t.slice(0, 7) : "";
}

/** Best-effort repo+branch for one session cwd. Never throws: anything we can't
 *  reach or parse (not a repo, unreadable HEAD) comes back as an empty GitInfo and
 *  the caller simply shows less. */
export async function readGitInfo(cwd: string): Promise<GitInfo> {
  if (!cwd) return NONE;

  const key = cwd;
  let pending = repoCache.get(key);
  if (!pending) {
    // `.catch` keeps this function's "never throws" contract even if resolveRepo
    // grows a path that can reject — a rejected promise left in the map would
    // otherwise throw on every later tick.
    pending = resolveRepo(cwd).catch(() => null);
    repoCache.set(key, pending);
  }
  const entry = await pending;
  if (!entry) return NONE;

  let branch = "";
  try {
    const st = await stat(entry.headPath);
    const cached = headCache.get(entry.headPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      branch = cached.branch;
    } else {
      branch = parseHead(await readFile(entry.headPath, "utf8"));
      headCache.set(entry.headPath, { mtimeMs: st.mtimeMs, size: st.size, branch });
    }
  } catch {
    // HEAD vanished (repo deleted mid-session?) — drop the memo so a later tick
    // can re-resolve, and fall through with repo only.
    repoCache.delete(key);
  }

  return { repo: entry.repo, branch: branch || undefined };
}

/** Drops memo entries for sessions that are gone, keeping both maps bounded by
 *  live-session count (same contract as the caches in sessions.ts). Async only
 *  because repoCache holds promises; by prune time they are all settled. */
export async function pruneGitCache(cwds: readonly string[]): Promise<void> {
  const liveKeys = new Set(cwds);
  const liveHeads = new Set<string>();
  for (const [key, pending] of repoCache) {
    if (!liveKeys.has(key)) {
      repoCache.delete(key);
      continue;
    }
    const entry = await pending;
    if (entry) liveHeads.add(entry.headPath);
  }
  for (const headPath of headCache.keys()) {
    if (!liveHeads.has(headPath)) headCache.delete(headPath);
  }
}
