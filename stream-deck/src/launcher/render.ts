/** Key art for the launcher: the folder-plus glyph of the action icon, with the
 *  target's name under it. Same geometry and truncation as the session keys
 *  (icons/theme.ts, icons/text.ts) so a launcher key sits next to them without
 *  looking like a different plugin. SDK-free, so the check can render it. */

import { textLine } from "../icons/text.js";
import { BORDER_INSET, BORDER_RADIUS, BORDER_SIZE, BORDER_STROKE, BOTTOM_BASELINE, BOTTOM_FONT } from "../icons/theme.js";

const BG = "#0F1115";
const STROKE = "#3D4B60";
const ACCENT = "#F97316";

/** Shown until the user sets a directory — French, like every other on-deck label. */
export const UNSET_LABEL = "Dossier ?";

export function launcherKey(label: string): string {
  const text = label.trim() || UNSET_LABEL;
  const dim = text === UNSET_LABEL;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${BG}"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${STROKE}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round"/>
<g opacity="${dim ? "0.45" : "1"}">
<path d="M30 40 H60 L68 48 H114 V96 H30 Z" fill="none" stroke="${ACCENT}" stroke-width="6" stroke-linejoin="round"/>
<path d="M72 58 V86 M58 72 H86" fill="none" stroke="${ACCENT}" stroke-width="6" stroke-linecap="round"/>
</g>
${textLine({ text, baseline: BOTTOM_BASELINE, fontSize: BOTTOM_FONT, weight: "700", color: dim ? "#6B7685" : "#E7ECF3", clipId: "cl" })}
</svg>`;
}

/** The same art as a `setImage` data URL. */
export function launcherKeyUrl(label: string): string {
  return "data:image/svg+xml;base64," + Buffer.from(launcherKey(label), "utf8").toString("base64");
}
