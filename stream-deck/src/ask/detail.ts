/**
 * The detail strip: rows 1-2 of the answer profile, sixteen keys that read as one
 * 8-key-wide text surface. The text is wrapped once for the whole row width, then
 * every key cuts its own columns out of those lines, so a word runs on across the
 * gap between two keys instead of being re-wrapped inside each 144px square.
 * Pure (no SDK): scripts/check-ask-detail.mts drives it.
 */

// Sized for a 144px key: 13 Menlo glyphs at 17px (0.6em advance) plus the left pad
// fit the width, 6 lines of 23px the height. First guesses, to be tuned for
// legibility on the hardware; the renderer reads them from here, so change them together.
export const DETAIL_FONT_SIZE = 17;
export const COLS_PER_KEY = 13;
export const LINES_PER_KEY = 6;
export const DETAIL_LINE_HEIGHT = 23;
export const DETAIL_PAD_X = 6;
/** Keys per detail row; the strip is two rows of them (segments 0-15). */
export const KEYS_PER_ROW = 8;

const LINE_WIDTH = KEYS_PER_ROW * COLS_PER_KEY;
const MAX_LINES = 2 * LINES_PER_KEY;
const NBSP = "\u00A0";

// Grapheme clusters, not UTF-16 units or code points, so a cut never splits an emoji
// (a ZWJ family, a skin tone, a flag) across two keys.
// ponytail: one column per grapheme; wide glyphs (CJK, emoji) push the rest of
// their line out of step across keys. Measure East Asian width if that shows up.
const graphemes = new Intl.Segmenter();
const chars = (s: string): string[] => Array.from(graphemes.segment(s), (g) => g.segment);

/**
 * The strip's lines: word-wrapped at the row width, tabs as two spaces, newlines
 * kept. A word longer than a whole line can't stay whole anyway, so it starts
 * where the line is and breaks at the width, as in a terminal. At most two rows of
 * lines; when text remains, the last one ends with "…".
 */
export function detailLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trimEnd();
  if (!normalized) return [];
  const lines: string[] = [];
  let line: string[] = [];
  const push = () => {
    lines.push(line.join("").trimEnd());
    line = [];
  };
  // A wrap never makes a blank line: a line holding only spaces goes with the break.
  const wrap = () => {
    if (line.some((c) => c !== " ")) push();
    else line = [];
  };
  // One line past the strip is enough to know it overflows: a huge input stops there.
  for (const p of normalized.split("\n")) {
    const start = lines.length;
    for (const [token] of p.matchAll(/ +|[^ ]+/g)) {
      if (lines.length > MAX_LINES) break;
      const t = chars(token);
      if (token.startsWith(" ")) {
        // Spaces at a break are dropped; anywhere else (indentation too) they stay.
        if (line.length + t.length > LINE_WIDTH) wrap();
        else line.push(...t);
        continue;
      }
      if (line.length + t.length > LINE_WIDTH && t.length <= LINE_WIDTH) wrap();
      for (const ch of t) {
        if (line.length === LINE_WIDTH) wrap();
        if (lines.length > MAX_LINES) break;
        line.push(ch);
      }
    }
    if (lines.length > MAX_LINES) break;
    // Empty after a wrap is only the break; an empty paragraph is a blank line.
    if (line.length || lines.length === start) push();
  }
  if (lines.length <= MAX_LINES) return lines;
  const kept = lines.slice(0, MAX_LINES);
  const last = chars(kept[MAX_LINES - 1]);
  kept[MAX_LINES - 1] = last.slice(0, LINE_WIDTH - 1).join("") + "…";
  return kept;
}

/**
 * What detail key `segment` (0-7 on row 1, 8-15 on row 2) shows: its row's lines,
 * cut to its own columns. Spaces become no-break spaces, because SVG collapses
 * runs of ordinary ones and the columns would no longer line up from key to key.
 */
export function segmentLines(lines: string[], segment: number): string[] {
  const row = Math.floor(segment / KEYS_PER_ROW);
  const col = segment % KEYS_PER_ROW;
  return lines
    .slice(row * LINES_PER_KEY, (row + 1) * LINES_PER_KEY)
    .map((l) => chars(l).slice(col * COLS_PER_KEY, (col + 1) * COLS_PER_KEY).join("").replace(/ /g, NBSP));
}
