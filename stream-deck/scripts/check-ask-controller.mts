// Self-check: controller.ts, the answer keys' state machine — which pending question is
// on the keys, and when the deck switches to "Claude Deck" and back. Pure: a fake queue,
// a fake profile switcher and a fake focus, no SDK.
// Run: pnpm exec tsx scripts/check-ask-controller.mts
import assert from "node:assert/strict";
import { createController } from "../src/ask/controller.ts";
import type { Question } from "../src/ask/queue.ts";

let pending: Question[] = [];
const switches: string[][] = [];
const answers: string[] = [];
const focused: string[] = [];
let device: string | undefined = "xl";
let repaints = 0;

const ask = createController({
  pending: () => pending,
  // the real queue drops an answered question at once, before claude-ask removes its file
  answer: (id, index) => {
    answers.push(`${id}:${pending.find((q) => q.id === id)!.options[index].id}`);
    pending = pending.filter((q) => q.id !== id);
  },
  cancel: (id) => {
    answers.push(`${id}:cancelled`);
    pending = pending.filter((q) => q.id !== id);
  },
  switchTo: (d, profile) => void switches.push(profile ? [d, profile] : [d]),
  focus: (q) => void focused.push(q.id),
  defaultDevice: () => device,
  repaint: () => void repaints++,
});

let clock = 0;
const q = (id: string, options = ["allow", "deny"]): Question => ({
  id, kind: "permission", sessionId: `s-${id}`, pid: 1, header: id,
  options: options.map((o) => ({ id: o, label: o })), createdAt: new Date(++clock).toISOString(),
});
/** What the queue does on its own: a question arrives or leaves, then onChange. */
const arrive = (...qs: Question[]) => {
  pending = [...pending, ...qs];
  ask.sync();
};
const leave = (id: string) => {
  pending = pending.filter((p) => p.id !== id);
  ask.sync();
};
const activeId = () => ask.active()?.id ?? null;
const lastSwitch = () => switches.at(-1);

// arrival: nothing active → activate and switch, once
arrive(q("a"));
assert.equal(activeId(), "a");
assert.deepEqual(switches, [["xl", "Claude Deck"]]);
assert.ok(repaints > 0, "keys repainted");
arrive(q("b"));
assert.equal(activeId(), "a", "a second question queues behind the active one");
assert.equal(switches.length, 1, "no second switch");
assert.equal(ask.othersCount(), 1);

// answer → next: b comes up on the same profile
assert.equal(ask.pressOption(5), false, "an empty option key writes nothing");
assert.ok(ask.pressOption(1));
assert.deepEqual(answers, ["a:deny"]);
assert.equal(activeId(), "b");
assert.equal(switches.length, 1);
assert.equal(ask.othersCount(), 0);

// answer → back: nothing left
assert.ok(ask.pressOption(0));
assert.equal(activeId(), null);
assert.deepEqual(lastSwitch(), ["xl"], "back to the previous profile");
assert.equal(ask.pressOption(0), false, "no question, no answer");
assert.equal(ask.pressTerminal(), false);

// back/dismiss: c is set aside (still pending), d comes up; then back again → leave
arrive(q("c"), q("d"));
assert.equal(activeId(), "c");
ask.pressBack();
assert.equal(activeId(), "d");
assert.deepEqual(lastSwitch(), ["xl", "Claude Deck"], "still on the profile");
ask.pressBack();
assert.equal(activeId(), null);
assert.deepEqual(lastSwitch(), ["xl"]);
assert.equal(pending.length, 2, "dismissed questions stay pending");
// a Back key pressed proves its deck is on the profile, even one the controller forgot
// (plugin restarted while the deck showed it): it goes back all the same
const b = switches.length;
ask.pressBack("xl");
assert.deepEqual(switches.slice(b), [["xl"]], "Back takes a forgotten deck home");
arrive(q("e"));
assert.equal(activeId(), "e", "a new question still comes up by itself");
ask.pressBack();
assert.equal(activeId(), null, "dismissed ones are not brought up again");

// slot press on a dismissed question: undismissed, activated on that key's deck
const n = switches.length;
assert.equal(ask.showSession("s-nope", "mini"), false, "a session without a question: focus only");
assert.equal(switches.length, n);
assert.ok(ask.showSession("s-c", "mini"));
assert.equal(activeId(), "c");
assert.deepEqual(lastSwitch(), ["mini", "Claude Deck"]);
assert.ok(ask.showSession("s-d", "xl"), "another deck's key moves the profile there");
assert.deepEqual(switches.slice(-2), [["mini"], ["xl", "Claude Deck"]]);
// switchToProfile is never acknowledged and the deck can leave the profile by hand: a
// dashboard key pressed on the deck believed to show it proves otherwise, so it switches
const m = switches.length;
assert.ok(ask.showSession("s-d", "xl"));
assert.deepEqual(switches.slice(m), [["xl", "Claude Deck"]], "a stale flag never swallows a slot press");
ask.pressBack(); // d dismissed again; c was undismissed by its press → comes up
assert.equal(activeId(), "c");

// queue round-robin: every pending question, dismissed ones included, wrapping; no deck move
assert.deepEqual(pending.map((p) => p.id), ["c", "d", "e"]);
const s = switches.length;
const seen = [activeId()];
for (let i = 0; i < 3; i++) {
  assert.ok(ask.pressQueue());
  seen.push(activeId());
}
assert.deepEqual(seen, ["c", "d", "e", "c"]);
assert.equal(switches.length, s, "the queue key never switches profiles");

// withdrawal while active (answered in the terminal, timed out): the next one comes up
leave("c");
assert.equal(activeId(), "d", "d was undismissed when the queue key reached it");
leave("e");
leave("d");
assert.equal(activeId(), null);
assert.deepEqual(lastSwitch(), ["xl"]);
assert.equal(ask.pressQueue(), false, "nothing to step to");

// terminal key, and an option with id "terminal" (a plan's "Approuver au terminal"): cancel + focus
arrive(q("f"), q("g", ["revise", "terminal"]));
assert.ok(ask.pressTerminal());
assert.deepEqual([answers.at(-1), focused], ["f:cancelled", ["f"]]);
assert.equal(activeId(), "g");
assert.ok(ask.pressOption(1));
assert.deepEqual([answers.at(-1), focused], ["g:cancelled", ["f", "g"]]);
assert.deepEqual(lastSwitch(), ["xl"]);

// no deck connected yet: the question waits, and shows once sync runs on connect
device = undefined;
const t = switches.length;
arrive(q("h"));
assert.equal(activeId(), "h");
assert.equal(switches.length, t, "nowhere to switch");
device = "xl";
ask.sync();
assert.deepEqual(lastSwitch(), ["xl", "Claude Deck"]);
ask.sync();
assert.equal(switches.length, t + 1, "shown once");

console.log("ok: ask controller");
