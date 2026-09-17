// Layout constants (canvas is 144x144). The Stream Deck button has rounded
// corners (radius ~20px on hardware), so we keep all content inside a safe
// inset and use a matching corner radius for our own border.
export const BORDER_INSET = 5;     // outer rect x/y offset
export const BORDER_SIZE = 144 - 2 * BORDER_INSET;
export const BORDER_RADIUS = 20;
export const BORDER_STROKE = 5;    // user requested +2 over previous 3px
export const VIEWPORT_X = 10;
export const VIEWPORT_W = 144 - 2 * VIEWPORT_X;
// Corner badges (slot number right, bg/suffix left) get their own band at the
// very top: the truncated label below is centered and can still span nearly the
// full viewport width, so anything sharing its baseline would collide.
export const BADGE_BASELINE = 19;
export const BADGE_FONT = 10;
export const TOP_BASELINE = 35;
export const TOP_FONT = 19;
// Shift the motif group down so it clears the top text descender (~y=39
// for TOP_BASELINE=35). Without this, idle/error/awaiting motifs whose top
// extent is y=32 visibly graze the project name above.
export const MOTIF_DY = 12;
/** Baseline of the last bottom line (the branch name). Sits low so it reads
 *  as anchored to the key's lower edge rather than floating under the motif.
 *  A wrapped branch keeps this baseline for its second line, so the block grows
 *  upward and short and long branches stay aligned along the bottom edge. */
export const BOTTOM_BASELINE = 132;
export const BOTTOM_FONT = 17;
// Fallback size for a branch too wide at BOTTOM_FONT. It buys ~2 characters,
// which is often enough on its own; when it isn't, the name wraps onto two of
// these lines 18px apart, putting the upper line's clip box at y=101..119 —
// the number the motif has to clear.
export const BOTTOM_TWO_FONT = 15;
export const BOTTOM_TWO_LINE1_BASELINE = BOTTOM_BASELINE - 18;
/** Shrink applied to the motif when the branch wraps, about its own centre
 *  (72,60). The motifs span y=25..95 across every state and frame (the widest
 *  are `subagent`'s orbiting satellite and `awaiting`'s pulse), so at MOTIF_DY
 *  they occupy 37..107 — 6px into the wrapped label. 0.77 pulls that back to
 *  45..99, clearing the top line's descender (y=42) and the wrapped label's clip
 *  top (y=101) with ~2px to spare on each side. Keys whose branch fits on one
 *  line keep the motif at full size. */
export const MOTIF_SCALE_TWO_LINE = 0.77;
