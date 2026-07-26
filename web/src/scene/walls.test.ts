import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WALL_SIDES } from '../../../shared/types.ts';
import { BACK_Z, ROOM_HEIGHT, roomDims } from './layout.ts';
import { carryAroundCorner, nextWall, wallFrame, wallHeightRange, wallPlaneHit, wallToWorld } from './walls.ts';

const MS = 3; // maxSeat
const { width, depth, centerZ } = roomDims(MS);

describe('wallFrame', () => {
  it('puts each wall on its own plane, facing into the room', () => {
    expect(wallFrame('back', MS).origin.z).toBeCloseTo(BACK_Z, 6);
    expect(wallFrame('front', MS).origin.z).toBeCloseTo(centerZ + depth / 2, 6);
    expect(wallFrame('left', MS).origin.x).toBeCloseTo(-width / 2, 6);
    expect(wallFrame('right', MS).origin.x).toBeCloseTo(width / 2, 6);
    // every normal points at the middle of the room
    for (const side of WALL_SIDES) {
      const f = wallFrame(side, MS);
      const toCentre = new THREE.Vector3(0, 0, centerZ).sub(f.origin).setY(0).normalize();
      expect(f.normal.dot(toCentre), side).toBeGreaterThan(0.99);
    }
  });

  it('spans the room dimension the wall actually runs along', () => {
    expect(wallFrame('back', MS).span).toBeCloseTo(width, 6);
    expect(wallFrame('front', MS).span).toBeCloseTo(width, 6);
    expect(wallFrame('left', MS).span).toBeCloseTo(depth, 6);
    expect(wallFrame('right', MS).span).toBeCloseTo(depth, 6);
  });
});

describe('wallToWorld', () => {
  it('keeps the sign conventions the saved layouts were written with', () => {
    // back: ox is world x
    expect(wallToWorld('back', 2, 2.1, MS).x).toBeCloseTo(2, 6);
    // left: ox increases toward the BACK (world z = centerZ - ox)
    expect(wallToWorld('left', 2, 2.1, MS).z).toBeCloseTo(centerZ - 2, 6);
    // right: ox increases toward the FRONT (world z = centerZ + ox)
    expect(wallToWorld('right', 2, 2.1, MS).z).toBeCloseTo(centerZ + 2, 6);
    // front: ox increases toward -x
    expect(wallToWorld('front', 2, 2.1, MS).x).toBeCloseTo(-2, 6);
  });

  it('carries height through untouched', () => {
    expect(wallToWorld('back', 0, 3.3, MS).y).toBeCloseTo(3.3, 6);
  });
});

describe('the perimeter chain', () => {
  /** The world point at a wall's far (+ox) end, and the next wall's near (−ox) end. */
  const farEnd = (side: (typeof WALL_SIDES)[number]) =>
    wallToWorld(side, wallFrame(side, MS).span / 2, 2, MS);
  const nearEnd = (side: (typeof WALL_SIDES)[number]) =>
    wallToWorld(side, -wallFrame(side, MS).span / 2, 2, MS);

  it('joins each wall end to the start of the next, all the way round', () => {
    for (const side of WALL_SIDES) {
      const next = nextWall(side, 1);
      expect(farEnd(side).distanceTo(nearEnd(next)), `${side} → ${next}`).toBeLessThan(1e-6);
    }
  });

  it('closes the loop: four steps forward returns to the same wall', () => {
    for (const side of WALL_SIDES) {
      expect(nextWall(nextWall(nextWall(nextWall(side, 1), 1), 1), 1)).toBe(side);
      expect(nextWall(nextWall(side, 1), -1)).toBe(side);
    }
  });
});

