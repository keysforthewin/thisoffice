import type { OfficeState } from '../../../shared/types.ts';
import { resolveFurniture, resolveSeat } from '../scene/buildLayout.ts';
import { roomDims } from '../scene/layout.ts';

/**
 * World scale is ~1.35x human: characters are ~2.3 units tall, so the bubble
 * hangs above that rather than at the ~1.1 look-at height the cameras use.
 */
const BUBBLE_Y = 3.0;

/**
 * Where the speech bubble hangs for a given asker id. Kat Person is furniture,
 * not staff, so her anchor comes from the layout rather than a seat.
 *
 * `office` is narrowed to just `layout` (not the whole `OfficeState`) and the
 * seat is passed in separately. `seat` comes off the protocol — `askerSeat` on
 * the question, `seat` on the winner — never from a lookup in the live roster:
 * the game is player-paced, so an idle asker can be evicted (`fireIfIdle`,
 * 60 s by default) while their bubble is still up, and a roster lookup would
 * then resolve to nothing and strand an unanswerable question. Taking `layout`
 * alone also keeps the store subscription cheap: `layout` is the one field of
 * `office` the store keeps reference-stable across unrelated broadcasts
 * (`stableLayout` in store.ts), while `office.employees` is a fresh array on
 * every message (ws.ts JSON.parses each one).
 */
export function askerAnchor(
  asker: string,
  seat: number | null,
  office: (Pick<OfficeState, 'layout'> & { katPerson?: boolean }) | null,
  maxSeat: number,
): [number, number, number] | null {
  const pose = askerPose(asker, seat, office, maxSeat);
  return pose ? [pose.x, BUBBLE_Y, pose.z] : null;
}

/** Where an asker stands and which way they are turned. */
export interface AskerPose {
  x: number;
  z: number;
  /** World Y-rotation; characters are rendered looking down their local +z. */
  rotY: number;
}

/**
 * The same lookup `askerAnchor` does, with the facing kept. The winner's photo
 * needs it: a head-on portrait is only head-on if the camera stands on the
 * character's own facing axis (`photoShot`).
 */
export function askerPose(
  asker: string,
  seat: number | null,
  office: (Pick<OfficeState, 'layout'> & { katPerson?: boolean }) | null,
  maxSeat: number,
): AskerPose | null {
  if (!office) return null;
  if (asker === 'catPerson') {
    // Kat Person is furniture, not staff: her spot comes from the layout, and
    // `resolveFurniture` nests it under `pose`. Switched off mid-question she is
    // simply not there, and the caller falls back rather than pointing at a
    // corner she has left.
    const item = resolveFurniture(office.layout, maxSeat, office.katPerson !== false).find((f) => f.id === 'catPerson');
    return item ? { x: item.pose.x, z: item.pose.z, rotY: item.pose.rotY } : null;
  }
  const resolvedSeat = asker === 'boss' ? 0 : seat;
  if (resolvedSeat === null) return null;
  const { position, rotationY } = resolveSeat(office.layout, resolvedSeat, maxSeat);
  // The room is sized to the current roster, so an evicted asker's seat can now
  // lie beyond the front wall — the bubble would hang outside the room, in view
  // of nobody. Clamped, it stays inside and therefore stays clickable.
  const [x, , z] = clampInside(position.x, position.z, maxSeat);
  return { x, z, rotY: rotationY };
}

/** Room margin for a clamped anchor: enough that the bubble is not inside a wall. */
const WALL_MARGIN = 0.8;

function clampInside(x: number, z: number, maxSeat: number): [number, number, number] {
  const { width, depth, centerZ } = roomDims(maxSeat);
  const maxX = Math.max(0, width / 2 - WALL_MARGIN);
  const halfD = Math.max(0, depth / 2 - WALL_MARGIN);
  return [
    Math.min(maxX, Math.max(-maxX, x)),
    BUBBLE_Y,
    Math.min(centerZ + halfD, Math.max(centerZ - halfD, z)),
  ];
}

/**
 * Last resort when nothing about the asker can be resolved: the middle of the
 * room. A misplaced bubble is a cosmetic problem; a missing one is a stuck game,
 * because the server keeps holding the question and only the bubble can answer it.
 */
export function fallbackAnchor(maxSeat: number): [number, number, number] {
  return [0, BUBBLE_Y, roomDims(maxSeat).centerZ];
}
