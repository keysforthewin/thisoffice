# Movie Camera Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third camera mode (toggled with **M**) that auto-frames whichever monitors/whiteboard are actively receiving content, hard-cutting to a new randomized shot every 3–10 s with a subtle handheld float within each shot.

**Architecture:** Activity timestamps are stamped in the zustand store as server messages arrive. A pure, unit-tested module (`movieShots.ts`) turns the active subject set into a camera shot (close-up / group / wide B-roll) using screen world-transforms derived from `layout.ts`. A thin R3F component (`MovieCamera.tsx`) runs the cut timer and layers handheld noise on the chosen shot.

**Tech Stack:** React Three Fiber, three.js, zustand, vitest. Spec: `docs/superpowers/specs/2026-07-25-movie-mode-design.md`.

## Global Constraints

- Active window: a subject is active if stamped within the last **10 000 ms** (`ACTIVE_WINDOW_MS`).
- Cut cadence: random uniform **3–10 s**; immediate cut on any arrow key or when the active subject set changes.
- **Hard cuts** — the camera teleports between shots; no glide.
- Handheld amplitude ≈ **0.05 world units** (world scale is 1.35× human — see CLAUDE.md).
- Monitor screen plane: **1.35 × 0.85** units, local center `[0, 1.66, 0.35]` in the desk group, facing local **−z** (desk faces +z; employees have `rotationY = π`, so employee screens face world **+z**, the boss screen faces world **−z**).
- Whiteboard plane: **3.2 × 1.95** units at `whiteboardTransform(maxSeat).position`, facing world **−x**.
- Run tests from repo root: `npx vitest run <file>`.
- Keyboard handlers must ignore events targeting input/select/textarea elements.

---

### Task 1: Activity timestamps + movie mode in the store

**Files:**
- Modify: `web/src/store.ts`
- Test: `web/src/store.test.ts` (new)

**Interfaces:**
- Consumes: `boardContent(office)` from `web/src/scene/whiteboardContent.ts` (existing).
- Produces: `CameraMode` union now includes `{ kind: 'movie' }`; store field `lastActivity: Record<string, number>` (subject key → epoch ms; keys are `'boss'`, employee ids, `'whiteboard'`). Task 2 reads `lastActivity`; Task 3 reads both.

- [ ] **Step 1: Write the failing test**

Create `web/src/store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeState } from '../../shared/types.ts';
import { resetWhiteboardKeyForTest, useStore } from './store.ts';

function makeOffice(overrides: Partial<OfficeState> = {}): OfficeState {
  return {
    boss: { name: 'Boss', variant: 'Knight' },
    employees: [],
    inbox: [],
    queue: [],
    todos: null,
    settings: { minEmployees: 0, maxEmployees: 9 },
    ...overrides,
  } as OfficeState;
}

describe('lastActivity stamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetWhiteboardKeyForTest();
    useStore.setState({ office: null, monitors: {}, monitorVersion: {}, lastActivity: {} });
  });
  afterEach(() => vi.useRealTimers());

  it('stamps the target when a monitor message appends text', () => {
    useStore.getState().applyServerMsg({ type: 'monitor', target: 'e1', append: 'hello\n' } as never);
    expect(useStore.getState().lastActivity['e1']).toBe(1_000_000);
  });

  it('does not stamp on clear-only monitor messages', () => {
    useStore.getState().applyServerMsg({ type: 'monitor', target: 'e1', clear: true } as never);
    expect(useStore.getState().lastActivity['e1']).toBeUndefined();
  });

  it('stamps the whiteboard when derived board content changes, but not on the first state', () => {
    useStore.getState().applyServerMsg({ type: 'state', state: makeOffice() });
    expect(useStore.getState().lastActivity['whiteboard']).toBeUndefined();

    vi.setSystemTime(1_005_000);
    const changed = makeOffice({
      inbox: [{ id: 'i1', project: 'p', text: 'new prompt', at: new Date().toISOString() }],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);

    // identical content again → no re-stamp
    vi.setSystemTime(1_009_000);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);
  });
});
```

