import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Employee, OfficeState } from '../../../shared/types.ts';
import { roomDims, seatTransform } from './layout.ts';
import { EOTM_KEY, EOTM_H } from './eotmTexture.ts';
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
  MEDIUM_MAX_MUL,
  MIN_SHOT_DIST,
  pickShot,
  pointInFrame,
  BEACON_KEY,
  QUIZ_KEY,
  quizSubject,
  SINGLE_POOL,
  GROUP_POOL,
  IDLE_KEY,
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

/** run `cuts` cuts against a fixed active set, threading state like the live camera */
function runCuts(lastActivity: Record<string, number>, cuts: number, overrides: Partial<ShotContext> = {}) {
  const office = overrides.office ?? makeOffice();
  const now = 100_000;
  const shots: PickedShot[] = [];
  let recentPrimaries: string[] = [];
  let prev: THREE.Vector3 | null = null;
  // one continuous rng across cuts, like the live camera (fresh tiny seeds
  // bias the first draw low, which would starve the last weighted-pool slot)
  const r = rng(9001);
  for (let i = 0; i < cuts; i++) {
    const shot = pickShot({
      office, lastActivity, now,
      fovY: FOV, aspect: ASPECT, rng: r, cutIndex: i,
      prevPosition: prev, recentPrimaries,
      ...overrides,
    });
    shots.push(shot);
    if (shot.primaryKey) recentPrimaries = [shot.primaryKey, ...recentPrimaries].slice(0, 4);
    prev = (shot.positionEnd ?? shot.position).clone();
  }
  return shots;
}

