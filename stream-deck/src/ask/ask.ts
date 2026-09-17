import streamDeck, { DeviceType } from "@elgato/streamdeck";
import { mkdirSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASK_DIR } from "../env.js";

/**
 * The answer-key side of the `claude-ask` file protocol: `claude-ask` writes
 * question.json and polls answer.json; this module watches the question, puts
 * the deck on the bundled profile while one is pending, and writes the answer
 * when a key is pressed.
 */

/** The bundled profile (manifest `Profiles[].Name`) the answer keys live on. */
const PROFILE_NAME = "Claude Deck";
const QUESTION_FILE = join(ASK_DIR, "question.json");
const ANSWER_FILE = join(ASK_DIR, "answer.json");

export interface AskOption {
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  header?: string;
  question?: string;
  context?: string;
  options?: AskOption[];
}

export type Answer = { index: number; label: string; cancelled: false } | { cancelled: true };

let question: Question | null = null;
/** Deck the profile was switched on — the one to send back once the question goes. */
let shownOn: string | undefined;
let repaint: () => void = () => {};

export const currentQuestion = (): Question | null => question;

/** The bundled profile targets the XL, so prefer one; otherwise the first deck
 *  with a grid of keys (more than one row: not a pedal or a strip of G keys). */
function targetDevice(): string | undefined {
  const connected = [...streamDeck.devices].filter((d) => d.isConnected);
  return (connected.find((d) => d.type === DeviceType.StreamDeckXL) ?? connected.find((d) => d.size.rows > 1))?.id;
}

function showProfile(): void {
  const device = targetDevice();
  if (!device) return;
  shownOn = device;
  streamDeck.profiles.switchToProfile(device, PROFILE_NAME, 0).catch((err: unknown) => {
    streamDeck.logger.warn(`ask: switch to ${PROFILE_NAME} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Omitting the profile name returns the deck to whatever profile was active before. */
function hideProfile(): void {
  if (!shownOn) return;
  const device = shownOn;
  shownOn = undefined;
  streamDeck.profiles.switchToProfile(device).catch((err: unknown) => {
    streamDeck.logger.warn(`ask: switch back failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function readQuestion(): void {
  let next: Question | null = null;
  try {
    const raw = readFileSync(QUESTION_FILE, "utf8");
    if (raw.trim()) next = JSON.parse(raw) as Question;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      streamDeck.logger.warn(`ask: cannot read question: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const nextId = next?.id ?? null;
  if ((question?.id ?? null) === nextId) return;

  question = nextId ? next : null;
  repaint();

  if (question && !shownOn) {
    showProfile();
    streamDeck.logger.info(`ask: ${question.header || question.question || ""}`);
  } else if (!question) {
    // Withdrawn from the CLI side: timed out, cancelled, or answered in the terminal.
    hideProfile();
  }
}

/** Writes the answer `claude-ask` is polling for, then releases the deck. */
export function answer(a: Answer): void {
  if (!question) return;
  mkdirSync(ASK_DIR, { recursive: true });
  writeFileSync(ANSWER_FILE, JSON.stringify({ id: question.id, ...a, answeredAt: new Date().toISOString() }, null, 2));
  question = null;
  repaint();
  hideProfile();
}

/** Starts watching for questions; `onChange` repaints every answer key. */
export function startAsk(onChange: () => void): void {
  repaint = onChange;
  mkdirSync(ASK_DIR, { recursive: true });
  watchFile(QUESTION_FILE, { interval: 200 }, readQuestion);
  readQuestion();
}
