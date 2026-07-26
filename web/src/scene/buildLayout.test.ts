import { describe, expect, it } from 'vitest';
import type { OfficeLayout } from '../../../shared/types.ts';
import { BACK_Z, roomDims, seatTransform } from './layout.ts';
import { VISTA_LAYERS } from './vistaLayers.ts';
import {
  GRID,
  MIN_BACK_WINDOW_OX,
  ROT_SNAP,
  clampPoseToRoom,
  deskFootprint,
  defaultWallOffset,
  isPlacementValid,
  isWallPlacementValid,
  obbFromPose,
  obbIntersects,
  resolveFurniture,
  resolveSeat,
  resolveWallOffset,
  snapPose,
  wallOffsetRange,
  WALL_ITEMS,
} from './buildLayout.ts';

const { width } = roomDims(3);

describe('snapPose', () => {
  it('rounds x/z to the grid and rotY to the rotation step', () => {
    const p = snapPose({ x: 1.29, z: -0.31, rotY: 0.8 });
    expect(p.x).toBeCloseTo(1.2, 6);
    expect(p.z).toBeCloseTo(-0.4, 6);
    expect(p.rotY).toBeCloseTo(Math.round(0.8 / ROT_SNAP) * ROT_SNAP, 6);
  });

  it('uses a 0.2 grid and 15° rotation step', () => {
    expect(GRID).toBeCloseTo(0.2, 6);
    expect(ROT_SNAP).toBeCloseTo(Math.PI / 12, 6);
  });
});

describe('obbIntersects', () => {
  it('detects overlap of axis-aligned rectangles', () => {
    const a = obbFromPose({ x: 0, z: 0, rotY: 0 }, { w: 2, d: 2, cz: 0 });
    const b = obbFromPose({ x: 1.5, z: 0, rotY: 0 }, { w: 2, d: 2, cz: 0 });
    expect(obbIntersects(a, b)).toBe(true);
  });

  it('clears separated axis-aligned rectangles', () => {
    const a = obbFromPose({ x: 0, z: 0, rotY: 0 }, { w: 2, d: 2, cz: 0 });
    const b = obbFromPose({ x: 2.5, z: 0, rotY: 0 }, { w: 2, d: 2, cz: 0 });
    expect(obbIntersects(a, b)).toBe(false);
  });

  it('rotation changes the answer: a long rect only reaches its neighbor when turned', () => {
    const fp = { w: 2.6, d: 1.0, cz: 0 };
    const near = { x: 0, z: 1.4, rotY: 0 };
    expect(obbIntersects(obbFromPose({ x: 0, z: 0, rotY: 0 }, fp), obbFromPose(near, fp))).toBe(false);
    expect(obbIntersects(obbFromPose({ x: 0, z: 0, rotY: Math.PI / 2 }, fp), obbFromPose(near, fp))).toBe(true);
  });

  it('respects the footprint center offset (cz)', () => {
    // same origin distance, but the offset shifts A's rectangle away from B
    const a = obbFromPose({ x: 0, z: 0, rotY: 0 }, { w: 1, d: 1, cz: -2 });
    const b = obbFromPose({ x: 0, z: 0.6, rotY: 0 }, { w: 1, d: 1, cz: 0 });
    expect(obbIntersects(a, b)).toBe(false);
    const c = obbFromPose({ x: 0, z: 0, rotY: 0 }, { w: 1, d: 1, cz: 0 });
    expect(obbIntersects(c, b)).toBe(true);
  });
});

describe('defaults', () => {
  for (const maxSeat of [3, 9]) {
    it(`never self-collide at maxSeat ${maxSeat}`, () => {
      const obbs: Array<{ id: string; obb: ReturnType<typeof obbFromPose> }> = [];
      for (let seat = 0; seat <= maxSeat; seat++) {
        const { position, rotationY } = resolveSeat(undefined, seat, maxSeat);
        obbs.push({
          id: `seat${seat}`,
          obb: obbFromPose({ x: position.x, z: position.z, rotY: rotationY }, deskFootprint(seat === 0)),
        });
      }
      for (const f of resolveFurniture(undefined, maxSeat)) {
        if (f.collides) obbs.push({ id: f.id, obb: obbFromPose(f.pose, f.footprint) });
      }
      for (let i = 0; i < obbs.length; i++) {
        for (let j = i + 1; j < obbs.length; j++) {
          expect(obbIntersects(obbs[i].obb, obbs[j].obb), `${obbs[i].id} vs ${obbs[j].id}`).toBe(false);
        }
      }
    });

    it(`stay inside the room at maxSeat ${maxSeat}`, () => {
      const { width: w, depth, centerZ } = roomDims(maxSeat);
      const frontZ = centerZ + depth / 2;
      for (const f of resolveFurniture(undefined, maxSeat)) {
        const clamped = clampPoseToRoom(f.pose, f.footprint, maxSeat);
        expect(clamped.x, f.id).toBeCloseTo(f.pose.x, 6);
        expect(clamped.z, f.id).toBeCloseTo(f.pose.z, 6);
        expect(Math.abs(f.pose.x)).toBeLessThan(w / 2);
        expect(f.pose.z).toBeGreaterThan(BACK_Z);
        expect(f.pose.z).toBeLessThan(frontZ);
      }
    });
  }
});

