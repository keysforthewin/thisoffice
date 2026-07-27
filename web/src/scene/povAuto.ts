import { activeKeys } from './movieShots.ts';

/**
 * POV auto mode: the over-the-shoulder tour drives itself, hopping between the
 * desks whose screens are actually streaming.
 *
 * Two cadences, because the two situations want different things. With work on
 * screen the tour is a monitor rotation — only desks (boss included) qualify, the
 * wall boards never do, since watching a board over someone's shoulder is not
 * what this mode is for. With nothing streaming there is nothing to rotate, so it
 * falls back to walking the whole POV list, wall boards and all, one spot at a
 * time.
 */
export const POV_AUTO_MS = 5000;

/** Desk POVs whose screen is currently active, as indices into the POV list. */
export function activePovIndices(
  povs: { key: string }[],
  lastActivity: Record<string, number>,
  now: number,
  deskKeys: Set<string>,
): number[] {
  const active = new Set(activeKeys(lastActivity, now));
  return povs.map((p, i) => (active.has(p.key) && deskKeys.has(p.key) ? i : -1)).filter((i) => i >= 0);
}

/**
 * Where the tour goes next.
 *
 * - Several desks streaming → the next active one after the current spot, so it
 *   cycles rather than flipping between the same two.
 * - Exactly one → stay on it. A lone worker is watched, not left.
 * - None → step through the whole list, which is the idle "slowly change" walk.
 *
 * `current` not being among the active indices is not a special case: the
 * round-robin lands on the first one past it either way, which is what makes an
 * off-list spot jump straight to live work.
 */
export function nextPovIndex(current: number, activeIndices: number[], povCount: number): number {
  if (povCount <= 0) return 0;
  if (activeIndices.length === 0) return (current + 1) % povCount;
  if (activeIndices.length === 1) return activeIndices[0];
  return activeIndices.find((i) => i > current) ?? activeIndices[0];
}

/**
 * Whether to cut early, before the dwell timer is up: the tour is parked on a
 * desk with nothing on its screen while other desks are streaming. Waiting out
 * the full dwell there would mean watching a blank monitor with work happening
 * elsewhere in the room.
 */
export function shouldCutEarly(current: number, activeIndices: number[]): boolean {
  return activeIndices.length > 0 && !activeIndices.includes(current);
}