describe('carryAroundCorner', () => {
  it('leaves an in-range offset exactly where it is', () => {
    expect(carryAroundCorner('back', 1.5, MS)).toEqual({ wall: 'back', ox: 1.5 });
  });

  it('carries the overflow onto the next wall, preserving distance travelled', () => {
    const span = wallFrame('back', MS).span / 2;
    const nextSpan = wallFrame('right', MS).span / 2;
    const r = carryAroundCorner('back', span + 0.75, MS);
    expect(r.wall).toBe('right');
    expect(r.ox).toBeCloseTo(-nextSpan + 0.75, 6);
  });

  it('carries backwards off the near end onto the previous wall', () => {
    const span = wallFrame('back', MS).span / 2;
    const prevSpan = wallFrame('left', MS).span / 2;
    const r = carryAroundCorner('back', -span - 0.75, MS);
    expect(r.wall).toBe('left');
    expect(r.ox).toBeCloseTo(prevSpan - 0.75, 6);
  });

  it('is continuous across the seam: a step over the corner is a step in world space', () => {
    const span = wallFrame('back', MS).span / 2;
    const before = carryAroundCorner('back', span - 0.05, MS);
    const after = carryAroundCorner('back', span + 0.05, MS);
    expect(after.wall).not.toBe(before.wall);
    const a = wallToWorld(before.wall, before.ox, 2, MS);
    const b = wallToWorld(after.wall, after.ox, 2, MS);
    // 0.1 units apart along the perimeter, around a right-angled corner
    expect(a.distanceTo(b)).toBeLessThan(0.15);
  });

  it('survives a flick that outruns a whole wall in one move', () => {
    const r = carryAroundCorner('back', wallFrame('back', MS).span * 3, MS);
    expect(WALL_SIDES).toContain(r.wall);
    const span = wallFrame(r.wall, MS).span / 2;
    expect(r.ox).toBeGreaterThanOrEqual(-span - 1e-9);
    expect(r.ox).toBeLessThanOrEqual(span + 1e-9);
  });

  it('transfers when the item EDGE reaches the corner, not its centre', () => {
    const span = wallFrame('back', MS).span / 2;
    const halfW = 1.7;
    // centre still on the back wall, but its edge is past the corner
    expect(carryAroundCorner('back', span - halfW + 0.1, MS, halfW).wall).toBe('right');
    expect(carryAroundCorner('back', span - halfW - 0.1, MS, halfW).wall).toBe('back');
  });

  it('goes all the way around and comes back to where it started', () => {
    const perimeter = 2 * (width + depth);
    let cur = { wall: 'back' as (typeof WALL_SIDES)[number], ox: 0 };
    const start = wallToWorld(cur.wall, cur.ox, 2, MS);
    // walk the full perimeter in small steps
    for (let i = 0; i < perimeter / 0.5; i++) {
      cur = carryAroundCorner(cur.wall, cur.ox + 0.5, MS);
    }
    const end = wallToWorld(cur.wall, cur.ox, 2, MS);
    expect(end.distanceTo(start)).toBeLessThan(0.6); // within one step of home
  });
});

describe('wallPlaneHit', () => {
  it('round-trips a point on a wall back to the offsets that made it', () => {
    for (const side of WALL_SIDES) {
      const target = wallToWorld(side, 1.4, 2.6, MS);
      // aim from the middle of the room at that point
      const origin = new THREE.Vector3(0, 2, centerZ);
      const hit = wallPlaneHit({ origin, direction: target.clone().sub(origin).normalize() }, side, MS);
      expect(hit, side).not.toBeNull();
      expect(hit!.ox, side).toBeCloseTo(1.4, 5);
      expect(hit!.oy, side).toBeCloseTo(2.6, 5);
    }
  });

  it('returns null for a ray pointing away from the wall', () => {
    const origin = new THREE.Vector3(0, 2, centerZ);
    const hit = wallPlaneHit({ origin, direction: new THREE.Vector3(0, 0, 1) }, 'back', MS);
    expect(hit).toBeNull();
  });

  it('returns an offset past the wall end rather than clamping — that is what drives transfers', () => {
    const origin = new THREE.Vector3(0, 2, centerZ);
    const beyond = new THREE.Vector3(width, 2, BACK_Z);
    const hit = wallPlaneHit({ origin, direction: beyond.clone().sub(origin).normalize() }, 'back', MS);
    expect(hit!.ox).toBeGreaterThan(width / 2);
  });
});

describe('wallHeightRange', () => {
  it('keeps an item clear of the floor and the ceiling', () => {
    const [min, max] = wallHeightRange(1.075);
    expect(min).toBeGreaterThan(1.075);
    expect(max).toBeLessThan(ROOM_HEIGHT - 1.075);
  });

  it('never inverts for an absurdly tall item', () => {
    const [min, max] = wallHeightRange(ROOM_HEIGHT * 2);
    expect(max).toBeGreaterThanOrEqual(min);
  });
});
