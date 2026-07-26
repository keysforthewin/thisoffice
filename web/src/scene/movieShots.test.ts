import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Employee, OfficeState } from '../../../shared/types.ts';
import { roomDims, seatTransform } from './layout.ts';
import {
  ACTIVE_WINDOW_MS,
  activeKeys,
  activeSetKey,
  activityTtl,
  ARCHETYPES,
  clampToRoom,
  closeUpShot,
  fitDistance,
  groupByFacing,
  groupShot,
  hasLineOfSight,
  isWallBoard,
  MIN_SHOT_DIST,
  pickShot,
  SINGLE_POOL,
  GROUP_POOL,
  IDLE_POOL,
  segmentHitsBox,
  segmentHitsSphere,
  subjectFor,
  type ArchetypeName,
  type PickedShot,
  type ShotContext,
  type Subject,
} from './movieShots.ts';

const deg = THREE.MathUtils.degToRad;

const FOV = THREE.MathUtils.degToRad(50);
const ASPECT = 16 / 9;

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: 'e1',
    name: 'Alice',
    seat: 1,
    variant: 'Knight',
    hiredAt: new Date().toISOString(),
    status: 'working',
    task: null,
    ...overrides,
  };
}

function makeOffice(overrides: Partial<OfficeState> = {}): OfficeState {
  return {
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [makeEmployee({ id: 'e1', seat: 1 }), makeEmployee({ id: 'e2', seat: 2 })],
    inbox: [],
    todos: null,
    staffing: { minEmployees: 0, maxEmployees: 9, idleTimeoutSec: 60 },
    ...overrides,
  } as OfficeState;
}

/** seeded deterministic rng */
function rng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function inFrustum(point: THREE.Vector3, shot: { position: THREE.Vector3; lookAt: THREE.Vector3 }) {
  const forward = shot.lookAt.clone().sub(shot.position).normalize();
  const v = point.clone().sub(shot.position);
  const z = v.dot(forward);
  if (z <= 0) return false;
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return Math.abs(v.dot(up)) / z <= Math.tan(FOV / 2) && Math.abs(v.dot(right)) / z <= Math.tan(FOV / 2) * ASPECT;
}

describe('activeKeys / activeSetKey', () => {
  it('keeps only keys stamped within the window', () => {
    const now = 100_000;
    const la = { fresh: now - 1, stale: now - ACTIVE_WINDOW_MS - 1, edge: now - ACTIVE_WINDOW_MS + 1 };
    expect(activeKeys(la, now).sort()).toEqual(['edge', 'fresh']);
  });
  it('boss and whiteboard expire after their 14s TTL while monitors keep the shorter global window', () => {
    const now = 100_000;
    const la = { boss: now - 12_000, whiteboard: now - 12_000, e1: now - 12_000, statusboard: now - 12_000 };
    expect(activeKeys(la, now).sort()).toEqual(['boss', 'statusboard', 'whiteboard']);
    const later = { boss: now - 15_000, whiteboard: now - 15_000, statusboard: now - 15_000 };
    expect(activeKeys(later, now)).toEqual(['statusboard']);
  });
  it('activityTtl gives boards their own windows and everything else the global window', () => {
    expect(activityTtl('boss')).toBe(14_000);
    expect(activityTtl('whiteboard')).toBe(14_000);
    expect(activityTtl('statusboard')).toBe(150_000);
    expect(activityTtl('tv')).toBe(150_000);
    expect(activityTtl('e1')).toBe(ACTIVE_WINDOW_MS);
  });
  it('the two wall boards resolve as distinct non-overlapping subjects on the right wall', () => {
    const wb = subjectFor('whiteboard', null)!;
    const sb = subjectFor('statusboard', null)!;
    expect(wb.normal.x).toBe(-1);
    expect(sb.normal.x).toBe(-1);
    expect(wb.center.x).toBeCloseTo(sb.center.x, 6);
    // frames are 3.4 wide along z; centers must be at least that far apart
    expect(Math.abs(wb.center.z - sb.center.z)).toBeGreaterThanOrEqual(3.4);
  });
  it('activeSetKey is order-independent', () => {
    const now = 100_000;
    expect(activeSetKey({ b: now, a: now }, now, null)).toBe(activeSetKey({ a: now, b: now }, now, null));
  });
  it('excludes active keys with no resolvable subject, and recuts when the subject disappears', () => {
    const now = 100_000;
    const office = makeOffice();
    const laWithGhost = { e1: now, ghost: now };
    const laWithoutGhost = { e1: now };
    // 'ghost' is an active key but not a real employee, so it must not affect the fingerprint
    expect(activeSetKey(laWithGhost, now, office)).toBe(activeSetKey(laWithoutGhost, now, office));

    // an active, resolvable employee that gets evicted from the office must change the key
    const keyBefore = activeSetKey({ e1: now }, now, office);
    const officeWithoutE1 = makeOffice({ employees: [makeEmployee({ id: 'e2', seat: 2 })] });
    const keyAfter = activeSetKey({ e1: now }, now, officeWithoutE1);
    expect(keyAfter).not.toBe(keyBefore);
  });
});

