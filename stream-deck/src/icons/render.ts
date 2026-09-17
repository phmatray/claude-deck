import {
  BADGE_BASELINE,
  BADGE_FONT,
  BORDER_INSET,
  BORDER_RADIUS,
  BORDER_SIZE,
  BORDER_STROKE,
  BOTTOM_BASELINE,
  BOTTOM_FONT,
  BOTTOM_TWO_FONT,
  BOTTOM_TWO_LINE1_BASELINE,
  MOTIF_DY,
  MOTIF_SCALE_TWO_LINE,
  TOP_BASELINE,
  TOP_FONT,
} from "./theme.js";
import { overflows, textLine, wrapTwoLines, xmlEscape } from "./text.js";
import { STATES, isBgState, type SessionState } from "./states.js";
import { ANIMATION_FRAMES } from "./motifs.js";
import type { TodoStatus } from "../session-events.js";

/** Peak opacity of the accent-on-bg overlay used by `pulseBg` states. */
const PULSE_BG_PEAK = 0.75;
/** How many bg-pulse cycles fit into one motif period. >1 makes the tile flash
 *  faster than the motif beats — reads as "urgent / hurry up". */
const PULSE_BG_SPEED = 2;

export interface IconOptions {
  state: SessionState;
  slot: number;
  /** Top line — repo name, or the session name the user pinned explicitly. */
  label: string;
  /** Bottom caption — current branch (or short SHA when detached). Wraps onto a
   *  second line when it doesn't fit on one. Omitted when the session's cwd isn't
   *  in a repo we can read. */
  branch?: string;
  /** Corner disambiguator (`b7`) for sessions sharing one worktree. */
  badge?: string;
  /** The session has a question waiting on the deck's answer keys. */
  deck?: boolean;
  /** Animation frame, 0..ANIMATION_FRAMES-1. */
  frame?: number;
  /** TodoWrite snapshot — renders a left-edge progress column when non-empty. */
  todos?: TodoStatus[];
}

// Left-edge progress column geometry. The column sits at x=2..7, outside the
// VIEWPORT_X=10 text band, so it never overlaps label text.
const TODO_X = 2;
const TODO_BAND_Y0 = 18;
const TODO_BAND_Y1 = 130;
const TODO_BAND_H = TODO_BAND_Y1 - TODO_BAND_Y0;
const TODO_MAX_W = 5;
const TODO_MIN_W = 2;
const TODO_COLORS: Record<TodoStatus, string> = {
  pending:     "#374151",
  in_progress: "#fbbf24",
  completed:   "#22c55e",
};

function renderTodoColumn(todos: readonly TodoStatus[], frame: number): string {
  if (todos.length === 0) return "";
  // Auto-shrink: pick the largest size that fits N stacked squares in BAND_H.
  // stride = W + gap, with gap = max(1, floor(W/3)).
  let w = TODO_MAX_W;
  for (; w >= TODO_MIN_W; w--) {
    const gap = Math.max(1, Math.floor(w / 3));
    if (todos.length * (w + gap) - gap <= TODO_BAND_H) break;
  }
  const gap = Math.max(1, Math.floor(w / 3));
  const stride = w + gap;
  // In-progress pulse — same triangle wave as motifs/pulseBg so beats align.
  const phase = (frame % ANIMATION_FRAMES) / ANIMATION_FRAMES;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const pulseOpacity = (0.4 + tri * 0.6).toFixed(3);
  const rects = todos.map((status, i) => {
    const y = TODO_BAND_Y0 + i * stride;
    const fill = TODO_COLORS[status];
    const opacity = status === "in_progress" ? pulseOpacity : "1";
    return `<rect x="${TODO_X}" y="${y}" width="${w}" height="${w}" fill="${fill}" opacity="${opacity}"/>`;
  });
  return rects.join("");
}

function renderSlotBadge(slotText: string, accent: string): string {
  return `<text x="128" y="${BADGE_BASELINE}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${BADGE_FONT}" font-weight="700" fill="${accent}" opacity="0.8" text-anchor="end">${xmlEscape(slotText)}</text>`;
}

/** Top-left corner, x=16: the exact mirror of the slot number (top right, x=128),
 *  so the two never collide. Carries the `bg` tag and/or the disambiguating suffix
 *  of sessions sharing a worktree, after the deck badge when there is one. */
function renderTopLeftBadge(text: string, accent: string, x = 16): string {
  return `<text x="${x}" y="${BADGE_BASELINE}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${BADGE_FONT}" font-weight="700" fill="${accent}" opacity="0.8" text-anchor="start">${xmlEscape(text)}</text>`;
}