Note: if `OfficeState` in `shared/types.ts` has different required fields than `makeOffice` guesses, copy the shape used by `web/src/scene/whiteboardContent.test.ts`'s `makeOffice` helper instead — it already builds a valid `OfficeState`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/store.test.ts`
Expected: FAIL — `lastActivity` is not a store field yet (undefined state / type errors).

- [ ] **Step 3: Implement store changes**

In `web/src/store.ts`:

1. Import `boardContent`:

```ts
import { boardContent } from './scene/whiteboardContent.ts';
```

2. Extend the mode union:

```ts
export type CameraMode = { kind: 'free' } | { kind: 'pov'; index: number } | { kind: 'movie' };
```

3. Add to `AppStore` interface:

```ts
  /** subject key ('boss' | employee id | 'whiteboard') → epoch ms of last content change */
  lastActivity: Record<string, number>;
```

4. Initialize `lastActivity: {}` in the `create` initializer.

5. In `applyServerMsg`, the `state` branch becomes:

```ts
    if (msg.type === 'state') {
      const key = JSON.stringify(boardContent(msg.state));
      const prevKey = whiteboardKey;
      whiteboardKey = key;
      if (prevKey !== null && prevKey !== key) {
        set({ office: msg.state, lastActivity: { ...get().lastActivity, whiteboard: Date.now() } });
      } else {
        set({ office: msg.state });
      }
      return;
    }
```

with a module-level `let whiteboardKey: string | null = null;` above the store (it is derived cache, not rendered state — keeping it out of the store avoids pointless re-renders).

6. In the `monitor` branch, alongside the existing `monitorVersion` bump, stamp activity only when text was appended:

```ts
      const lastActivity = msg.append
        ? { ...get().lastActivity, [msg.target]: Date.now() }
        : get().lastActivity;
      set({ monitors, monitorVersion, lastActivity });
```

7. Also reset `whiteboardKey = null` is NOT needed anywhere — it lives for the page lifetime. But the test resets store state directly, so the test for "first state doesn't stamp" must run before any other test sends a `state` message; the tests above are already ordered that way within one file. To make tests order-independent, export a helper:

```ts
/** test-only: forget the cached whiteboard key so the next state msg counts as "first" */
export function resetWhiteboardKeyForTest() {
  whiteboardKey = null;
}
```

