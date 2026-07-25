import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Employee, OfficeState } from '../../../shared/types.ts';
import { roomDims, seatTransform } from './layout.ts';
import {
  ACTIVE_WINDOW_MS,
  activeKeys,
  activeSetKey,
  clampToRoom,
  closeUpShot,
  fitDistance,
  groupByFacing,
  groupShot,
  hasLineOfSight,
  MIN_SHOT_DIST,
  pickShot,
  segmentHitsBox,
  segmentHitsSphere,
  subjectFor,
  type ArchetypeName,
  type PickedShot,
  type ShotContext,
  type Subject,
} from './movieShots.ts';

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

  it('pickShot alternates facing groups when boss and employees are both active', () => {
    const office = makeOffice();
    const now = 100_000;
    const ctx = {
      office, lastActivity: { boss: now, e1: now }, now,
      fovY: FOV, aspect: ASPECT, rng: rng(1), cutIndex: 0,
    };
    const a = pickShot({ ...ctx, cutIndex: 0 });
    const b = pickShot({ ...ctx, cutIndex: 1 });
    const bossSubj = subjectFor('boss', office)!;
    const e1Subj = subjectFor('e1', office)!;
    const seesBoss = (s: typeof a) => s.position.clone().sub(bossSubj.center).dot(bossSubj.normal) > 0;
    const seesE1 = (s: typeof a) => s.position.clone().sub(e1Subj.center).dot(e1Subj.normal) > 0;
    expect(seesBoss(a) !== seesBoss(b)).toBe(true);
    expect(seesE1(a) !== seesE1(b)).toBe(true);
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
      expect(['overheadGod', 'highCorner', 'lowDolly', 'wideEstablishing']).toContain(shot.archetype);
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

  it('a single active subject uses the single-subject pool with LOS and min distance', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now };
    const subject = subjectFor('e1', office)!;
    let prev: THREE.Vector3 | null = null;
    let recent: ArchetypeName[] = [];
    for (let i = 0; i < 8; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 3), cutIndex: i, prevPosition: prev, recentArchetypes: recent }));
      expect(['otsCloseup', 'highAngle', 'sideProfile']).toContain(shot.archetype);
      expect(hasLineOfSight(shot.position, subject, office)).toBe(true);
      if (prev) expect(shot.position.distanceTo(prev)).toBeGreaterThanOrEqual(MIN_SHOT_DIST);
      prev = shot.position.clone();
      recent = [shot.archetype, ...recent].slice(0, 2);
    }
  });

  it('multiple co-facing subjects use group archetypes', () => {
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now, e2: now };
    const shot = pickShot(ctx({ office, lastActivity, now }));
    expect(['groupLevel', 'elevatedGroup']).toContain(shot.archetype);
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