describe('resolveSeat', () => {
  it('falls back to the classroom grid without an override', () => {
    const def = seatTransform(4);
    const r = resolveSeat(undefined, 4, 9);
    expect(r.position.toArray()).toEqual(def.position.toArray());
    expect(r.rotationY).toBe(def.rotationY);
  });

  it('applies an override', () => {
    const layout: OfficeLayout = { seats: { 1: { x: 2.2, z: -1.4, rotY: Math.PI / 2 } } };
    const r = resolveSeat(layout, 1, 3);
    expect(r.position.x).toBeCloseTo(2.2, 6);
    expect(r.position.z).toBeCloseTo(-1.4, 6);
    expect(r.position.y).toBe(0);
    expect(r.rotationY).toBeCloseTo(Math.PI / 2, 6);
  });

  it('clamps an override back inside the current room', () => {
    const layout: OfficeLayout = { seats: { 1: { x: 40, z: 40, rotY: 0 } } };
    const { position } = resolveSeat(layout, 1, 3);
    const { width: w, depth, centerZ } = roomDims(3);
    expect(Math.abs(position.x)).toBeLessThan(w / 2);
    expect(position.z).toBeLessThan(centerZ + depth / 2);
    expect(position.z).toBeGreaterThan(BACK_Z);
  });
});

describe('resolveFurniture', () => {
  it('applies an override to the matching id only', () => {
    const layout: OfficeLayout = { furniture: { couch: { x: 3, z: 3, rotY: 0 } } };
    const items = resolveFurniture(layout, 3);
    const couch = items.find((f) => f.id === 'couch')!;
    expect(couch.pose).toMatchObject({ x: 3, z: 3, rotY: 0 });
    const defaults = resolveFurniture(undefined, 3);
    for (const f of items) {
      if (f.id === 'couch') continue;
      expect(f.pose, f.id).toEqual(defaults.find((d) => d.id === f.id)!.pose);
    }
  });

  it('ignores overrides for unknown ids', () => {
    const layout: OfficeLayout = { furniture: { jacuzzi: { x: 0, z: 0, rotY: 0 } } };
    expect(resolveFurniture(layout, 3).map((f) => f.id)).toEqual(
      resolveFurniture(undefined, 3).map((f) => f.id),
    );
  });

  it('keeps lamp lights attached via a relative offset', () => {
    const lamp = resolveFurniture(undefined, 3).find((f) => f.id === 'lampBack')!;
    expect(lamp.light).toBeTruthy();
    expect(lamp.light!.offset[1]).toBeGreaterThan(1);
  });
});

describe('wall items', () => {
  it('defaults match the historical hardcoded offsets', () => {
    expect(defaultWallOffset('windowBack', 3)).toBeCloseTo(-width / 4, 6);
    // was 4.5 before the TV moved in; 1.5 keeps window and TV non-colliding at every room size
    expect(defaultWallOffset('windowLeft', 3)).toBeCloseTo(1.5, 6);
    expect(defaultWallOffset('wallArt', 3)).toBeCloseTo(width / 4 + 0.5, 6);
  });

  it('has a tv item on the left wall, forward of the back corner', () => {
    expect(WALL_ITEMS.find((w) => w.id === 'tv')).toMatchObject({ wall: 'left', halfW: 1.5 });
    // constant along-wall offset, so the TV slides toward the employees as the room
    // grows rather than staying pinned near the back corner
    for (const maxSeat of [3, 12]) {
      expect(defaultWallOffset('tv', maxSeat)).toBeCloseTo(5.0, 6);
    }
    // ...and it always clears the back wall it used to hug
    for (const maxSeat of [3, 12]) {
      const { centerZ } = roomDims(maxSeat);
      expect(centerZ - defaultWallOffset('tv', maxSeat)).toBeGreaterThan(BACK_Z + 1.9);
    }
  });

  it('the tv and windowLeft defaults are both valid placements at small and large room sizes', () => {
    for (const maxSeat of [3, 12]) {
      expect(isWallPlacementValid(undefined, 'tv', defaultWallOffset('tv', maxSeat), maxSeat)).toBe(true);
      expect(isWallPlacementValid(undefined, 'windowLeft', defaultWallOffset('windowLeft', maxSeat), maxSeat)).toBe(true);
    }
  });

  it('rejects moving windowLeft onto the tv span', () => {
    // within windowLeft's own legal range, but overlapping the tv's default span
    expect(isWallPlacementValid(undefined, 'windowLeft', 4.5, 3)).toBe(false);
  });

  it('resolveWallOffset returns the override when in range', () => {
    const layout: OfficeLayout = { wallItems: { wallArt: 2.0 } };
    expect(resolveWallOffset(layout, 'wallArt', 3)).toBeCloseTo(2.0, 6);
  });

  it('clamps overrides to the wall range', () => {
    const layout: OfficeLayout = { wallItems: { wallArt: 100, windowLeft: -100 } };
    const [artMin, artMax] = wallOffsetRange('wallArt', 3);
    expect(resolveWallOffset(layout, 'wallArt', 3)).toBeCloseTo(artMax, 6);
    const [leftMin] = wallOffsetRange('windowLeft', 3);
    expect(resolveWallOffset(layout, 'windowLeft', 3)).toBeCloseTo(leftMin, 6);
    expect(artMin).toBeLessThan(artMax);
  });

  it('the back window can never cross the vista invariant', () => {
    const layout: OfficeLayout = { wallItems: { windowBack: -100 } };
    const ox = resolveWallOffset(layout, 'windowBack', 3);
    expect(ox).toBeGreaterThanOrEqual(MIN_BACK_WINDOW_OX - 1e-9);
    // at the clamp limit, every parallax layer's left edge stays clear of the
    // left wall plane (world -width/2) with the same 0.1 margin vistaLayers uses
    for (const layer of VISTA_LAYERS.back) {
      expect(MIN_BACK_WINDOW_OX + layer.x - layer.w / 2).toBeGreaterThanOrEqual(-width / 2 + 0.1 - 1e-9);
    }
  });

  it('rejects same-wall overlap but allows cross-wall coexistence', () => {
    // wall art dropped onto the back window (both on the back wall)
    expect(isWallPlacementValid(undefined, 'wallArt', defaultWallOffset('windowBack', 3), 3)).toBe(false);
    // defaults are valid placements
    expect(isWallPlacementValid(undefined, 'wallArt', defaultWallOffset('wallArt', 3), 3)).toBe(true);
    // the left window shares no wall with the back-wall items
    expect(isWallPlacementValid(undefined, 'windowLeft', defaultWallOffset('windowBack', 3), 3)).toBe(true);
  });

  it('places the employee-of-the-month frame on the back wall without overlapping', () => {
    for (const maxSeat of [3, 6, 12]) {
      const ox = defaultWallOffset('eotm', maxSeat);
      expect(isWallPlacementValid(undefined, 'eotm', ox, maxSeat)).toBe(true);
    }
  });

  it('keeps every default back-wall item mutually valid', () => {
    for (const id of ['windowBack', 'wallArt', 'eotm']) {
      expect(isWallPlacementValid(undefined, id, defaultWallOffset(id, 6), 6)).toBe(true);
    }
  });
});