and call it in the test's `beforeEach`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/store.test.ts`
Expected: PASS (3 tests). Also run the full suite to check nothing broke: `npm test`.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.ts web/src/store.test.ts
git commit -m "feat: track per-monitor/whiteboard lastActivity and add movie camera mode type"
```

---

### Task 2: Pure shot solver (`movieShots.ts`)

**Files:**
- Create: `web/src/scene/movieShots.ts`
- Test: `web/src/scene/movieShots.test.ts`

**Interfaces:**
- Consumes: `seatTransform`, `whiteboardTransform`, `roomDims` from `web/src/scene/layout.ts`; `OfficeState` from `shared/types.ts`; `ACTIVE_WINDOW_MS` concept from spec.
- Produces (used by Task 3):

```ts
export const ACTIVE_WINDOW_MS = 10_000;
export interface Shot { position: THREE.Vector3; lookAt: THREE.Vector3; }
export function activeSetKey(lastActivity: Record<string, number>, now: number): string;
export interface ShotContext {
  office: OfficeState | null;
  lastActivity: Record<string, number>;
  now: number;
  /** vertical fov in radians */ fovY: number;
  aspect: number;
  /** uniform [0,1) */ rng: () => number;
  /** increments every cut; rotates between facing groups / idle variants */ cutIndex: number;
}
export function pickShot(ctx: ShotContext): Shot;
```

- [ ] **Step 1: Write the failing tests**

Create `web/src/scene/movieShots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Employee, OfficeState } from '../../../shared/types.ts';
import {
  ACTIVE_WINDOW_MS,
  activeKeys,
  activeSetKey,
  closeUpShot,
  fitDistance,
  groupByFacing,
  groupShot,
  pickShot,
  subjectFor,
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
    employees: [makeEmployee({ id: 'e1', seat: 1 }), makeEmployee({ id: 'e2', seat: 2 })],
    inbox: [],
    queue: [],
    todos: null,
    settings: { minEmployees: 0, maxEmployees: 9 },
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
    expect(activeSetKey({ b: now, a: now }, now)).toBe(activeSetKey({ a: now, b: now }, now));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/scene/movieShots.test.ts`
Expected: FAIL — module `./movieShots.ts` does not exist.

- [ ] **Step 3: Implement `movieShots.ts`**

Create `web/src/scene/movieShots.ts`:

```ts
import * as THREE from 'three';
import type { OfficeState } from '../../shared/types.ts';
import { roomDims, seatTransform, whiteboardTransform } from './layout.ts';

export const ACTIVE_WINDOW_MS = 10_000;

/** Monitor plane inside the desk group (see Desk.tsx / MonitorScreen.tsx). */
const MONITOR_OFFSET = new THREE.Vector3(0, 1.66, 0.35);
const MONITOR_W = 1.35;
const MONITOR_H = 0.85;
const WHITEBOARD_W = 3.2;
const WHITEBOARD_H = 1.95;
const UP = new THREE.Vector3(0, 1, 0);

export interface Subject {
  key: string;
  /** world-space screen center */
  center: THREE.Vector3;
  /** world-space unit normal the screen is readable from */
  normal: THREE.Vector3;
  width: number;
  height: number;
}

export interface Shot {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

export function activeKeys(lastActivity: Record<string, number>, now: number): string[] {
  return Object.keys(lastActivity).filter((k) => now - lastActivity[k] < ACTIVE_WINDOW_MS);
}

/** Stable fingerprint of the active set; the movie camera recuts when it changes. */
export function activeSetKey(lastActivity: Record<string, number>, now: number): string {
  return activeKeys(lastActivity, now).sort().join('|');
}

function maxSeat(office: OfficeState | null): number {
  return Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
}

export function subjectFor(key: string, office: OfficeState | null): Subject | null {
  if (key === 'whiteboard') {
    const wb = whiteboardTransform(maxSeat(office));
    return { key, center: wb.position.clone(), normal: new THREE.Vector3(-1, 0, 0), width: WHITEBOARD_W, height: WHITEBOARD_H };
  }
  let seat: number | null = null;
  if (key === 'boss') seat = 0;
  else {
    const emp = office?.employees.find((e) => e.id === key);
    if (emp) seat = emp.seat;
  }
  if (seat === null) return null;
  const { position, rotationY } = seatTransform(seat);
  const center = position.clone().add(MONITOR_OFFSET.clone().applyAxisAngle(UP, rotationY));
  // screens are readable from behind the chair: local −z (Desk.tsx)
  const normal = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, rotationY);
  return { key, center, normal, width: MONITOR_W, height: MONITOR_H };
}

/**
 * Greedy partition into facing-compatible groups: a camera position exists in
 * front of every screen in a group. Opposing normals (dot < 0) can never share
 * a shot; perpendicular ones (employee wall + whiteboard) can.
 */
export function groupByFacing(subjects: Subject[]): Subject[][] {
  const groups: Subject[][] = [];
  for (const s of subjects) {
    const g = groups.find((grp) => grp.every((m) => m.normal.dot(s.normal) > -0.01));
    if (g) g.push(s);
    else groups.push([s]);
  }
  return groups;
}

/** Distance at which a spanW×spanH rect (facing the camera) fits the frustum. */
export function fitDistance(spanW: number, spanH: number, fovY: number, aspect: number, margin = 1.2): number {
  const tanY = Math.tan(fovY / 2);
  const tanX = tanY * aspect;
  return Math.max((spanH * margin) / (2 * tanY), (spanW * margin) / (2 * tanX));
}

/** dir must be unit; returns dir yawed/pitched by small random angles. */
function jitterDir(dir: THREE.Vector3, rng: () => number, yawRange: number, pitchMin: number, pitchMax: number): THREE.Vector3 {
  const yaw = (rng() * 2 - 1) * yawRange;
  const pitch = pitchMin + rng() * (pitchMax - pitchMin);
  const d = dir.clone().applyAxisAngle(UP, yaw);
  const right = new THREE.Vector3().crossVectors(UP, d).normalize();
  return d.applyAxisAngle(right, pitch).normalize();
}

const CLOSEUP_YAW = THREE.MathUtils.degToRad(15);
const CLOSEUP_PITCH = THREE.MathUtils.degToRad(8);

export function closeUpShot(subject: Subject, fovY: number, aspect: number, rng: () => number): Shot {
  const dir = jitterDir(subject.normal, rng, CLOSEUP_YAW, -CLOSEUP_PITCH, CLOSEUP_PITCH);
  // margin 1.3: the jittered angle foreshortens the rect, and we want a little air
  const dist = fitDistance(subject.width, subject.height, fovY, aspect, 1.3);
  return { position: subject.center.clone().addScaledVector(dir, dist), lookAt: subject.center.clone() };
}

const GROUP_YAW = THREE.MathUtils.degToRad(40);
const GROUP_PITCH_MIN = THREE.MathUtils.degToRad(5);
const GROUP_PITCH_MAX = THREE.MathUtils.degToRad(20);
/** min dot(viewDir→camera, screen normal) for a screen to read as front-facing */
const FRONT_FACING_DOT = 0.25;

export function groupShot(subjects: Subject[], fovY: number, aspect: number, rng: () => number): Shot {
  const centroid = subjects
    .reduce((acc, s) => acc.add(s.center), new THREE.Vector3())
    .divideScalar(subjects.length);
  const avgNormal = subjects
    .reduce((acc, s) => acc.add(s.normal), new THREE.Vector3())
    .normalize();

  let dir: THREE.Vector3 | null = null;
  for (let attempt = 0; attempt < 8 && !dir; attempt++) {
    const cand = jitterDir(avgNormal, rng, GROUP_YAW, GROUP_PITCH_MIN, GROUP_PITCH_MAX);
    if (subjects.every((s) => cand.dot(s.normal) > FRONT_FACING_DOT)) dir = cand;
  }
  dir ??= jitterDir(avgNormal, () => 0.5, 0, GROUP_PITCH_MIN, GROUP_PITCH_MIN);

  // bounding sphere of all screen corners around the centroid; a distance of
  // R*margin/min(tan) + R guarantees every corner is inside the frustum
  let radius = 0;
  for (const s of subjects) {
    const right = new THREE.Vector3().crossVectors(UP, s.normal).normalize();
    for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) {
      const corner = s.center.clone().addScaledVector(right, sx * s.width).addScaledVector(UP, sy * s.height);
      radius = Math.max(radius, corner.distanceTo(centroid));
    }
  }
  const tanY = Math.tan(fovY / 2);
  const minTan = Math.min(tanY, tanY * aspect);
  const dist = (radius * 1.15) / minTan + radius;
  return { position: centroid.clone().addScaledVector(dir, dist), lookAt: centroid.clone() };
}

