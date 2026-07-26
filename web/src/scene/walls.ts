import * as THREE from 'three';
import { WALL_SIDES, type WallSide } from '../../../shared/types.ts';
import { BACK_Z, ROOM_HEIGHT, roomDims } from './layout.ts';

/**
 * Where the four walls are, and how a point on one maps to the world.
 *
 * This exists because that knowledge used to be spread across three files —
 * Office.tsx positioned the wall groups, build.tsx intersected drag rays with
 * wall planes, buildLayout.ts computed how far along a wall an item could sit —
 * and each held its own copy of the sign conventions. Adding a fourth wall and
 * corner-to-corner dragging to three copies is how a wall ends up rendering in
 * one place and picking in another.
 *
 * `ox` runs along the wall from its centre; `oy` is height above the floor.
 *
 * The walls chain: WALL_SIDES is perimeter order, and every wall's `ox`
 * increases in the same rotational direction, so the far end of one wall is the
 * near end of the next. Walking `ox` upward from the left wall's front end goes
 * left → back → right → front and returns to where it started. That is what
 * makes dragging an item around a corner a matter of carrying the overflow
 * rather than a special case per corner.
 */

/** A wall as a plane in the world: where its centre is and which way it faces. */
export interface WallFrame {
  id: WallSide;
  /** world position of the wall's centre at floor level (ox 0, oy 0) */
  origin: THREE.Vector3;
  /** rotation about Y that turns the wall's local frame into the world's */
  rotationY: number;
  /** wall length along `ox` */
  span: number;
  /** unit normal pointing into the room */
  normal: THREE.Vector3;
}

export function wallFrame(id: WallSide, maxSeat: number): WallFrame {
  const { width, depth, centerZ } = roomDims(maxSeat);
  const frontZ = centerZ + depth / 2;
  switch (id) {
    case 'back':
      // ox = world x, increasing toward the back-right corner
      return {
        id, span: width, rotationY: 0,
        origin: new THREE.Vector3(0, 0, BACK_Z),
        normal: new THREE.Vector3(0, 0, 1),
      };
    case 'right':
      // ox = z - centerZ, picking up at the back-right corner and running forward
      return {
        id, span: depth, rotationY: -Math.PI / 2,
        origin: new THREE.Vector3(width / 2, 0, centerZ),
        normal: new THREE.Vector3(-1, 0, 0),
      };
    case 'front':
      // ox = -x, picking up at the front-right corner and running back to the left
      return {
        id, span: width, rotationY: Math.PI,
        origin: new THREE.Vector3(0, 0, frontZ),
        normal: new THREE.Vector3(0, 0, -1),
      };
    case 'left':
      // ox = centerZ - z, picking up at the front-left corner and running to the back
      return {
        id, span: depth, rotationY: Math.PI / 2,
        origin: new THREE.Vector3(-width / 2, 0, centerZ),
        normal: new THREE.Vector3(1, 0, 0),
      };
  }
}

/** World position of a point on a wall. `out` avoids a Vector3 per frame while dragging. */
export function wallToWorld(
  id: WallSide,
  ox: number,
  oy: number,
  maxSeat: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const f = wallFrame(id, maxSeat);
  // the wall's local +x in world terms, from rotationY
  const ax = Math.cos(f.rotationY);
  const az = -Math.sin(f.rotationY);
  return out.set(f.origin.x + ax * ox, oy, f.origin.z + az * ox);
}

/** Where a ray crosses a wall's (infinite) plane, in that wall's local frame. */
export function wallPlaneHit(
  ray: { origin: THREE.Vector3; direction: THREE.Vector3 },
  id: WallSide,
  maxSeat: number,
): { ox: number; oy: number } | null {
  const f = wallFrame(id, maxSeat);
  // the plane's constant axis is x for the side walls, z for back/front
  const alongZ = id === 'back' || id === 'front';
  const dirC = alongZ ? ray.direction.z : ray.direction.x;
  if (Math.abs(dirC) < 1e-6) return null;
  const originC = alongZ ? ray.origin.z : ray.origin.x;
  const planeC = alongZ ? f.origin.z : f.origin.x;
  const t = (planeC - originC) / dirC;
  if (t < 0) return null;
  const hit = ray.origin.clone().addScaledVector(ray.direction, t);
  // invert wallToWorld: project the hit onto the wall's local +x
  const ax = Math.cos(f.rotationY);
  const az = -Math.sin(f.rotationY);
  return { ox: (hit.x - f.origin.x) * ax + (hit.z - f.origin.z) * az, oy: hit.y };
}

/** The next/previous wall around the perimeter. */
export function nextWall(id: WallSide, step: 1 | -1): WallSide {
  const i = WALL_SIDES.indexOf(id);
  return WALL_SIDES[(i + step + WALL_SIDES.length) % WALL_SIDES.length];
}

/**
 * Carry an out-of-range `ox` around the corner onto the neighbouring wall.
 *
 * Overflowing the far end of a wall by δ lands δ past the near end of the next
 * one, so the item travels a continuous distance around the room however the
 * walls differ in length. Loops until the offset lands in range, which matters
 * for a fast drag: one pointermove can outrun a whole short wall.
 *
 * `halfW` insets both ends by the item's own half-width, so an item transfers
 * when its *edge* reaches the corner rather than sliding halfway into the
 * adjacent wall first.
 */
export function carryAroundCorner(
  wall: WallSide,
  ox: number,
  maxSeat: number,
  halfW = 0,
): { wall: WallSide; ox: number } {
  let cur = wall;
  let cursor = ox;
  // four walls; a couple of laps is far more than any single pointermove needs
  for (let guard = 0; guard < 8; guard++) {
    const limit = Math.max(0, wallFrame(cur, maxSeat).span / 2 - halfW);
    if (cursor > limit) {
      const over = cursor - limit;
      cur = nextWall(cur, 1);
      cursor = -Math.max(0, wallFrame(cur, maxSeat).span / 2 - halfW) + over;
    } else if (cursor < -limit) {
      const over = -limit - cursor;
      cur = nextWall(cur, -1);
      cursor = Math.max(0, wallFrame(cur, maxSeat).span / 2 - halfW) - over;
    } else {
      return { wall: cur, ox: cursor };
    }
  }
  return { wall: cur, ox: THREE.MathUtils.clamp(cursor, -wallFrame(cur, maxSeat).span / 2, wallFrame(cur, maxSeat).span / 2) };
}

/** Height range for an item of half-height `halfH`: clear of floor and ceiling. */
export function wallHeightRange(halfH: number): [number, number] {
  const margin = 0.1;
  const min = Math.min(halfH + margin, ROOM_HEIGHT / 2);
  const max = Math.max(min, ROOM_HEIGHT - halfH - margin);
  return [min, max];
}
