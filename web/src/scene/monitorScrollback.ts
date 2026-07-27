/**
 * Pure scrollback logic for the monitor focus mode. A monitor is a continuous
 * terminal — a new tool appends a divider rather than wiping the screen — so
 * this buffer exists only to hold *more* than the live one: the store caps at
 * MONITOR_MAX_LINES and the on-screen canvas shows ~16 rows, while scrolling
 * back wants several screens of it.
 */

import { appendScreenLines, sectionDivider } from '../../../shared/types.ts';

/** Raw (unwrapped) lines kept per monitor — comfortably 10+ screens of 16 rows. */
export const HISTORY_MAX_LINES = 400;

/** Hard-wrap lines to `cols` characters (no word breaking). */
export function wrapLines(lines: string[], cols: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= cols) out.push(line);
    else for (let i = 0; i < line.length; i += cols) out.push(line.slice(i, i + cols));
  }
  return out;
}

/**
 * Fold one monitor message into the history buffer. Section dividers arrive
 * inside `appended` like any other line (the server writes them there), and
 * `appendScreenLines` collapses two in a row. A `clear` is the reconnect replay
 * rebuilding the screen wholesale, so it restarts the buffer instead of
 * doubling everything the client already has.
 */
export function appendHistory(
  prev: string[],
  appended: string[],
  clear: boolean,
  title: string | undefined,
  cap = HISTORY_MAX_LINES,
): string[] {
  if (clear) return (title ? [sectionDivider(title), ...appended] : appended).slice(-cap);
  return appendScreenLines(prev, appended).slice(-cap);
}

/** Clamp a rows-from-bottom scroll offset so the view never runs past the top. */
export function clampOffset(offset: number, totalRows: number, viewRows: number): number {
  return Math.min(Math.max(0, offset), Math.max(0, totalRows - viewRows));
}

/** The `viewRows` wrapped rows visible at `offset` rows up from the bottom. */
export function visibleRows(wrapped: string[], offset: number, viewRows: number): string[] {
  const end = wrapped.length - offset;
  return wrapped.slice(Math.max(0, end - viewRows), end);
}