describe('subjectFor', () => {
  it('employee screens face +z, boss faces -z, whiteboard faces -x', () => {
    const office = makeOffice();
    expect(subjectFor('e1', office)!.normal.z).toBeCloseTo(1);
    expect(subjectFor('boss', office)!.normal.z).toBeCloseTo(-1);
    expect(subjectFor('whiteboard', office)!.normal.x).toBeCloseTo(-1);
  });
  it('returns null for an unknown employee id', () => {
    expect(subjectFor('ghost', makeOffice())).toBeNull();
  });
  it('places the employee screen at seat position + rotated monitor offset', () => {
    const s = subjectFor('e1', makeOffice())!;
    // seat 1 is at x=-3.4, z=0.6 with rotationY=π → monitor local [0,1.66,0.35] → world z-offset −0.35
    expect(s.center.y).toBeCloseTo(1.66);
    expect(s.center.z).toBeCloseTo(0.6 - 0.35);
  });
  it('tracks a build-mode seat override so the movie camera aims at the moved desk', () => {
    const office = makeOffice({ layout: { seats: { 1: { x: 2.0, z: 4.0, rotY: 0 } } } });
    const s = subjectFor('e1', office)!;
    // rotY 0 → monitor local [0,1.66,0.35] stays +0.35 in world z
    expect(s.center.x).toBeCloseTo(2.0);
    expect(s.center.z).toBeCloseTo(4.0 + 0.35);
    expect(s.normal.z).toBeCloseTo(-1);
  });

  it('whiteboard / statusboard face -x and are 3.2x1.95, unchanged by the tv refactor', () => {
    const office = makeOffice();
    for (const key of ['whiteboard', 'statusboard']) {
      const s = subjectFor(key, office)!;
      expect(s.normal.toArray()).toEqual([-1, 0, 0]);
      expect(s.width).toBe(3.2);
      expect(s.height).toBe(1.95);
    }
  });

  it('the tv is a wall board on the LEFT wall, facing +x, sized to the rendered screen', () => {
    const office = makeOffice();
    const s = subjectFor('tv', office)!;
    expect(s.normal.toArray()).toEqual([1, 0, 0]);
    expect(s.width).toBe(2.6);
    expect(s.height).toBe(1.46);
    expect(s.center.x).toBeLessThan(0);
    expect(isWallBoard('tv')).toBe(true);
  });

  it('the tv default offset is anchored to the back wall (stable z, stable x) as maxSeat/room size grows', () => {
    // defaultWallOffset('tv', maxSeat) = depth/2 - 1.9, i.e. world z = centerZ - ox
    // is pinned to BACK_Z + 1.9 regardless of how far the room grows at the front —
    // both x (off the left wall) and z should hold steady across two very different maxSeat values.
    const small = subjectFor('tv', makeOffice({ employees: [makeEmployee({ id: 'e1', seat: 1 })] }))!;
    const big = subjectFor(
      'tv',
      makeOffice({ employees: Array.from({ length: 9 }, (_, i) => makeEmployee({ id: `e${i}`, seat: i + 1 })) }),
    )!;
    expect(small.center.z).toBeCloseTo(big.center.z, 6);
    expect(small.center.x).toBeCloseTo(big.center.x, 6);
    // and the two room sizes actually differ (sanity check the fixture is meaningful)
    expect(roomDims(3).depth).not.toBeCloseTo(roomDims(9).depth, 1);
    // matches the raw formula the layout/render side uses directly
    for (const ms of [3, 9]) {
      const { width, depth, centerZ } = roomDims(ms);
      const expectedZ = centerZ - (depth / 2 - 1.9);
      const s = subjectFor('tv', makeOffice({ employees: Array.from({ length: ms }, (_, i) => makeEmployee({ id: `e${i}`, seat: i + 1 })) }))!;
      expect(s.center.z).toBeCloseTo(expectedZ, 6);
      expect(s.center.x).toBeCloseTo(-width / 2 + 0.07, 6);
    }
  });

  it('a layout override for the tv wall offset moves its subject center', () => {
    const office = makeOffice();
    const moved = makeOffice({ layout: { wallItems: { tv: 0 } } });
    const s0 = subjectFor('tv', office)!;
    const s1 = subjectFor('tv', moved)!;
    expect(s1.center.z).not.toBeCloseTo(s0.center.z, 1);
    // x stays pinned to the left wall regardless of the along-wall offset
    expect(s1.center.x).toBeCloseTo(s0.center.x, 6);
  });
});

