import type { OfficeState } from '../../../shared/types.ts';
import { resolveFurniture, resolveSeat } from '../scene/buildLayout.ts';

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
 * employee's seat is passed in separately, already resolved by the caller.
 * That split exists for the store subscriber, not this function: `layout` is
 * the one field of `office` the store keeps reference-stable across
 * unrelated broadcasts (`stableLayout` in store.ts), while `office.employees`
 * is a fresh array on every message (ws.ts JSON.parses each one). Deriving
 * `seat` inside a selector — rather than handing this function the whole
 * employees array — turns that per-message noise into a plain number the
 * store can compare with `Object.is`, so the bubble only re-renders when the
 * asker's actual seat changes.
 */
export function askerAnchor(
  asker: string,
  seat: number | null,
  office: Pick<OfficeState, 'layout'> | null,
  maxSeat: number,
): [number, number, number] | null {
  if (!office) return null;
  if (asker === 'catPerson') {
    // Kat Person is furniture, not staff: her spot comes from the layout, and
    // `resolveFurniture` nests it under `pose`
    const item = resolveFurniture(office.layout, maxSeat).find((f) => f.id === 'catPerson');
    return item ? [item.pose.x, BUBBLE_Y, item.pose.z] : null;
  }
  const resolvedSeat = asker === 'boss' ? 0 : seat;
  if (resolvedSeat === null) return null;
  const { position } = resolveSeat(office.layout, resolvedSeat, maxSeat);
  return [position.x, BUBBLE_Y, position.z];
}
