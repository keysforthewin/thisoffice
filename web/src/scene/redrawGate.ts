/**
 * Cheap per-frame gate for canvas surfaces whose content is derived from store
 * state.
 *
 * The wall boards and the TV used to re-derive their content and `JSON.stringify`
 * it every frame purely to decide whether to repaint — 60 full serializations a
 * second, per surface, of the whole todo/status/stats payload. Almost every one
 * concluded "nothing changed".
 *
 * Two signals make that unnecessary:
 *  - **Identity.** `office` and `stats` are replaced wholesale by
 *    `applyServerMsg` (the socket hands us a fresh `JSON.parse` each time), so a
 *    reference compare detects every server-driven change for free.
 *  - **A slow poll.** Some projections also depend on wall-clock time —
 *    `boardContent` retires an all-completed todo list after TODO_STALE_MS — so
 *    identity alone would miss a transition that no message triggers. Polling a
 *    few times a second is far more resolution than a ten-minute deadline needs.
 *
 * Callers still diff the derived content before repainting the canvas; this only
 * decides whether deriving it is worth doing at all this frame.
 */
export function shouldRecheck(
  now: number,
  lastAt: number,
  intervalMs: number,
  source: unknown,
  lastSource: unknown
): boolean {
  return source !== lastSource || now - lastAt >= intervalMs;
}

/** Poll cadence for time-dependent board content (todo staleness). */
export const BOARD_POLL_MS = 1000;