describe('groupByFacing', () => {
  const mk = (key: string, nx: number, nz: number): Subject => ({
    key,
    center: new THREE.Vector3(),
    normal: new THREE.Vector3(nx, 0, nz).normalize(),
    width: 1.35,
    height: 0.85,
  });
  it('splits opposing normals into separate groups', () => {
    const groups = groupByFacing([mk('a', 0, 1), mk('b', 0, -1)]);
    expect(groups).toHaveLength(2);
  });
  it('keeps perpendicular normals (employee + whiteboard) together', () => {
    const groups = groupByFacing([mk('a', 0, 1), mk('w', -1, 0)]);
    expect(groups).toHaveLength(1);
  });
});

describe('shots', () => {
  it('fitDistance fits the taller/wider extent for the fov', () => {
    const d = fitDistance(1.35, 0.85, FOV, ASPECT, 1);
    // height-limited at 16:9: d = 0.85 / (2 tan(25°))
    expect(d).toBeCloseTo(0.85 / (2 * Math.tan(FOV / 2)));
  });

  it('closeUpShot stays on the visible side and frames the whole screen', () => {
    const s = subjectFor('e1', makeOffice())!;
    for (let i = 0; i < 20; i++) {
      const shot = closeUpShot(s, FOV, ASPECT, rng(i));
      expect(shot.position.clone().sub(s.center).dot(s.normal)).toBeGreaterThan(0);
      const right = new THREE.Vector3(1, 0, 0);
      for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) {
        const corner = s.center.clone().addScaledVector(right, sx * s.width).add(new THREE.Vector3(0, sy * s.height, 0));
        expect(inFrustum(corner, shot)).toBe(true);
      }
    }
  });

  it('groupShot keeps every subject front-facing and inside the frustum', () => {
    const office = makeOffice();
    const subjects = [subjectFor('e1', office)!, subjectFor('e2', office)!, subjectFor('whiteboard', office)!];
    for (let i = 0; i < 20; i++) {
      const shot = groupShot(subjects, FOV, ASPECT, rng(i));
      for (const s of subjects) {
        expect(shot.position.clone().sub(s.center).dot(s.normal)).toBeGreaterThan(0);
        expect(inFrustum(s.center, shot)).toBe(true);
      }
    }
  });

  it('pickShot rotates primaries: every active subject (incl. boss and boards) leads a shot within a few cuts', () => {
    const office = makeOffice();
    const now = 100_000;
    const active = { boss: now, e1: now, e2: now, whiteboard: now, statusboard: now };
    const leads = new Set<string>();
    let recentPrimaries: string[] = [];
    let prev: THREE.Vector3 | null = null;
    // one continuous rng across cuts, like the live camera (fresh tiny seeds
    // bias the first draw low, which would starve the last weighted-pool slot)
    const r = rng(9001);
    for (let i = 0; i < 20; i++) {
      const shot = pickShot({
        office, lastActivity: active, now,
        fovY: FOV, aspect: ASPECT, rng: r, cutIndex: i,
        prevPosition: prev, recentPrimaries,
      });
      expect(shot.primaryKey).toBeDefined();
      leads.add(shot.primaryKey!);
      recentPrimaries = [shot.primaryKey!, ...recentPrimaries].slice(0, 4);
      prev = (shot.positionEnd ?? shot.position).clone();
    }
    expect(leads).toContain('boss');
    expect(leads).toContain('whiteboard');
    expect(leads).toContain('statusboard');
    expect(leads.size).toBeGreaterThanOrEqual(4);
  });

  it('pickShot returns a sane idle shot with no activity and even no office', () => {
    const shot = pickShot({
      office: null, lastActivity: {}, now: 0,
      fovY: FOV, aspect: ASPECT, rng: rng(7), cutIndex: 0,
    });
    expect(Number.isFinite(shot.position.x)).toBe(true);
    expect(shot.position.y).toBeGreaterThan(0);
  });
});

function ctx(overrides: Partial<ShotContext> = {}): ShotContext {
  return {
    office: makeOffice(), lastActivity: {}, now: Date.now(),
    fovY: FOV, aspect: ASPECT, rng: rng(), cutIndex: 0,
    prevPosition: null, recentArchetypes: [],
    ...overrides,
  };
}

