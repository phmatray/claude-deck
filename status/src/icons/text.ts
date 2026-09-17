import { VIEWPORT_W, VIEWPORT_X } from "./theme.js";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Average glyph advance as a fraction of the font size. Measured by rasterising
 *  our actual labels: repo and branch names land between 0.40em (`feat/sort-by-
 *  last-activity`, narrow letters) and 0.52em (`main`, wide ones). 0.54 keeps a
 *  margin over the widest sample, because one constant serves two renderers —
 *  SF Pro on macOS, Segoe UI on Windows — and neither is what we measured.
 *  The previous 0.58 overstated every real label by 15-35%, which cost ~3
 *  characters a line and made two branches sharing a prefix render identically. */
const CHAR_W = 0.54;

/** Approximate rendered width for a proportional sans/mono mix at the given px size. */
function approxWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_W;
}

/** Whether `text` is too wide for the key's text band. Single source of truth —
 *  `fitText` and `wrapTwoLines` ask the same question, so the three can't disagree. */
export const overflows = (text: string, fontSize: number) =>
  approxWidth(text, fontSize) > VIEWPORT_W;

const ELLIPSIS = "…";

/** Cuts `text` down to what fits, appending an ellipsis when anything was
 *  dropped. Deliberately static: a key is glanced at, not read, and a scrolling
 *  line makes you wait for the part you need. A stable truncated string is
 *  legible in the half-second you actually look at the deck.
 *
 *  We cut flush to the band rather than to a reserved fraction of it: the margin
 *  now lives in CHAR_W, and taking it twice threw away a character for nothing.
 *  The clip in `textLine` remains the backstop for glyphs wider than CHAR_W. */
function fitText(text: string, fontSize: number): string {
  if (!overflows(text, fontSize)) return text;
  let n = text.length;
  while (n > 0 && approxWidth(text.slice(0, n) + ELLIPSIS, fontSize) > VIEWPORT_W) n--;
  return text.slice(0, n) + ELLIPSIS;
}

/** Breaks after `/` and `-`, keeping the separator on the line it ends. Those are
 *  the only separators branch names use, and `feat/` or `usage-` reads as a unit;
 *  breaking before the separator would orphan it at the start of line two. */
const chunkAtSeparators = (text: string) => text.split(/(?<=[/-])/);

/** Wraps a branch onto two lines at `fontSize`, filling the first as far as the
 *  separators allow. `feat/usage-manual-refresh` becomes `feat/usage-` +
 *  `manual-refresh` — no word is ever split, so each line still reads at a glance.
 *  Returns null when the whole name already fits on one line at this size: a name
 *  that overflows at the full size but fits a size down wants that, not a wrap.
 *  A second line that still overflows is truncated by `textLine` as usual. */
export function wrapTwoLines(text: string, fontSize: number): [string, string] | null {
  if (!overflows(text, fontSize)) return null;
  const chunks = chunkAtSeparators(text);
  let first = "";
  let i = 0;
  while (i < chunks.length && !overflows(first + chunks[i], fontSize)) first += chunks[i++];
  // No separator early enough to break at — a branch like `verylongbranchname`.
  // Cutting mid-word is worse than not wrapping for anything with structure, but
  // here there is none, and half a name on each line still beats one truncated line.
  if (!first) {
    const n = Math.max(1, Math.floor(VIEWPORT_W / (fontSize * CHAR_W)));
    return [text.slice(0, n), text.slice(n)];
  }
  return [first, chunks.slice(i).join("")];
}

/** Returns the SVG fragment for one centered line, truncated to fit and clipped
 *  to the text band. The clip is the backstop for `approxWidth` being a per-char
 *  estimate: a string of unusually wide glyphs measures narrower than it renders,
 *  and would otherwise spill past the border. When it fires the text is cut at
 *  both ends (the line is centered) and the ellipsis goes off-screen — that is
 *  the intended degradation, not a bug.
 *
 *  `clipId` must be unique within the SVG this fragment lands in. Each key is its
 *  own standalone document, so plain `ct` / `cb0`..`cbN` are enough. */
export function textLine(opts: {
  text: string;
  baseline: number;
  fontSize: number;
  weight: string;
  color: string;
  clipId: string;
}): string {
  const { baseline, fontSize, weight, color, clipId } = opts;
  const text = fitText(opts.text, fontSize);
  if (!text) return "";
  const fontFamily = "-apple-system,Segoe UI,Roboto,sans-serif";
  // Box covers cap-top to descender.
  const clipY = baseline - Math.round(fontSize * 0.85);
  const clipH = Math.round(fontSize * 1.2);
  return `<defs><clipPath id="${clipId}"><rect x="${VIEWPORT_X}" y="${clipY}" width="${VIEWPORT_W}" height="${clipH}"/></clipPath></defs>
<text clip-path="url(#${clipId})" x="72" y="${baseline}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${weight}" fill="${color}" text-anchor="middle">${xmlEscape(text)}</text>`;
}