describe('activeKeys / activeSetKey', () => {
  it('keeps only keys stamped within the window', () => {
    const now = 100_000;
    const la = { fresh: now - 1, stale: now - ACTIVE_WINDOW_MS - 1, edge: now - ACTIVE_WINDOW_MS + 1 };
    expect(activeKeys(la, now).sort()).toEqual(['edge', 'fresh']);
  });
  it('boss and whiteboard outlive the shorter global monitor window, then expire too', () => {
    const now = 100_000;
    // derived, not hardcoded: these windows track the MovieCamera cut cadence and
    // are expected to grow with it, but the ordering below must always hold
    expect(ACTIVE_WINDOW_MS).toBeLessThan(activityTtl('boss'));
    const between = (ACTIVE_WINDOW_MS + activityTtl('boss')) / 2;
    const la = { boss: now - between, whiteboard: now - between, e1: now - between, statusboard: now - between };
    expect(activeKeys(la, now).sort()).toEqual(['boss', 'statusboard', 'whiteboard']);
    const past = activityTtl('boss') + 1_000;
    const later = { boss: now - past, whiteboard: now - past, statusboard: now - past };
    expect(activeKeys(later, now)).toEqual(['statusboard']);
  });
  it('activityTtl gives boards their own windows and everything else the global window', () => {
    // boards must survive a full hold + max shot (MovieCamera MIN_HOLD_S + CUT_MAX_S = 20s)
    // or a subject can go stale before the director ever cuts to it
    expect(activityTtl('boss')).toBeGreaterThanOrEqual(20_000);
    expect(activityTtl('boss')).toBe(24_000);
    expect(activityTtl('whiteboard')).toBe(24_000);
    expect(activityTtl('statusboard')).toBe(150_000);
    expect(activityTtl('tv')).toBe(150_000);
    expect(activityTtl('e1')).toBe(ACTIVE_WINDOW_MS);
    expect(ACTIVE_WINDOW_MS).toBeGreaterThanOrEqual(20_000);
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

  it('the tv default offset tracks the room forward (stable x, z follows centerZ) as maxSeat/room size grows', () => {
    // defaultWallOffset('tv') is a constant 5.0 along the wall, so world z = centerZ - 5
    // slides toward the employees as the room grows at the front, while x (off the left
    // wall) holds steady. It used to be pinned to BACK_Z + 1.9 hugging the back corner.
    const small = subjectFor('tv', makeOffice({ employees: [makeEmployee({ id: 'e1', seat: 1 })] }))!;
    const big = subjectFor(
      'tv',
      makeOffice({ employees: Array.from({ length: 9 }, (_, i) => makeEmployee({ id: `e${i}`, seat: i + 1 })) }),
    )!;
    expect(small.center.x).toBeCloseTo(big.center.x, 6);
    expect(big.center.z).toBeGreaterThan(small.center.z);
    // and the two room sizes actually differ (sanity check the fixture is meaningful)
    expect(roomDims(3).depth).not.toBeCloseTo(roomDims(9).depth, 1);
    // matches the raw formula the layout/render side uses directly
    for (const ms of [3, 9]) {
      const { width, centerZ } = roomDims(ms);
      const s = subjectFor('tv', makeOffice({ employees: Array.from({ length: ms }, (_, i) => makeEmployee({ id: `e${i}`, seat: i + 1 })) }))!;
      expect(s.center.z).toBeCloseTo(centerZ - 5.0, 6);
      // the mount point on the wall plane; the few cm the TV body stands off it
      // don't move the framing, and keeping it here would duplicate a render constant
      expect(s.center.x).toBeCloseTo(-width / 2, 6);
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

describe('pointInFrame', () => {
  const cam = new THREE.Vector3(0, 1.5, 0);
  const look = new THREE.Vector3(0, 1.5, -5);
  it('accepts a point on the look axis and rejects one behind the camera', () => {
    expect(pointInFrame(cam, look, new THREE.Vector3(0, 1.5, -3), FOV, ASPECT)).toBe(true);
    expect(pointInFrame(cam, look, new THREE.Vector3(0, 1.5, 3), FOV, ASPECT)).toBe(false);
  });
  it('rejects a point ~90° off-axis even though nothing occludes it', () => {
    expect(pointInFrame(cam, look, new THREE.Vector3(4, 1.5, 0), FOV, ASPECT)).toBe(false);
  });
  it('a narrower fov ejects a point near the edge of the wide frame', () => {
    // 3 units ahead, offset just inside the 50° half-height (3*tan25° = 1.40) × margin
    const edge = new THREE.Vector3(0, 1.5 + 1.1, -3);
    expect(pointInFrame(cam, look, edge, FOV, ASPECT)).toBe(true);
    expect(pointInFrame(cam, look, edge, deg(34), ASPECT)).toBe(false);
  });
  it('the margin keeps an exactly-on-the-edge point out of frame', () => {
    const onEdge = new THREE.Vector3(0, 1.5 + 3 * Math.tan(FOV / 2), -3);
    expect(pointInFrame(cam, look, onEdge, FOV, ASPECT)).toBe(false);
  });
});

describe('the waiting beacon', () => {
  const now = 100_000;

  it('resolves on the boss desk and tracks a build-mode override of seat 0', () => {
    const b = subjectFor(BEACON_KEY, makeOffice())!;
    // boss desk sits at z=BOSS_Z with rotationY 0, beacon local [0.7, 1.07, 0.25]
    expect(b.center.x).toBeCloseTo(0.7);
    expect(b.center.y).toBeCloseTo(1.07);
    expect(b.center.z).toBeCloseTo(seatTransform(0).position.z + 0.25);
    // readable from the room side (+z at rotation 0), tilted up off the desk top
    expect(b.normal.z).toBeGreaterThan(0);
    expect(b.normal.y).toBeGreaterThan(0);

    const moved = subjectFor(BEACON_KEY, makeOffice({ layout: { seats: { 0: { x: 2, z: 1, rotY: 0 } } } }))!;
    expect(moved.center.x).toBeCloseTo(2.7);
    expect(moved.center.z).toBeCloseTo(1.25);
  });

  it('every shot frames the beacon while it blinks — active office, idle office, and boards', () => {
    const office = makeOffice();
    const beacon = subjectFor(BEACON_KEY, office)!;
    const cases: Record<string, number>[] = [{}, { e1: now }, { e1: now, e2: now, boss: now }, { statusboard: now }, { whiteboard: now }];
    for (const active of cases) {
      const shots = runCuts(active, 12, { office, waiting: true });
      for (const shot of shots) {
        for (const e of [0, 0.5, 1]) {
          const pos = shot.position.clone().lerp(shot.positionEnd ?? shot.position, e);
          const look = shot.lookAt.clone().lerp(shot.lookAtEnd ?? shot.lookAt, e);
          expect(hasLineOfSight(pos, beacon, office)).toBe(true);
          expect(pointInFrame(pos, look, beacon.center, FOV, ASPECT, 1)).toBe(true);
        }
      }
    }
  });

  it('the constraint is conditional: without waiting, shots are free to ignore the beacon', () => {
    const office = makeOffice();
    const beacon = subjectFor(BEACON_KEY, office)!;
    const shots = runCuts({ e1: now, e2: now }, 12, { office });
    expect(shots.some((s) => !pointInFrame(s.position, s.lookAt, beacon.center, FOV, ASPECT))).toBe(true);
  });

  it('forcePrimary puts the boss screen first on a new message from upstairs', () => {
    const office = makeOffice();
    // e1/e2 would normally dominate a 3-subject draw; the forced key leads anyway
    for (let i = 0; i < 10; i++) {
      const shot = pickShot(ctx({
        office, lastActivity: { e1: now, e2: now, boss: now }, now,
        rng: rng(i + 300), cutIndex: i, forcePrimary: 'boss',
      }));
      expect(shot.primaryKey).toBe('boss');
    }
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

  it('pickShot rotates primaries: every live subject (incl. boss and the todo board) leads a shot within a few cuts', () => {
    const now = 100_000;
    const shots = runCuts({ boss: now, e1: now, e2: now, whiteboard: now, statusboard: now }, 20);
    const leads = new Set(shots.map((s) => s.primaryKey!));
    expect(shots.every((s) => s.primaryKey !== undefined)).toBe(true);
    expect(leads).toContain('boss');
    expect(leads).toContain('whiteboard');
    expect(leads.size).toBeGreaterThanOrEqual(4);
  });

  it('never leads on an ambient wall board while anything live is active, but does when nothing is', () => {
    const now = 100_000;
    // statusboard/tv stay "active" for minutes; a streaming monitor must always outrank them
    const busy = runCuts({ e1: now, whiteboard: now, statusboard: now, tv: now }, 20);
    expect(busy.map((s) => s.primaryKey)).not.toContain('statusboard');
    expect(busy.map((s) => s.primaryKey)).not.toContain('tv');

    const quiet = runCuts({ statusboard: now, tv: now }, 20);
    expect(new Set(quiet.map((s) => s.primaryKey))).toContain('statusboard');
  });

  it('does not park on a lone ambient board: the room is a peer primary when nothing is live', () => {
    // the TV's activity window runs for 150s, so before IDLE_KEY it was the only
    // candidate for every cut in that window — the camera sat on it and never left
    const keys = runCuts({ tv: 100_000 }, 40).map((s) => s.primaryKey);
    expect(new Set(keys)).toEqual(new Set(['tv', IDLE_KEY]));
    // the room takes the bulk of a quiet office; the TV is one of the things it passes
    const tvShare = keys.filter((k) => k === 'tv').length / keys.length;
    expect(tvShare).toBeGreaterThan(0);
    expect(tvShare).toBeLessThan(0.5);
    // and the board never leads twice running — that repetition is the whole complaint.
    // Consecutive idle cuts are fine: each is a different wide from a different spot.
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i] === 'tv' && keys[i - 1] === 'tv').toBe(false);
    }
  });

  it('still leads on live work when something is streaming — the room waits its turn', () => {
    const now = 100_000;
    const keys = runCuts({ e1: now, tv: now }, 20).map((s) => s.primaryKey);
    expect(keys).not.toContain(IDLE_KEY);
    expect(keys).not.toContain('tv');
  });

  it('keeps every active cut at close/medium range on its primary, start and end', () => {
    const now = 100_000;
    const office = makeOffice();
    const cases: Record<string, number>[] = [{ e1: now }, { e1: now, e2: now, boss: now }, { whiteboard: now }, { tv: now }];
    for (const active of cases) {
      for (const shot of runCuts(active, 12, { office })) {
        // an ambient-only office now also draws the room itself (IDLE_KEY), whose
        // whole point is the far coverage this ceiling excludes
        if (shot.primaryKey === IDLE_KEY) continue;
        const primary = subjectFor(shot.primaryKey!, office)!;
        const max = fitDistance(primary.width, primary.height, FOV, ASPECT, 1.3) * MEDIUM_MAX_MUL;
        expect(shot.position.distanceTo(primary.center)).toBeLessThanOrEqual(max + 1e-6);
        expect((shot.positionEnd ?? shot.position).distanceTo(primary.center)).toBeLessThanOrEqual(max + 1e-6);
      }
    }
  });

  it('an idle office still gets the far/wide idle coverage', () => {
    expect(runCuts({}, 8).every((s) => IDLE_POOL.includes(s.archetype))).toBe(true);
  });

  describe('the employee of the month frame as a subject', () => {
    const now = 100_000;

    it('is cut to in a quiet office, with no activity to stamp it', () => {
      // the room is a peer here, so this is a "gets its turn" test, not a majority one
      const shots = runCuts({}, 30, { awardFrame: true });
      expect(shots.some((s) => s.primaryKey === EOTM_KEY)).toBe(true);
    });

    it('is absent while the game is off', () => {
      expect(runCuts({}, 10).some((s) => s.primaryKey === EOTM_KEY)).toBe(false);
    });

    it('leaves the silent office its idle coverage instead of parking on the wall', () => {
      const shots = runCuts({}, 12, { awardFrame: true });
      // it has no activity window to expire, so without a duty cycle it would be
      // the only candidate on every cut, forever
      expect(shots.filter((s) => s.primaryKey === EOTM_KEY).length).toBeLessThan(shots.length / 2);
      expect(shots.some((s) => IDLE_POOL.includes(s.archetype))).toBe(true);
    });

    it('yields entirely to a live monitor — it is a wall hanging, not work', () => {
      const shots = runCuts({ e1: now - 1, e2: now - 1 }, 10, { awardFrame: true });
      expect(shots.some((s) => s.primaryKey === EOTM_KEY)).toBe(false);
    });

    it('takes its turn among the other ambient boards rather than owning the room', () => {
      const shots = runCuts({ statusboard: now - 1, tv: now - 1 }, 14, { awardFrame: true });
      const primaries = new Set(shots.map((s) => s.primaryKey));
      expect(primaries.has(EOTM_KEY)).toBe(true);
      expect([...primaries].some((k) => k === 'statusboard' || k === 'tv')).toBe(true);
    });

    it('leads the cut when a new photo forces it, even with the office busy', () => {
      const shots = runCuts({ e1: now - 1, e2: now - 1 }, 1, { awardFrame: true, forcePrimary: EOTM_KEY });
      expect(shots[0].primaryKey).toBe(EOTM_KEY);
    });

    it('is framed from in front of the wall it hangs on, photo and plaque both', () => {
      const office = makeOffice();
      const subject = subjectFor(EOTM_KEY, office)!;
      for (const shot of runCuts({}, 8, { office, awardFrame: true }).filter((s) => s.primaryKey === EOTM_KEY)) {
        const toCamera = shot.position.clone().sub(subject.center).normalize();
        expect(toCamera.dot(subject.normal)).toBeGreaterThan(0);
      }
      // the plaque is inside the subject the camera fits, not cropped off below it
      expect(subject.height).toBeGreaterThan(EOTM_H);
    });
  });

  describe('the 20 questions bubble as a subject', () => {
    const anchor: [number, number, number] = [0, 3, -4.6]; // the boss asking, at their desk

    it('is cut to when the office is otherwise silent, instead of pure B-roll', () => {
      const shots = runCuts({}, 30, { quizAnchor: anchor });
      expect(shots.some((s) => s.primaryKey === QUIZ_KEY)).toBe(true);
    });

    it('shares the quiet office with the ambient boards rather than owning every cut', () => {
      const now = 100_000;
      const shots = runCuts({ statusboard: now - 1, tv: now - 1 }, 12, { quizAnchor: anchor });
      const primaries = new Set(shots.map((s) => s.primaryKey));
      expect(primaries.has(QUIZ_KEY)).toBe(true);
      expect([...primaries].some((k) => k === 'statusboard' || k === 'tv')).toBe(true);
    });

    it('yields entirely to a live monitor — real work outranks the game', () => {
      const now = 100_000;
      const shots = runCuts({ e1: now - 1, e2: now - 1 }, 10, { quizAnchor: anchor });
      expect(shots.some((s) => s.primaryKey === QUIZ_KEY)).toBe(false);
    });

    it('yields to the todo board too, which is live rather than ambient', () => {
      const now = 100_000;
      const shots = runCuts({ whiteboard: now - 1 }, 8, { quizAnchor: anchor });
      expect(shots.some((s) => s.primaryKey === QUIZ_KEY)).toBe(false);
    });

    it('is absent when no question is up', () => {
      expect(runCuts({}, 8, { quizAnchor: null }).some((s) => s.primaryKey === QUIZ_KEY)).toBe(false);
    });

    it('shares the quiet office with the award frame too', () => {
      const shots = runCuts({}, 12, { quizAnchor: anchor, awardFrame: true });
      const primaries = new Set(shots.map((s) => s.primaryKey));
      expect(primaries.has(QUIZ_KEY)).toBe(true);
      expect(primaries.has(EOTM_KEY)).toBe(true);
    });

    it('frames the asker under the bubble, from open floor', () => {
      const office = makeOffice();
      // Kat Person's back-left corner: the normal must point into the room, or
      // every candidate camera position lands inside a wall
      const corner = quizSubject([-6.5, 3, -7.4], office);
      expect(corner.center.y).toBeLessThan(3);
      expect(corner.normal.y).toBe(0);
      expect(corner.normal.x).toBeGreaterThan(0);
      expect(corner.normal.z).toBeGreaterThan(0);
      expect(corner.normal.length()).toBeCloseTo(1, 6);
    });
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
      // forcePrimary, because this is a geometry test for the tv's pan, not a test of
      // how often the draw picks the tv (the idle tier outweighs it on purpose)
      const shot = pickShot(ctx({ office, lastActivity: { tv: now }, now, rng: rng(i + 700), cutIndex: i, forcePrimary: 'tv' }));
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

  it('group archetypes are not offered at default desk spacing (fitting two screens is a wide shot)', () => {
    // Desks sit 3.4 apart, and framing two 1.35-wide monitors at 50° needs the camera
    // ~8 units back — past the close/medium ceiling an active office is held to. So the
    // group pool simply isn't in play here, even when every other archetype is stale.
    const office = makeOffice();
    const now = Date.now();
    const lastActivity = { e1: now, e2: now };
    const othersRecent = forceArchetype([...SINGLE_POOL, ...GROUP_POOL], 'staticGroup');
    for (let i = 0; i < 20; i++) {
      const shot = pickShot(ctx({ office, lastActivity, now, rng: rng(i + 950), cutIndex: i, recentArchetypes: othersRecent }));
      expect(GROUP_POOL).not.toContain(shot.archetype);
    }
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