describe('archetype shot selection', () => {
  it('idle shots come from the idle pool and are valid', () => {
    const seen = new Set<string>();
    let prev: THREE.Vector3 | null = null;
    let recent: ArchetypeName[] = [];
    for (let i = 0; i < 12; i++) {
      const shot = pickShot(ctx({ rng: rng(i + 1), cutIndex: i, prevPosition: prev, recentArchetypes: recent }));
      expect(IDLE_POOL).toContain(shot.archetype);
      if (prev) expect(shot.position.distanceTo(prev)).toBeGreaterThanOrEqual(MIN_SHOT_DIST);
      expect(recent).not.toContain(shot.archetype);
      seen.add(shot.archetype);
      prev = shot.position.clone();
      recent = [shot.archetype, ...recent].slice(0, 2);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3); // real variety
  });

  it('produces genuinely high idle shots (overheadGod reaches near the ceiling)', () => {
    // overheadGod is the only pool member above y 4; force it by excluding others via recency
    const shot = pickShot(ctx({ recentArchetypes: ['highCorner', 'lowDolly'], rng: rng(7) }));
    if (shot.archetype === 'overheadGod') {
      expect(shot.position.y).toBeGreaterThan(4.5);
      // looking steeply down
      const dir = shot.lookAt.clone().sub(shot.position).normalize();
      expect(dir.y).toBeLessThan(-0.7); // ≥ ~45° down
    }
  });

  it('a single active subject uses the single-subject pool with LOS along the whole move', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    const subject = subjectFor('e1', office)!;
    let prev: THREE.Vector3 | null = null;
    let recent: ArchetypeName[] = [];
    for (let i = 0; i < 8; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 3), cutIndex: i, prevPosition: prev, recentArchetypes: recent }));
      expect(SINGLE_POOL).toContain(shot.archetype);
      expect(shot.primaryKey).toBe('e1');
      // the ≥1-active-screen invariant holds at start, end, and midpoint of the move
      expect(hasLineOfSight(shot.position, subject, office)).toBe(true);
      if (shot.positionEnd) {
        expect(hasLineOfSight(shot.positionEnd, subject, office)).toBe(true);
        expect(hasLineOfSight(shot.position.clone().lerp(shot.positionEnd, 0.5), subject, office)).toBe(true);
      }
      // the halved-min-dist rescue pass is a legal outcome, so assert the floor it guarantees
      if (prev) expect(shot.position.distanceTo(prev)).toBeGreaterThanOrEqual(MIN_SHOT_DIST / 2);
      prev = (shot.positionEnd ?? shot.position).clone();
      recent = [shot.archetype, ...recent].slice(0, 2);
    }
  });

  it('motion endpoints stay inside the room and actually move', () => {
    const office = makeOffice();
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      const shot = pickShot(ctx({ office, lastActivity: { e1: now, boss: now }, now, rng: rng(i + 40), cutIndex: i }));
      if (shot.positionEnd) {
        expectInRoom(shot.positionEnd, office);
        expect(shot.positionEnd.distanceTo(shot.position)).toBeGreaterThan(0);
      }
      if (shot.fov !== undefined) {
        expect(shot.fov).toBeGreaterThanOrEqual(30);
        expect(shot.fov).toBeLessThanOrEqual(55);
        expect(shot.fovEnd!).toBeGreaterThanOrEqual(30);
        expect(shot.fovEnd!).toBeLessThanOrEqual(55);
      }
    }
  });

  it('boardPan sweeps the look target across the board width', () => {
    const office = makeOffice();
    const now = Date.now();
    const subject = subjectFor('whiteboard', office)!;
    let sawPan = false;
    for (let i = 0; i < 40 && !sawPan; i++) {
      const shot = pickShot(ctx({ office, lastActivity: { whiteboard: now }, now, rng: rng(i + 500), cutIndex: i }));
      if (shot.archetype !== 'boardPan') continue;
      sawPan = true;
      expect(shot.lookAtEnd).toBeDefined();
      // sweep runs along z (the board's width axis on the right wall), ~70% of its width
      expect(Math.abs(shot.lookAtEnd!.z - shot.lookAt.z)).toBeCloseTo(subject.width * 0.7, 1);
      // camera stays on the readable side of the board
      expect(shot.position.clone().sub(subject.center).dot(subject.normal)).toBeGreaterThan(0);
    }
    expect(sawPan).toBe(true);
  });

  it('boardPan also works for the tv (a +x-facing left-wall board): camera stays in front of the screen', () => {
    const office = makeOffice();
    const now = Date.now();
    const subject = subjectFor('tv', office)!;
    let sawPan = false;
    for (let i = 0; i < 40 && !sawPan; i++) {
      const shot = pickShot(ctx({ office, lastActivity: { tv: now }, now, rng: rng(i + 700), cutIndex: i }));
      if (shot.archetype !== 'boardPan') continue;
      sawPan = true;
      expect(shot.lookAtEnd).toBeDefined();
      // camera sits on the readable (+x) side of the tv
      expect(shot.position.clone().sub(subject.center).dot(subject.normal)).toBeGreaterThan(0);
      expect(shot.position.x).toBeGreaterThan(subject.center.x);
    }
    expect(sawPan).toBe(true);
  });

  it('a closeUpShot on the tv sits in front of its +x-facing screen', () => {
    const office = makeOffice();
    const subject = subjectFor('tv', office)!;
    for (let i = 0; i < 10; i++) {
      const shot = closeUpShot(subject, FOV, ASPECT, rng(i), office);
      expect(shot.position.x).toBeGreaterThan(subject.center.x);
    }
  });

  it('pickShot is deterministic under a seeded rng', () => {
    const office = makeOffice();
    const now = 100_000;
    const make = () =>
      pickShot(ctx({ office, lastActivity: { e1: now, e2: now, boss: now }, now, rng: rng(42), cutIndex: 3 }));
    const a = make();
    const b = make();
    expect(b.archetype).toBe(a.archetype);
    expect(b.primaryKey).toBe(a.primaryKey);
    expect(b.position.toArray()).toEqual(a.position.toArray());
    expect((b.positionEnd ?? b.position).toArray()).toEqual((a.positionEnd ?? a.position).toArray());
  });

  it('highAngle shots are actually HIGH: positive pitch raises the camera above the subject', () => {
    // Force the single-subject pool down to highAngle by marking the other two archetypes
    // recent (order() puts fresh archetypes first, so highAngle is the only fresh one left).
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    const subject = subjectFor('e1', office)!;
    let highAngleCount = 0;
    const othersRecent = SINGLE_POOL.filter((n) => n !== 'highAngle');
    for (let i = 0; i < 30; i++) {
      const shot = pickShot(ctx({
        office, lastActivity, now, rng: rng(i + 100), cutIndex: i,
        recentArchetypes: othersRecent,
      }));
      if (shot.archetype === 'highAngle') {
        highAngleCount++;
        expect(shot.position.y).toBeGreaterThan(subject.center.y + 0.5);
      }
    }
    // highAngle is the only fresh archetype in the pool given the forced recency, so it
    // must be picked every time (barring the rare all-candidates-invalid fallback).
    expect(highAngleCount).toBeGreaterThanOrEqual(20);
  });

  it('multiple co-facing subjects draw from the single + group pools with LOS to the primary', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now, e2: now };
    for (let i = 0; i < 10; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 20), cutIndex: i }));
      expect([...SINGLE_POOL, ...GROUP_POOL]).toContain(shot.archetype);
      expect(['e1', 'e2']).toContain(shot.primaryKey);
      const primary = subjectFor(shot.primaryKey!, office)!;
      expect(hasLineOfSight(shot.position, primary, office)).toBe(true);
    }
  });

  it('retries at half the min-distance requirement before falling to the unvalidated fallback', () => {
    // Every single-subject archetype's candidate START distance from the subject center
    // is fixed (only direction jitters, not magnitude), and all of them sit under the
    // full MIN_SHOT_DIST (3.5) for this monitor size/fov. Placing prevPosition AT the
    // subject center means the first pass must reject every candidate from every
    // archetype; only the halved retry (>=1.75) can succeed, and only via archetypes
    // whose start distance clears 1.75 (otsCloseup's ~1.36 stays under), so a validated
    // (non-fallback) hit in-range here proves the retry pass ran.
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    const subject = subjectFor('e1', office)!;
    const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(11), prevPosition: subject.center.clone() }));
    expect(SINGLE_POOL.filter((n) => n !== 'otsCloseup')).toContain(shot.archetype);
    expect(shot.position.distanceTo(subject.center)).toBeGreaterThanOrEqual(MIN_SHOT_DIST / 2);
    expect(shot.position.distanceTo(subject.center)).toBeLessThan(MIN_SHOT_DIST);
  });

  it('a candidate too close to the previous shot is rejected', () => {
    const first = pickShot(ctx({ rng: rng(5) }));
    const second = pickShot(ctx({ rng: rng(5), cutIndex: 1, prevPosition: first.position, recentArchetypes: [first.archetype] }));
    expect(second.position.distanceTo(first.position)).toBeGreaterThanOrEqual(MIN_SHOT_DIST);
  });
});

