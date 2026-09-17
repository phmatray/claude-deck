import {
  awaitingPulse,
  emptyDashed,
  errorBolt,
  finishedCheck,
  idlePrompt,
  permissionPulse,
  planPulse,
  questionPulse,
  spinnerArc,
  subagentBranch,
} from "./motifs.js";

type Palette = { bg: string; accent: string; label: string };
type MotifFn = (frame: number, color: string) => string;

interface StateDef {
  palette: Palette;
  /** True if the motif itself uses `frame` (labels never animate — they truncate). */
  animated: boolean;
  /** When true, render.ts overlays the accent color on top of `bg` at a frame-driven
   *  opacity, so the whole tile pulses to "full colour" while the user is being
   *  asked to do something — much easier to spot from a distance than the motif
   *  alone. */
  pulseBg: boolean;
  motif: MotifFn;
}

// Only states that need the user move. Every animated key is re-rendered and
// re-sent to the deck each ANIMATION_MS (8 busy sessions = ~66 images/s), which
// queues page-switch images behind them on the device link; a still spinner
// still reads as "working" from its colour.
export const STATES = {
  working:       { palette: { bg: "#0f1115", accent: "#fbbf24", label: "#fde68a" }, animated: false,  pulseBg: false, motif: spinnerArc },
  subagent:      { palette: { bg: "#0f1115", accent: "#fbbf24", label: "#fde68a" }, animated: false,  pulseBg: false, motif: subagentBranch },
  idle:          { palette: { bg: "#0f1115", accent: "#3b82f6", label: "#bfdbfe" }, animated: false,  pulseBg: false, motif: idlePrompt },
  awaiting:            { palette: { bg: "#1a1208", accent: "#f97316", label: "#fed7aa" }, animated: true,  pulseBg: true,  motif: awaitingPulse },
  awaiting_permission: { palette: { bg: "#1a1308", accent: "#f59e0b", label: "#fde68a" }, animated: true,  pulseBg: true,  motif: permissionPulse },
  awaiting_question:   { palette: { bg: "#08191c", accent: "#06b6d4", label: "#a5f3fc" }, animated: true,  pulseBg: true,  motif: questionPulse },
  awaiting_plan:       { palette: { bg: "#15102a", accent: "#a78bfa", label: "#ddd6fe" }, animated: true,  pulseBg: true,  motif: planPulse },
  error:         { palette: { bg: "#1a0a0a", accent: "#ef4444", label: "#fecaca" }, animated: true,  pulseBg: true,  motif: errorBolt },
  finished:      { palette: { bg: "#0a1410", accent: "#22c55e", label: "#bbf7d0" }, animated: false, pulseBg: false, motif: finishedCheck },
  bg_working:             { palette: { bg: "#10131a", accent: "#8b9cff", label: "#c7d2fe" }, animated: false,  pulseBg: false, motif: spinnerArc },
  // bg_awaiting* partagent la même palette à dessein : états bg basse priorité, le motif seul les distingue.
  bg_awaiting_permission: { palette: { bg: "#12132e", accent: "#a5b4fc", label: "#ddd6fe" }, animated: true,  pulseBg: true,  motif: permissionPulse },
  bg_awaiting:            { palette: { bg: "#12132e", accent: "#a5b4fc", label: "#ddd6fe" }, animated: true,  pulseBg: true,  motif: awaitingPulse },
  bg_idle:                { palette: { bg: "#10131a", accent: "#6b7fd0", label: "#c7d2fe" }, animated: false,  pulseBg: false, motif: idlePrompt },
  empty:         { palette: { bg: "#0a0b0e", accent: "#374151", label: "#4b5563" }, animated: false, pulseBg: false, motif: emptyDashed },
} satisfies Record<string, StateDef>;

export type SessionState = keyof typeof STATES;

/** True for the dedicated background-agent states. The `bg_` prefix is the
 *  single source of truth — render.ts uses this to draw the "bg" badge. */
export const isBgState = (s: SessionState): boolean => s.startsWith("bg_");
