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
 */
export function askerAnchor(
  asker: string,
  office: OfficeState | null,
  maxSeat: number,
): [number, number, number] | null {
  if (!office) return null;
  if (asker === 'catPerson') {
    // Kat Person is furniture, not staff: her spot comes from the layout, and
    // `resolveFurniture` nests it under `pose`
    const item = resolveFurniture(office.layout, maxSeat).find((f) => f.id === 'catPerson');
    return item ? [item.pose.x, BUBBLE_Y, item.pose.z] : null;
  }
  const seat = asker === 'boss' ? 0 : office.employees.find((e) => e.id === asker)?.seat;
  if (seat === undefined) return null;
  const { position } = resolveSeat(office.layout, seat, maxSeat);
  return [position.x, BUBBLE_Y, position.z];
}