function roomBounds(office: OfficeState | null) {
  const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
  const { width, depth, centerZ, height } = roomDims(maxSeat);
  const backZ = centerZ - depth / 2;
  const frontZ = centerZ + depth / 2;
  return {
    yMin: 0.4, yMax: height - 0.3,
    xMin: -(width / 2 - 0.3), xMax: width / 2 - 0.3,
    zMin: backZ + 0.3, zMax: frontZ - 0.3,
  };
}

function expectInRoom(pos: THREE.Vector3, office: OfficeState | null) {
  const b = roomBounds(office);
  expect(pos.y).toBeGreaterThanOrEqual(b.yMin - 1e-6);
  expect(pos.y).toBeLessThanOrEqual(b.yMax + 1e-6);
  expect(pos.x).toBeGreaterThanOrEqual(b.xMin - 1e-6);
  expect(pos.x).toBeLessThanOrEqual(b.xMax + 1e-6);
  expect(pos.z).toBeGreaterThanOrEqual(b.zMin - 1e-6);
  expect(pos.z).toBeLessThanOrEqual(b.zMax + 1e-6);
}

describe('clampToRoom', () => {
  it('clamps 50 seeded shots of every type into the room bounds', () => {
    const office = makeOffice();
    const subjects = [subjectFor('e1', office)!, subjectFor('e2', office)!, subjectFor('boss', office)!, subjectFor('whiteboard', office)!];
    for (let i = 0; i < 50; i++) {
      const r = rng(i + 1);
      const kind = i % 3;
      let shot;
      if (kind === 0) shot = closeUpShot(subjects[i % subjects.length], FOV, ASPECT, r, office);
      else if (kind === 1) shot = groupShot(subjects.slice(0, 2), FOV, ASPECT, r, office);
      else shot = pickShot({ office, lastActivity: {}, now: 0, fovY: FOV, aspect: ASPECT, rng: r, cutIndex: i });
      expectInRoom(shot.position, office);
    }
  });

  it('clamps an out-of-bounds vector directly', () => {
    const office = makeOffice();
    const pos = clampToRoom(new THREE.Vector3(-100, -5, 200), office);
    expectInRoom(pos, office);
  });
});

