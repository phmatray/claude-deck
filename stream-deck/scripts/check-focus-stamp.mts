// Self-check: the hook stamps the Warp pane uuid + TERM_PROGRAM on each line,
// and the reducer surfaces the latest one (surviving SessionStart's reset).
// Run: pnpm exec tsx scripts/check-focus-stamp.mts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEventLog, reduceEvents } from "../src/session-events.ts";

const home = mkdtempSync(join(tmpdir(), "sdc-stamp-"));
const hook = new URL("../../claude-code/hooks/notification.sh", import.meta.url).pathname;
const fire = (event: string, env: Record<string, string>) =>
  execFileSync(hook, {
    input: JSON.stringify({ session_id: "s1", hook_event_name: event }),
    env: { PATH: process.env.PATH!, HOME: home, ...env },
  });

fire("SessionStart", { WARP_TERMINAL_SESSION_UUID: "aaaa", TERM_PROGRAM: "WarpTerminal" });
fire("UserPromptSubmit", {});
let state = reduceEvents(parseEventLog(readFileSync(join(home, ".claude/sessions/s1.events.ndjson"), "utf8")));
assert.equal(state.warpSession, "aaaa", "uuid from the SessionStart line survives the reset");
assert.equal(state.termProgram, "WarpTerminal");
assert.equal(state.busy, true);

fire("PreToolUse", { WARP_TERMINAL_SESSION_UUID: "bbbb", TERM_PROGRAM: "WarpTerminal" });
state = reduceEvents(parseEventLog(readFileSync(join(home, ".claude/sessions/s1.events.ndjson"), "utf8")));
assert.equal(state.warpSession, "bbbb", "latest uuid wins");

rmSync(home, { recursive: true, force: true });
console.log("ok: focus stamp");