/** How to draw the branch caption: one line at full size, one line a size down,
 *  or two wrapped lines. Only the last case makes the motif give up height, so
 *  a name that merely needs a smaller face doesn't disturb the tile's geometry. */
function branchCaption(branch: string): { lines: string[]; fontSize: number } {
  if (!overflows(branch, BOTTOM_FONT)) return { lines: [branch], fontSize: BOTTOM_FONT };
  const wrapped = wrapTwoLines(branch, BOTTOM_TWO_FONT);
  return { lines: wrapped ?? [branch], fontSize: BOTTOM_TWO_FONT };
}

/** Deck badge geometry: a 14x10 key with three dots, sitting in the badge band. */
const DECK_BADGE_X = 16;
const DECK_BADGE_W = 14;
const DECK_BADGE_H = 10;
const DECK_BADGE_GAP = 4;

/** "A question waits on the deck for this session": a small filled key with three
 *  dots, drawn in the label colour with the dots punched out in the background. */
function renderDeckBadge(color: string, bg: string): string {
  const y = BADGE_BASELINE - 9;
  const cy = y + DECK_BADGE_H / 2;
  const dots = [3.5, 7, 10.5]
    .map((dx) => `<circle cx="${DECK_BADGE_X + dx}" cy="${cy}" r="1.3" fill="${bg}"/>`)
    .join("");
  return `<rect x="${DECK_BADGE_X}" y="${y}" width="${DECK_BADGE_W}" height="${DECK_BADGE_H}" rx="2.5" fill="${color}"/>${dots}`;
}

export function renderIcon({ state, slot, label, branch, badge, deck = false, frame = 0, todos }: IconOptions): string {
  const { bg, accent, label: labelColor } = STATES[state].palette;
  const slotText = state === "empty" ? "" : String(slot);
  const isEmpty = state === "empty";
  // One meaning per line: which project on top, which branch below. Values too
  // wide for the key are truncated with an ellipsis (see fitText).
  const top = isEmpty ? "free slot" : label;
  const bottom = isEmpty ? "" : branch ?? "";

  const topLine = textLine({
    text: top,
    baseline: TOP_BASELINE,
    fontSize: TOP_FONT,
    weight: "700",
    color: accent,
    clipId: "ct",
  });

  // Three fits, cheapest first: the whole branch at full size, the whole branch a
  // size down, or wrapped onto two lines. Only the last costs the motif height,
  // so only the keys that would otherwise be cut mid-prefix pay for it.
  const caption = bottom ? branchCaption(bottom) : null;
  const wrapped = caption !== null && caption.lines.length === 2;
  const bottomSvg = caption
    ? caption.lines
        .map((text, i) =>
          textLine({
            text,
            // The last line always sits on BOTTOM_BASELINE, so the caption grows
            // upward and every key stays aligned along its lower edge.
            baseline: i === caption.lines.length - 1 ? BOTTOM_BASELINE : BOTTOM_TWO_LINE1_BASELINE,
            fontSize: caption.fontSize,
            weight: "600",
            color: labelColor,
            clipId: `cb${i}`,
          }),
        )
        .join("")
    : "";
  // Scale about the motif's own centre so it shrinks in place rather than
  // drifting toward the origin.
  const motifTransform = wrapped
    ? `translate(0,${MOTIF_DY}) translate(72,60) scale(${MOTIF_SCALE_TWO_LINE}) translate(-72,-60)`
    : `translate(0,${MOTIF_DY})`;

  // Slot number badge — inside the safe zone, away from the rounded corner.
  const slotBadge = isEmpty ? "" : renderSlotBadge(slotText, accent);
  // `bg` tag and the `b7`-style suffix share the top-left corner: two sessions
  // in the same worktree render identically otherwise, and neither deserves a
  // whole text line.
  const cornerText = isEmpty ? "" : [isBgState(state) ? "bg" : "", badge ?? ""].filter(Boolean).join(" ");
  const showDeck = deck && !isEmpty;
  const deckBadge = showDeck ? renderDeckBadge(labelColor, bg) : "";
  const cornerBadge = cornerText
    ? renderTopLeftBadge(cornerText, accent, showDeck ? DECK_BADGE_X + DECK_BADGE_W + DECK_BADGE_GAP : DECK_BADGE_X)
    : "";

  let pulseOverlay = "";
  if (STATES[state].pulseBg) {
    // Same triangle wave the motifs use (motifs.ts), but ticked PULSE_BG_SPEED×
    // faster so the tile flashes urgently while the motif keeps its calmer beat.
    const phase = ((frame * PULSE_BG_SPEED) % ANIMATION_FRAMES) / ANIMATION_FRAMES;
    const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    const opacity = (tri * PULSE_BG_PEAK).toFixed(3);
    pulseOverlay = `<rect width="144" height="144" fill="${accent}" opacity="${opacity}"/>`;
  }

  const todoColumn = todos && todos.length > 0 ? renderTodoColumn(todos, frame) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bg}"/>