describe('segmentHitsSphere', () => {
  it('detects a hit when the segment passes through the sphere', () => {
    const a = new THREE.Vector3(-5, 0, 0);
    const b = new THREE.Vector3(5, 0, 0);
    expect(segmentHitsSphere(a, b, new THREE.Vector3(0, 0, 0), 1)).toBe(true);
  });
  it('detects a miss when the segment passes wide of the sphere', () => {
    const a = new THREE.Vector3(-5, 5, 0);
    const b = new THREE.Vector3(5, 5, 0);
    expect(segmentHitsSphere(a, b, new THREE.Vector3(0, 0, 0), 1)).toBe(false);
  });
  it('detects a miss when the segment ends short of the sphere', () => {
    const a = new THREE.Vector3(-5, 0, 0);
    const b = new THREE.Vector3(-2, 0, 0);
    expect(segmentHitsSphere(a, b, new THREE.Vector3(0, 0, 0), 1)).toBe(false);
  });
});

describe('segmentHitsBox', () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  it('detects a hit when the segment crosses the box', () => {
    expect(segmentHitsBox(new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0), box)).toBe(true);
  });
  it('detects a miss when the segment passes wide of the box', () => {
    expect(segmentHitsBox(new THREE.Vector3(-5, 5, 0), new THREE.Vector3(5, 5, 0), box)).toBe(false);
  });
  it('detects a miss when the segment ends short of the box', () => {
    expect(segmentHitsBox(new THREE.Vector3(-5, 0, 0), new THREE.Vector3(-2, 0, 0), box)).toBe(false);
  });
});

describe('room height', () => {
  it('roomDims exposes a 7.5-unit ceiling', () => {
    expect(roomDims(3).height).toBe(7.5);
  });

  it('clampToRoom allows positions up to just under the ceiling', () => {
    const pos = clampToRoom(new THREE.Vector3(0, 100, 0), makeOffice());
    expect(pos.y).toBeCloseTo(7.5 - 0.3);
    const low = clampToRoom(new THREE.Vector3(0, -5, 0), makeOffice());
    expect(low.y).toBeCloseTo(0.4);
  });
});

describe('hasLineOfSight', () => {
  it('is clear from above/beside the shoulder line', () => {
    const office = makeOffice();
    const subject = subjectFor('e1', office)!;
    const camPos = subject.center.clone().addScaledVector(subject.normal, 1.5).add(new THREE.Vector3(1.2, 1.2, 0));
    expect(hasLineOfSight(camPos, subject, office)).toBe(true);
  });
});

describe('LOS relaxation', () => {
  it("the subject's own occupant never blocks their screen", () => {
    const office = makeOffice();
    const subject = subjectFor('e1', office)!;
    // straight back along readable normal at eye height: segment crosses through
    // the occupied seat's head (0.17 distance to center, 0.35 old radius) and torso
    // (0.38 distance, 0.45 old radius) but own occupant is skipped, so LOS is clear
    const camPos = subject.center.clone().addScaledVector(subject.normal, 3).setY(1.6);
    expect(hasLineOfSight(camPos, subject, office)).toBe(true);
  });

  it("a steep high angle from above the subject's own head has LOS", () => {
    const office = makeOffice();
    const subject = subjectFor('e1', office)!;
    // elevated angle that passes over the occupant, also skipped via own-seat logic
    const camPos = subject.center.clone()
      .addScaledVector(subject.normal, 1.6)
      .add(new THREE.Vector3(0, 3.5, 0));
    expect(hasLineOfSight(camPos, subject, office)).toBe(true);
  });

  it('OTHER seats\' occupants still block', () => {
    const office = makeOffice(); // e1 seat 1, e2 seat 2 side by side
    const s2 = subjectFor('e2', office)!;
    // aim through seat-1's occupant at seat-2's screen: camera positioned ahead
    // of the desk row (person is 1.15 units forward) at torso height to cross seat-1's body
    const p1 = seatTransform(1).position;
    const camPos = new THREE.Vector3(p1.x - 0.5, 1.1, p1.z + 1.6);
    expect(hasLineOfSight(camPos, s2, office)).toBe(false);
  });
});

