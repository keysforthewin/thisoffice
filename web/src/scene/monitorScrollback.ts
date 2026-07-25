/**
 * Pure scrollback logic for the monitor focus mode. History is kept client-side
 * because the server clears each screen on every tool change (transcript.ts) —
 * the live buffer in the store is wiped constantly, so scrolling back needs a
 * separate buffer that survives clears.
 */

/** Raw (unwrapped) lines kept per monitor — comfortably 10+ screens of 16 rows. */
export const HISTORY_MAX_LINES = 400;

function divider(title: string | undefined): string {
  return title ? `── ${title} ──` : '──────';
}

function isDivider(line: string): boolean {
  return line.startsWith('── ') || line === '──────';
}

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
 * Fold one monitor message into the history buffer. A clear becomes a divider
 * line carrying the new title (screen boundaries stay visible when scrolling);
 * consecutive clears collapse into the latest divider.
 */
export function appendHistory(
  prev: string[],
  appended: string[],
  clear: boolean,
  title: string | undefined,
  cap = HISTORY_MAX_LINES,
): string[] {
  let out = prev;
  if (clear && prev.length) {
    out = isDivider(prev[prev.length - 1]) ? prev.slice(0, -1) : prev.slice();
    out.push(divider(title));
  }
  if (appended.length) out = [...out, ...appended];
  return out.slice(-cap);
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