function wideShot(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ } = roomDims(maxSeat(office));
  const angle = rng() * Math.PI * 2;
  const position = new THREE.Vector3(
    Math.cos(angle) * width * 0.42,
    3.5 + rng() * 2.5,
    centerZ + Math.sin(angle) * depth * 0.42,
  );
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
}

export interface ShotContext {
  office: OfficeState | null;
  lastActivity: Record<string, number>;
  now: number;
  /** vertical fov in radians */
  fovY: number;
  aspect: number;
  /** uniform [0,1) */
  rng: () => number;
  /** increments every cut; rotates between facing groups / idle variants */
  cutIndex: number;
}

export function pickShot(ctx: ShotContext): Shot {
  const { office, fovY, aspect, rng, cutIndex } = ctx;
  const subjects = activeKeys(ctx.lastActivity, ctx.now)
    .map((k) => subjectFor(k, office))
    .filter((s): s is Subject => s !== null);

  if (subjects.length === 0) {
    // idle B-roll: alternate wide establishing shots and random monitor close-ups
    const all = ['boss', ...(office?.employees.map((e) => e.id) ?? [])]
      .map((k) => subjectFor(k, office))
      .filter((s): s is Subject => s !== null);
    if (cutIndex % 2 === 1 && all.length > 0) {
      return closeUpShot(all[Math.floor(rng() * all.length)], fovY, aspect, rng);
    }
    return wideShot(office, rng);
  }

  const groups = groupByFacing(subjects);
  const group = groups[cutIndex % groups.length];
  return group.length === 1
    ? closeUpShot(group[0], fovY, aspect, rng)
    : groupShot(group, fovY, aspect, rng);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/scene/movieShots.test.ts`
Expected: PASS. If `closeUpShot` frustum assertions fail, raise the margin passed to `fitDistance` in `closeUpShot` (foreshortening from the jitter angle is the usual culprit) — but keep it ≤ 1.5 so the close-up stays tight.

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/movieShots.ts web/src/scene/movieShots.test.ts
git commit -m "feat: pure shot solver for movie camera mode"
```

---

### Task 3: MovieCamera component + key bindings + HUD

**Files:**
- Create: `web/src/scene/MovieCamera.tsx`
- Modify: `web/src/scene/CameraRig.tsx` (mode branch)
- Modify: `web/src/App.tsx` (M key, HUD label)

**Interfaces:**
- Consumes: `pickShot`, `activeSetKey`, `Shot` from Task 2; `lastActivity` and `CameraMode` `{ kind: 'movie' }` from Task 1.
- Produces: user-facing behavior only; nothing downstream.

- [ ] **Step 1: Implement `MovieCamera.tsx`**

Create `web/src/scene/MovieCamera.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { activeSetKey, pickShot, type Shot } from './movieShots.ts';

const CUT_MIN_S = 3;
const CUT_MAX_S = 10;
/** handheld position noise amplitude (world units; world scale is 1.35× human) */
const SHAKE_AMP = 0.05;
/** look-target drift amplitude */
const DRIFT_AMP = 0.12;
/** total pan of the look target across a shot, along camera-right */
const PAN_AMP = 0.18;

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

/**
 * Auto-director: hard-cuts every 3–10 s (or on arrow key / active-set change)
 * to a randomized shot framing all currently active monitors, with layered
 * sinusoid noise for a handheld feel within each shot.
 */
export function MovieCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const shot = useRef<Shot | null>(null);
  const shotAge = useRef(0);
  const shotDuration = useRef(0);
  const cutIndex = useRef(0);
  const setKey = useRef('');
  const panDir = useRef(1);
  const wantCut = useRef(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !ARROW_KEYS.has(e.key)) return;
      e.preventDefault();
      wantCut.current = true;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useFrame((state, delta) => {
    const now = Date.now();
    const { office, lastActivity } = useStore.getState();
    const key = activeSetKey(lastActivity, now);
    shotAge.current += delta;

    if (!shot.current || wantCut.current || shotAge.current >= shotDuration.current || key !== setKey.current) {
      wantCut.current = false;
      setKey.current = key;
      shot.current = pickShot({
        office,
        lastActivity,
        now,
        fovY: THREE.MathUtils.degToRad(camera.fov),
        aspect: camera.aspect,
        rng: Math.random,
        cutIndex: cutIndex.current++,
      });
      shotAge.current = 0;
      shotDuration.current = CUT_MIN_S + Math.random() * (CUT_MAX_S - CUT_MIN_S);
      panDir.current = Math.random() < 0.5 ? -1 : 1;
    }

    const t = shotAge.current;
    const s = shot.current;
    // layered irrational-ratio sinusoids read as organic drift rather than a loop
    tmpPos.copy(s.position);
    tmpPos.x += SHAKE_AMP * (Math.sin(t * 1.7) * 0.6 + Math.sin(t * 3.1 + 1.3) * 0.4);
    tmpPos.y += SHAKE_AMP * (Math.sin(t * 2.3 + 0.7) * 0.6 + Math.sin(t * 4.1 + 2.1) * 0.4);
    tmpPos.z += SHAKE_AMP * (Math.sin(t * 1.3 + 2.9) * 0.6 + Math.sin(t * 3.7 + 0.4) * 0.4);

    tmpForward.copy(s.lookAt).sub(s.position).normalize();
    tmpRight.crossVectors(tmpForward, UP).normalize();
    tmpLook.copy(s.lookAt);
    tmpLook.addScaledVector(tmpRight, panDir.current * PAN_AMP * (t / shotDuration.current - 0.5));
    tmpLook.x += DRIFT_AMP * Math.sin(t * 0.9 + 0.2) * 0.5;
    tmpLook.y += DRIFT_AMP * Math.sin(t * 1.1 + 1.7) * 0.5;

    camera.position.copy(tmpPos);
    camera.lookAt(tmpLook);
  });

  return null;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
```

- [ ] **Step 2: Wire the mode branch in `CameraRig.tsx`**

In `web/src/scene/CameraRig.tsx`:

1. Add import: `import { MovieCamera } from './MovieCamera.tsx';`
2. In `CameraRig`, change the POV-follow `useFrame` guard from `if (free) return;` to `if (mode.kind !== 'pov') return;` (movie mode must not fight the tour lerp).
3. Change the return to a three-way branch:

```tsx
  if (mode.kind === 'movie') return <MovieCamera />;
  return free ? <FreeFlyControls /> : null;
```

Note: hooks (`useFrame`) are already called before this return, so the early branch does not change hook order.

- [ ] **Step 3: Add the M key and HUD label in `App.tsx`**

In the `onKey` handler in `App.tsx`, add before the `v` branch:

```ts
      if (e.key === 'm' || e.key === 'M') {
        setMode(cur.kind === 'movie' ? { kind: 'free' } : { kind: 'movie' });
        return;
      }
```

(`return` so a later branch can't also fire; keep the existing `v`/`Escape`/`Tab`/arrow logic untouched — the pov arrow branches already check `cur.kind === 'pov'`, so movie-mode arrows fall through to MovieCamera's own listener.)

In `Hud`, extend the label:

```ts
  const label =
    mode.kind === 'free'
      ? 'Free camera — click to look (Esc releases) · WASD fly · E/Space up · C down · Shift slow · V for POV tour · M movie mode'
      : mode.kind === 'movie'
        ? 'Movie mode — auto-follows the action · arrows cut now · M/Esc exit'
        : `POV: ${povs[Math.min(mode.index, povs.length - 1)]?.label ?? ''} — Tab/← → cycle · V/Esc exit`;
```

- [ ] **Step 4: Verify**

Run: `npm test` — full suite must pass (types compile via vitest; no new unit tests for the thin component).

Manual check (docker compose should already be up; web on :5173): open the app, press **M** — camera should cut to a wide/B-roll shot with visible gentle float; trigger a Claude Code session so monitors light up — camera should cut to close-ups/group shots of active screens within a cut; arrow keys should recut instantly; **M** or **Esc** returns to free cam. If no live session is handy, at minimum confirm M toggles the mode, idle shots alternate wide/close-up, and arrows recut.

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/MovieCamera.tsx web/src/scene/CameraRig.tsx web/src/App.tsx
git commit -m "feat: movie camera mode — auto-director with hard cuts and handheld float (M to toggle)"
```