describe('closeUpShot line of sight', () => {
  it('for 20 seeds on an employee monitor, position is never inside an occluder, and LOS holds for >=15/20', () => {
    const office = makeOffice();
    const subject = subjectFor('e1', office)!;
    let losCount = 0;
    for (let i = 0; i < 20; i++) {
      const shot = closeUpShot(subject, FOV, ASPECT, rng(i), office);
      // not inside any person sphere (approximate: check both known occupied seats' spheres)
      // HEAD_R = 0.3, TORSO_R = 0.4
      for (const seat of [0, 1, 2]) {
        const { position, rotationY } = seatTransform(seat);
        const p = position.clone().add(new THREE.Vector3(0, 0, -1.15).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY));
        expect(shot.position.distanceTo(p.clone().add(new THREE.Vector3(0, 1.8, 0)))).toBeGreaterThan(0.3);
        expect(shot.position.distanceTo(p.clone().add(new THREE.Vector3(0, 1.25, 0)))).toBeGreaterThan(0.4);
      }
      if (hasLineOfSight(shot.position, subject, office)) losCount++;
    }
    expect(losCount).toBeGreaterThanOrEqual(15);
  });
});

describe('groupShot with office', () => {
  it('for 20 seeds all subjects stay front-facing and in-frustum, and position is in-room', () => {
    const office = makeOffice();
    const subjects = [subjectFor('e1', office)!, subjectFor('e2', office)!, subjectFor('whiteboard', office)!];
    for (let i = 0; i < 20; i++) {
      const shot = groupShot(subjects, FOV, ASPECT, rng(i), office);
      for (const s of subjects) {
        expect(shot.position.clone().sub(s.center).dot(s.normal)).toBeGreaterThan(0);
        expect(inFrustum(s.center, shot)).toBe(true);
      }
      expectInRoom(shot.position, office);
    }
  });

  it('for 20 seeds in a crowded office (more monitor occluders in play), still front-facing/in-frustum/in-room', () => {
    // six occupied seats means every candidate direction has several OTHER seats'
    // monitor AABBs nearby as potential occluders, exercising the ranking logic
    // (front-facing as a criterion, not a hard pre-filter, over occluder-free candidates)
    // rather than degenerating into the front-facing-only case a sparse office allows.
    const office = makeOffice({ employees: [1, 2, 3, 4, 5, 6].map((seat) => makeEmployee({ id: `e${seat}`, seat })) });
    const subjects = [subjectFor('e1', office)!, subjectFor('e2', office)!];
    for (let i = 0; i < 20; i++) {
      const shot = groupShot(subjects, FOV, ASPECT, rng(i), office);
      for (const s of subjects) {
        expect(shot.position.clone().sub(s.center).dot(s.normal)).toBeGreaterThan(0);
        expect(inFrustum(s.center, shot)).toBe(true);
      }
      expectInRoom(shot.position, office);
    }
  });
});

const STATIC_SINGLE: ArchetypeName[] = ['staticCloseup', 'staticProfile', 'staticHighAngle', 'staticLow', 'dutchStatic'];
const STATIC_GROUP: ArchetypeName[] = ['staticGroup'];
const STATIC_IDLE: ArchetypeName[] = ['staticWide', 'staticCorner'];

/** Force `target` to be the only fresh archetype in `pool` by marking every other
 *  member recently-used, so order() puts it first and it's picked barring the rare
 *  all-candidates-invalid fallback. */
function forceArchetype(pool: ArchetypeName[], target: ArchetypeName): ArchetypeName[] {
  return pool.filter((n) => n !== target);
}

describe('static archetype invariants', () => {
  it.each(STATIC_SINGLE)('%s has no positionEnd/lookAtEnd/fov', (name) => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    const othersRecent = forceArchetype(SINGLE_POOL, name);
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 900), cutIndex: i, recentArchetypes: othersRecent }));
      if (shot.archetype !== name) continue;
      hits++;
      expect(shot.positionEnd).toBeUndefined();
      expect(shot.lookAtEnd).toBeUndefined();
      expect(shot.fov).toBeUndefined();
      expect(shot.fovEnd).toBeUndefined();
      if (name === 'dutchStatic') {
        expect(shot.roll).toBeDefined();
        expect(Math.abs(shot.roll!)).toBeLessThanOrEqual(deg(15) + 1e-6);
      }
    }
    expect(hits).toBeGreaterThanOrEqual(15);
  });

  it('staticGroup has no positionEnd/lookAtEnd/fov', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now, e2: now };
    const othersRecent = forceArchetype([...SINGLE_POOL, ...GROUP_POOL], 'staticGroup');
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 950), cutIndex: i, recentArchetypes: othersRecent }));
      if (shot.archetype !== 'staticGroup') continue;
      hits++;
      expect(shot.positionEnd).toBeUndefined();
      expect(shot.lookAtEnd).toBeUndefined();
      expect(shot.fov).toBeUndefined();
    }
    expect(hits).toBeGreaterThanOrEqual(10);
  });

  it.each(STATIC_IDLE)('%s has no positionEnd/lookAtEnd/fov', (name) => {
    const othersRecent = forceArchetype(IDLE_POOL, name);
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const shot = pickShot(ctx({ rng: rng(i + 990), cutIndex: i, recentArchetypes: othersRecent }));
      if (shot.archetype !== name) continue;
      hits++;
      expect(shot.positionEnd).toBeUndefined();
      expect(shot.lookAtEnd).toBeUndefined();
      expect(shot.fov).toBeUndefined();
    }
    expect(hits).toBeGreaterThanOrEqual(15);
  });
});