${pulseOverlay}
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${accent}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="${isEmpty ? "0.45" : "0.95"}"/>
${slotBadge}
${deckBadge}
${cornerBadge}
${topLine}
<g transform="${motifTransform}">${STATES[state].motif(frame, accent)}</g>
${bottomSvg}
${todoColumn}
</svg>`;
}

/** True when the icon's visual depends on `frame` and must be re-rendered often.
 *  Text never qualifies: labels are truncated, not scrolled, so a static state
 *  with a long name stays genuinely static. */
export function iconNeedsAnimation(state: SessionState): boolean {
  return STATES[state].animated;
}

/** True when the state's motif uses `frame` (motif only — todo pulsing is the
 *  caller's concern, see render-loop.ts). */
export const isAnimated = (s: SessionState) => STATES[s].animated;

/** Palette dédiée à l'état "kill en cours d'armement" (hors registre STATES :
 *  ce n'est pas un SessionState, juste un overlay éphémère pendant le hold). */
const KILL_BG = "#1a0606";
const KILL_ACCENT = "#ef4444";

export interface KillArmingOptions {
  slot: number;
  label: string;
  /** Same corner disambiguator as the normal tile — without it the ring reads
   *  identically for two sessions sharing a worktree, right when the caption
   *  matters most. */
  badge?: string;
  /** 0..1 — fraction du hold écoulée entre LONG_PRESS_MS et KILL_PRESS_MS. */
  progress: number;
}

/** Tile rouge avec un anneau de progression + label "KILL", affichée pendant
 *  que l'utilisateur maintient la touche entre 500ms et 3s. À 1.0 l'anneau est
 *  plein → le kill part. Relâcher avant ramène le slot à son état normal. */
export function renderKillArming({ slot, label, badge, progress }: KillArmingOptions): string {
  const p = Math.max(0, Math.min(1, progress));
  const cx = 72;
  const cy = 80;
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = (circ * (1 - p)).toFixed(2);
  const overlayOpacity = (0.15 + p * 0.45).toFixed(3);
  const topLine = textLine({
    text: label,
    baseline: TOP_BASELINE,
    fontSize: TOP_FONT,
    weight: "700",
    color: KILL_ACCENT,
    clipId: "ct",
  });
  const slotBadge = renderSlotBadge(String(slot), KILL_ACCENT);
  const cornerBadge = badge ? renderTopLeftBadge(badge, KILL_ACCENT) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${KILL_BG}"/>
<rect width="144" height="144" fill="${KILL_ACCENT}" opacity="${overlayOpacity}"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${KILL_ACCENT}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="0.95"/>
${slotBadge}
${cornerBadge}
${topLine}
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a1414" stroke-width="6"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${KILL_ACCENT}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})"/>
<text x="${cx}" y="${cy + 6}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="17" font-weight="700" fill="${KILL_ACCENT}" text-anchor="middle">KILL</text>
</svg>`;
}

/** Palette pour le badge "hooks mal configurés" sur la touche Setup — ambre
 *  caution, distinct du rouge error/kill (ce n'est pas un crash, juste une
 *  install à relancer). Hors registre STATES : la touche Setup n'est pas une
 *  session. Voir hook-check.ts + setup-action.ts. */
const HOOK_WARN_BG = "#1a1205";
const HOOK_WARN_ACCENT = "#f59e0b";

/** Tuile statique posée sur la touche Setup quand checkHooks() détecte une
 *  config de hook périmée/absente : triangle d'alerte + "HOOKS". Statique à
 *  dessein — la touche Setup n'est pas dans la boucle d'animation. */
export function renderHookWarning(): string {
  const a = HOOK_WARN_ACCENT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${HOOK_WARN_BG}"/>
<rect width="144" height="144" fill="${a}" opacity="0.12"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${a}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="0.95"/>
<text x="72" y="30" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" font-weight="700" fill="${a}" opacity="0.8" text-anchor="middle">SETUP</text>
<path d="M72 48 L104 100 L40 100 Z" fill="none" stroke="${a}" stroke-width="6" stroke-linejoin="round"/>
<rect x="69" y="66" width="6" height="20" rx="3" fill="${a}"/>
<circle cx="72" cy="94" r="3.5" fill="${a}"/>
<text x="72" y="128" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="16" font-weight="700" fill="${a}" text-anchor="middle">HOOKS</text>
</svg>`;
}