describe('isPlacementValid', () => {
  const seats = [0, 1, 2, 3];

  it('rejects a desk dropped onto another desk', () => {
    const s2 = seatTransform(2);
    expect(
      isPlacementValid(undefined, { kind: 'seat', key: 1, pose: { x: s2.position.x, z: s2.position.z, rotY: Math.PI } }, seats, 3),
    ).toBe(false);
  });

  it('accepts a desk in free space', () => {
    expect(
      isPlacementValid(undefined, { kind: 'seat', key: 1, pose: { x: 3.0, z: 4.2, rotY: Math.PI } }, seats, 3),
    ).toBe(true);
  });

  it('rejects a pose hanging outside the room', () => {
    expect(
      isPlacementValid(undefined, { kind: 'seat', key: 1, pose: { x: width / 2, z: 4.2, rotY: 0 } }, seats, 3),
    ).toBe(false);
  });

  it('rejects furniture dropped onto a desk', () => {
    const s1 = seatTransform(1);
    expect(
      isPlacementValid(undefined, { kind: 'furniture', key: 'couch', pose: { x: s1.position.x, z: s1.position.z, rotY: 0 } }, seats, 3),
    ).toBe(false);
  });

});

describe('self-exclusion', () => {
  it('a nudged desk only fails when it reaches a neighbor, not because of its own old spot', () => {
    const seats = [0, 1];
    const s1 = seatTransform(1);
    // tiny nudge overlapping its own default position — must be valid (self excluded)
    expect(
      isPlacementValid(undefined, { kind: 'seat', key: 1, pose: { x: s1.position.x + 0.2, z: s1.position.z, rotY: Math.PI } }, seats, 3),
    ).toBe(true);
  });

  it('furniture excludes itself too', () => {
    const couch = resolveFurniture(undefined, 3).find((f) => f.id === 'couch')!;
    expect(
      isPlacementValid(undefined, { kind: 'furniture', key: 'couch', pose: { ...couch.pose, z: couch.pose.z + 0.2 } }, [0, 1, 2, 3], 3),
    ).toBe(true);
  });
});

describe('clampPoseToRoom', () => {
  it('leaves an in-room pose untouched', () => {
    const p = { x: 1, z: 1, rotY: 0.3 };
    expect(clampPoseToRoom(p, { w: 1, d: 1, cz: 0 }, 3)).toEqual(p);
  });

  it('pulls a far-outside pose fully back inside', () => {
    const fp = { w: 2.4, d: 2.6, cz: -0.7 };
    const p = clampPoseToRoom({ x: 100, z: -100, rotY: 0 }, fp, 3);
    const { width: w } = roomDims(3);
    // rectangle extents must fit: check via placement bounds (no collision involved)
    expect(Math.abs(p.x)).toBeLessThan(w / 2);
    expect(p.z).toBeGreaterThan(BACK_Z);
  });
});