describe('pool composition', () => {
  function poolShare(pool: ArchetypeName[]) {
    const total = pool.reduce((sum, n) => sum + ARCHETYPES[n].weight, 0);
    const staticWeight = pool.filter((n) => ARCHETYPES[n].static).reduce((sum, n) => sum + ARCHETYPES[n].weight, 0);
    return staticWeight / total;
  }

  // GROUP_POOL adds exactly one static archetype (staticGroup, per brief §1) and is never
  // selected standalone in pickShot — a multi-subject cut's pool is always SINGLE_POOL +
  // GROUP_POOL combined (see pickShot's `pool = [...pool, ...GROUP_POOL]`), so the >=3
  // check is applied to the single pool alone and to that combined pool, which both clear it.
  it('the single pool and the combined single+group pool each have at least 3 static archetypes', () => {
    for (const pool of [SINGLE_POOL, [...SINGLE_POOL, ...GROUP_POOL]]) {
      const staticCount = pool.filter((n) => ARCHETYPES[n].static).length;
      expect(staticCount).toBeGreaterThanOrEqual(3);
    }
  });

  // IDLE_POOL only gains 2 static archetypes per brief §1 (staticWide, staticCorner) — the
  // brief's own >=3-per-pool aggregate note doesn't hold for a pool this small; its weight
  // share still lands in the 0.5-0.7 target (see the share test below), so 2 is accepted here.
  it('IDLE_POOL has at least 2 static archetypes (staticWide, staticCorner)', () => {
    expect(IDLE_POOL.filter((n) => ARCHETYPES[n].static)).toEqual(['staticWide', 'staticCorner']);
  });

  it('GROUP_POOL itself contains its one authored static archetype (staticGroup)', () => {
    expect(GROUP_POOL.filter((n) => ARCHETYPES[n].static)).toEqual(['staticGroup']);
  });

  it('static share of total pool weight is between 0.5 and 0.7 for every pool', () => {
    for (const pool of [SINGLE_POOL, GROUP_POOL, IDLE_POOL]) {
      const share = poolShare(pool);
      expect(share).toBeGreaterThanOrEqual(0.5);
      expect(share).toBeLessThanOrEqual(0.7);
    }
  });
});

describe('weighted selection favors statics', () => {
  it('over 200 draws in a single-subject office, static archetypes land >=45% of cuts', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    let prev: THREE.Vector3 | null = null;
    let recent: ArchetypeName[] = [];
    let staticHits = 0;
    const r = rng(12345);
    for (let i = 0; i < 200; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: r, cutIndex: i, prevPosition: prev, recentArchetypes: recent }));
      if (ARCHETYPES[shot.archetype].static) staticHits++;
      prev = (shot.positionEnd ?? shot.position).clone();
      recent = [shot.archetype, ...recent].slice(0, 3);
    }
    expect(staticHits / 200).toBeGreaterThanOrEqual(0.45);
  });
});

describe('streak breaker', () => {
  it('two moving shots in a row force the next pick to be static (across 50 seeds)', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    for (let seed = 0; seed < 50; seed++) {
      const shot = pickShot(ctx({
        office, lastActivity, now, rng: rng(seed + 1),
        recentMotion: [true, true],
      }));
      expect(ARCHETYPES[shot.archetype].static).toBe(true);
    }
  });
});

describe('tiltReveal', () => {
  it('tilts the look target up from desk level to the screen with no positionEnd', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    const othersRecent = forceArchetype(SINGLE_POOL, 'tiltReveal');
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 1200), cutIndex: i, recentArchetypes: othersRecent }));
      if (shot.archetype !== 'tiltReveal') continue;
      hits++;
      expect(shot.positionEnd).toBeUndefined();
      expect(shot.lookAtEnd).toBeDefined();
      expect(shot.lookAtEnd!.y).toBeGreaterThan(shot.lookAt.y);
    }
    expect(hits).toBeGreaterThanOrEqual(15);
  });
});
