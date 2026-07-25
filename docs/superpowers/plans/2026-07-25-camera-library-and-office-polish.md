# Camera Shot Library & Office Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cinematic committed movie-camera shots from an authored archetype library (incl. high/overhead angles), a 5 s screenshot dwell on monitors, per-character seat/chair sliders with a seated preview, and an urban-city environment (skybox, high ceiling with visible lights, transparent windows, camera caged to the room).

**Architecture:** Shot selection stays in pure functions in `web/src/scene/movieShots.ts` (validated-then-committed archetype candidates); the streamer hold is server-side queue state; the sliders extend the existing per-character `scale` pipeline (imported.json → merged catalog → zustand → scene); the environment is static geometry in `Office.tsx` plus an equirect `scene.background`.

**Tech Stack:** TypeScript, React Three Fiber / three, zustand, Node (tsx), vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-camera-library-and-office-polish-design.md`

## Global Constraints

- `MIN_SHOT_DIST = 3.5` world units between consecutive movie-shot positions.
- `MIN_HOLD_S = 2.5` s minimum shot hold; only arrow keys may cut earlier.
- `IMAGE_HOLD_MS = 5000` screenshot dwell.
- Room height `7.5` units; camera y clamped to `[0.4, height − 0.3]`.
- Slider ranges: `seatOffset` ∈ [−0.5, 0.5] (character only), `chairHeight` ∈ [−0.4, 0.4] (chair + character unit). Both server-clamped, default 0.
- LOS spheres shrink to head 0.30 / torso 0.40; the subject's own seat occupant never blocks LOS to their own screen.
- Run tests from repo root: `npx vitest run <file>`. Full suite: `npm test`.
- World scale is ~1.35× human: desk tops y≈1.0, characters ~2.3 tall, cameras look at y≈1.1.
- Commit after every task; never commit `data/` or Mixamo-derived assets.

---

### Task 1: Room height + camera cage

**Files:**
- Modify: `web/src/scene/layout.ts` (roomDims)
- Modify: `web/src/scene/movieShots.ts:51-59` (clampToRoom)
- Modify: `web/src/scene/CameraRig.tsx` (FreeFlyControls useFrame)
- Test: `web/src/scene/movieShots.test.ts`

**Interfaces:**
- Produces: `roomDims(maxSeat)` now returns `{ width, depth, centerZ, height }` with `height === 7.5`. `clampToRoom` clamps y to `[0.4, height − 0.3]`. Later tasks (overhead shots, ceiling mesh, walls) consume `height`.

- [ ] **Step 1: Write failing tests**

Add to `movieShots.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/scene/movieShots.test.ts -t "room height"`
Expected: FAIL — `height` is `undefined`, clamp tops out at 3.9.

- [ ] **Step 3: Implement**

`layout.ts` — add height to `roomDims`:

```ts
export const ROOM_HEIGHT = 7.5;

export function roomDims(maxSeat: number) {
  const rows = Math.max(1, Math.ceil(Math.max(0, maxSeat) / COLS));
  const frontZ = FIRST_ROW_Z + rows * ROW_SPACING + 2.4;
  const depth = frontZ - BACK_Z;
  const width = COLS * COL_SPACING + 5;
  const centerZ = (frontZ + BACK_Z) / 2;
  return { width, depth, centerZ, height: ROOM_HEIGHT };
}
```

`movieShots.ts` — `clampToRoom` uses it:

```ts
export function clampToRoom(pos: THREE.Vector3, office: OfficeState | null): THREE.Vector3 {
  const { width, depth, centerZ, height } = roomDims(maxSeat(office));
  const backZ = centerZ - depth / 2;
  const frontZ = centerZ + depth / 2;
  pos.y = THREE.MathUtils.clamp(pos.y, 0.4, height - 0.3);
  pos.x = THREE.MathUtils.clamp(pos.x, -(width / 2 - 0.3), width / 2 - 0.3);
  pos.z = THREE.MathUtils.clamp(pos.z, backZ + 0.3, frontZ - 0.3);
  return pos;
}
```

`CameraRig.tsx` — cage the free-fly camera. In `FreeFlyControls`'s `useFrame`, after `camera.position.addScaledVector(velocity.current, delta);` add:

```ts
clampToRoom(camera.position, useStore.getState().office);
```

(`clampToRoom` is already imported at the top of CameraRig.tsx.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run web/src/scene/movieShots.test.ts`
Expected: all PASS (existing clamp tests may assert 3.9 — update any that do to `height − 0.3`).

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/layout.ts web/src/scene/movieShots.ts web/src/scene/CameraRig.tsx web/src/scene/movieShots.test.ts
git commit -m "feat: 7.5-unit room height, free-fly camera caged to the room"
```

---

### Task 2: Line-of-sight relaxation

**Files:**
- Modify: `web/src/scene/movieShots.ts:136-150` (`hasLineOfSight`), `:118-129` (`isInsideOccluder` radii)
- Test: `web/src/scene/movieShots.test.ts`

**Interfaces:**
- Produces: `hasLineOfSight(camPos, subject, office)` — same signature; skips the subject's own seat occupant entirely; sphere radii 0.30 (head) / 0.40 (torso). Shot archetypes in Task 3 rely on this to make elevated shots pass.

- [ ] **Step 1: Write failing tests**

```ts
describe('LOS relaxation', () => {
  it('the subject\'s own occupant never blocks their screen', () => {
    const office = makeOffice();
    const subject = subjectFor('e1', office)!;
    // straight down the readable normal at seated-head height: passes right
    // over/through the seat-1 occupant, must still count as visible
    const camPos = subject.center.clone().addScaledVector(subject.normal, 2.2);
    camPos.y = 2.6;
    expect(hasLineOfSight(camPos, subject, office)).toBe(true);
  });

  it('a steep high angle from above the subject\'s own head has LOS', () => {
    const office = makeOffice();
    const subject = subjectFor('e1', office)!;
    const camPos = subject.center.clone()
      .addScaledVector(subject.normal, 1.6)
      .add(new THREE.Vector3(0, 3.5, 0));
    expect(hasLineOfSight(camPos, subject, office)).toBe(true);
  });

  it('OTHER seats\' occupants still block', () => {
    const office = makeOffice(); // e1 seat 1, e2 seat 2 side by side
    const s2 = subjectFor('e2', office)!;
    // aim through seat-1's occupant at seat-2's screen
    const p1 = seatTransform(1).position;
    const camPos = new THREE.Vector3(p1.x - 1.2, 1.5, p1.z - 1.4);
    const through = seatTransform(1).position.clone(); // sanity: segment near seat-1 body
    void through;
    expect(hasLineOfSight(camPos, s2, office)).toBe(false);
  });
});
```

(If the third test's geometry doesn't actually cross seat-1's body spheres, adjust `camPos` until `segmentHitsSphere` triggers — assert the blocking case with a position computed from `personPosition`-style math: camera on the far side of seat 1 from seat 2's screen, at torso height.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/scene/movieShots.test.ts -t "LOS relaxation"`
Expected: first two FAIL (own occupant blocks today).

- [ ] **Step 3: Implement**

In `movieShots.ts`, define radii constants and skip the own seat in the sphere loop:

```ts
const HEAD_R = 0.3;
const TORSO_R = 0.4;

export function hasLineOfSight(camPos: THREE.Vector3, subject: Subject, office: OfficeState | null): boolean {
  const ownSeat = seatForKey(subject.key, office);
  for (const seat of occupiedSeats(office)) {
    if (ownSeat !== null && seat === ownSeat) continue; // over-the-shoulder is the point
    const p = personPosition(seat);
    const head = p.clone().add(new THREE.Vector3(0, 1.8, 0));
    const torso = p.clone().add(new THREE.Vector3(0, 1.25, 0));
    if (segmentHitsSphere(camPos, subject.center, head, HEAD_R)) return false;
    if (segmentHitsSphere(camPos, subject.center, torso, TORSO_R)) return false;
  }
  for (const seat of occupiedSeats(office)) {
    if (ownSeat !== null && seat === ownSeat) continue;
    if (segmentHitsBox(camPos, subject.center, monitorAABB(seat))) return false;
  }
  return true;
}
```

Also update `isInsideOccluder` to use `HEAD_R + 0.05` / `TORSO_R + 0.05` in place of the hardcoded 0.35/0.45 (a camera *at* a body is still unusable).

- [ ] **Step 4: Run tests**

Run: `npx vitest run web/src/scene/movieShots.test.ts`
Expected: PASS (some existing LOS tests may assume the own-body block — update them to use a *different* seat's occupant as the blocker).

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/movieShots.ts web/src/scene/movieShots.test.ts
git commit -m "fix: LOS ignores the subject's own occupant, shrinks body spheres"
```

---

### Task 3: Shot archetype library

**Files:**
- Modify: `web/src/scene/movieShots.ts` (archetypes, validation, `pickShot` rework)
- Test: `web/src/scene/movieShots.test.ts`

**Interfaces:**
- Consumes: `roomDims().height` (Task 1), relaxed `hasLineOfSight` (Task 2).
- Produces (Task 4 consumes exactly these):

```ts
export const MIN_SHOT_DIST = 3.5;
export type ArchetypeName =
  | 'otsCloseup' | 'highAngle' | 'sideProfile'
  | 'groupLevel' | 'elevatedGroup'
  | 'overheadGod' | 'highCorner' | 'lowDolly' | 'wideEstablishing';
export interface PickedShot extends Shot { archetype: ArchetypeName }
export interface ShotContext {
  office: OfficeState | null;
  lastActivity: Record<string, number>;
  now: number;
  fovY: number;   // radians
  aspect: number;
  rng: () => number;
  cutIndex: number;
  prevPosition?: THREE.Vector3 | null;
  recentArchetypes?: ArchetypeName[]; // last two, most recent first
}
export function pickShot(ctx: ShotContext): PickedShot
```

- [ ] **Step 1: Write failing tests**

```ts
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
```

Update the imports at the top of the test file (`pickShot`, `MIN_SHOT_DIST`, `type ArchetypeName`, `type ShotContext`, `type PickedShot`). Existing `pickShot` tests that assert the old close-up/wide alternation should be rewritten against the pools above; existing direct `closeUpShot`/`groupShot` tests keep working (those functions remain as fallbacks).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/scene/movieShots.test.ts -t "archetype"`
Expected: FAIL — `PickedShot`/`MIN_SHOT_DIST` not exported, `pickShot` returns plain `Shot`.

- [ ] **Step 3: Implement**

In `movieShots.ts`:

```ts
export const MIN_SHOT_DIST = 3.5;

export type ArchetypeName =
  | 'otsCloseup' | 'highAngle' | 'sideProfile'
  | 'groupLevel' | 'elevatedGroup'
  | 'overheadGod' | 'highCorner' | 'lowDolly' | 'wideEstablishing';

export interface PickedShot extends Shot { archetype: ArchetypeName }

/** A candidate passes only if it's outside all occluders, far enough from the
 *  previous shot, and sees every subject. Empty subjects (idle B-roll) skips LOS. */
function validCandidate(
  pos: THREE.Vector3,
  subjects: Subject[],
  office: OfficeState | null,
  prev: THREE.Vector3 | null,
): boolean {
  if (isInsideOccluder(pos, office)) return false;
  if (prev && pos.distanceTo(prev) < MIN_SHOT_DIST) return false;
  return subjects.every((s) => hasLineOfSight(pos, s, office));
}
```

Single-candidate generators (each call produces ONE randomized `Shot`; the picker loops them). Reuse `jitterDir`, `fitDistance`, `clampToRoom`:

```ts
const deg = THREE.MathUtils.degToRad;

/** One candidate around dir, pitched within [pitchMin,pitchMax], at dist·mul from the subject. */
function subjectCandidate(
  subject: Subject, fovY: number, aspect: number, rng: () => number,
  office: OfficeState | null,
  yawRange: number, pitchMin: number, pitchMax: number, distMul: number, margin: number,
): Shot {
  const dist = fitDistance(subject.width, subject.height, fovY, aspect, margin) * distMul;
  const dir = jitterDir(subject.normal, rng, yawRange, pitchMin, pitchMax);
  const position = clampToRoom(subject.center.clone().addScaledVector(dir, dist), office);
  return { position, lookAt: subject.center.clone() };
}

function otsCloseupCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  return subjectCandidate(s, fovY, aspect, rng, office, CLOSEUP_YAW, CLOSEUP_PITCH_MIN, CLOSEUP_PITCH_MAX, 1, 1.3);
}

function highAngleCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  return subjectCandidate(s, fovY, aspect, rng, office, deg(35), deg(45), deg(65), 1.6, 1.3);
}

function sideProfileCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  const sign = rng() < 0.5 ? -1 : 1;
  const yaw = sign * (deg(55) + rng() * deg(25));
  const pitch = deg(5) + rng() * deg(15);
  const dist = fitDistance(s.width, s.height, fovY, aspect, 1.3) * 1.8;
  const dir = jitterDir(s.normal.clone().applyAxisAngle(UP, yaw), rng, 0, pitch, pitch);
  const position = clampToRoom(s.center.clone().addScaledVector(dir, dist), office);
  return { position, lookAt: s.center.clone() };
}
```

Refactor `groupShot`'s geometry so a per-candidate helper exists (extract the centroid/avgNormal/dist prologue into `groupFraming(subjects, fovY, aspect)` returning `{ centroid, avgNormal, dist }`, and keep `groupShot` itself as the fully-fallback-capable function it is today, now built on the helper):

```ts
function groupCandidate(
  subjects: Subject[], fovY: number, aspect: number, rng: () => number,
  office: OfficeState | null, pitchMin: number, pitchMax: number,
): Shot {
  const { centroid, avgNormal, dist } = groupFraming(subjects, fovY, aspect);
  const dir = jitterDir(avgNormal, rng, GROUP_YAW, pitchMin, pitchMax);
  const position = clampToRoom(centroid.clone().addScaledVector(dir, dist), office);
  return { position, lookAt: centroid.clone() };
}
// groupLevel: pitch 5–20° (existing GROUP_PITCH_MIN/MAX); elevatedGroup: pitch 25–45°
```

Idle candidates (no subjects; `office` gives room bounds — `const { width, depth, centerZ, height } = roomDims(maxSeat(office))` inside each):

```ts
function overheadGodCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { centerZ, height } = roomDims(maxSeat(office));
  const lookAt = new THREE.Vector3(0, 1.0, centerZ + (rng() - 0.5) * 2);
  const pitch = deg(55) + rng() * deg(20);          // 55–75° down
  const y = height - 1.0 - rng() * 0.8;             // near the ceiling
  const horiz = (y - lookAt.y) / Math.tan(pitch);   // distance that yields that pitch
  const a = rng() * Math.PI * 2;
  const position = clampToRoom(
    new THREE.Vector3(lookAt.x + Math.cos(a) * horiz, y, lookAt.z + Math.sin(a) * horiz), office);
  return { position, lookAt };
}

function highCornerCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ } = roomDims(maxSeat(office));
  const sx = rng() < 0.5 ? -1 : 1;
  const sz = rng() < 0.5 ? -1 : 1;
  const position = clampToRoom(new THREE.Vector3(
    sx * (width / 2 - 0.6), 3.0 + rng() * 0.5, centerZ + sz * (depth / 2 - 0.6)), office);
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
}

function lowDollyCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ } = roomDims(maxSeat(office));
  const sx = rng() < 0.5 ? -1 : 1;
  const z = centerZ + (rng() - 0.5) * depth * 0.6;
  const position = clampToRoom(new THREE.Vector3(sx * (width / 2 - 1.0), 1.1 + rng() * 0.3, z), office);
  return { position, lookAt: new THREE.Vector3(0, 1.3, z + (rng() - 0.5) * 2) };
}

function wideEstablishingCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ, height } = roomDims(maxSeat(office));
  const angle = rng() * Math.PI * 2;
  const position = clampToRoom(new THREE.Vector3(
    Math.cos(angle) * width * 0.42, 2.2 + rng() * (height - 4.2), centerZ + Math.sin(angle) * depth * 0.42), office);
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
}
```

Pools + picker. `pickShot` becomes:

```ts
const SINGLE_POOL: ArchetypeName[] = ['otsCloseup', 'highAngle', 'sideProfile'];
const GROUP_POOL: ArchetypeName[] = ['groupLevel', 'elevatedGroup'];
const IDLE_POOL: ArchetypeName[] = ['overheadGod', 'highCorner', 'lowDolly', 'wideEstablishing'];

export interface ShotContext {
  office: OfficeState | null;
  lastActivity: Record<string, number>;
  now: number;
  fovY: number;
  aspect: number;
  rng: () => number;
  cutIndex: number;
  /** committed position of the previous shot; candidates closer than MIN_SHOT_DIST are rejected */
  prevPosition?: THREE.Vector3 | null;
  /** archetype names of the last two shots — never repeated */
  recentArchetypes?: ArchetypeName[];
}

export function pickShot(ctx: ShotContext): PickedShot {
  const { office, fovY, aspect, rng, cutIndex } = ctx;
  const prev = ctx.prevPosition ?? null;
  const recent = ctx.recentArchetypes ?? [];
  const subjects = activeKeys(ctx.lastActivity, ctx.now)
    .map((k) => subjectFor(k, office))
    .filter((s): s is Subject => s !== null);

  /** fresh archetypes first (random order), recently-used ones as a last resort */
  const order = (pool: ArchetypeName[]): ArchetypeName[] => {
    const fresh = pool.filter((n) => !recent.includes(n));
    for (let i = fresh.length - 1; i > 0; i--) {         // Fisher–Yates via ctx.rng
      const j = Math.floor(rng() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
    return [...fresh, ...pool.filter((n) => recent.includes(n))];
  };

  const attempt = (name: ArchetypeName, gen: () => Shot, losSubjects: Subject[]): PickedShot | null => {
    for (let i = 0; i < LOS_CANDIDATES; i++) {
      const shot = gen();
      if (validCandidate(shot.position, losSubjects, office, prev)) return { ...shot, archetype: name };
    }
    return null;
  };

  if (subjects.length === 0) {
    const gens: Record<string, () => Shot> = {
      overheadGod: () => overheadGodCandidate(office, rng),
      highCorner: () => highCornerCandidate(office, rng),
      lowDolly: () => lowDollyCandidate(office, rng),
      wideEstablishing: () => wideEstablishingCandidate(office, rng),
    };
    for (const name of order(IDLE_POOL)) {
      const hit = attempt(name, gens[name], []);
      if (hit) return hit;
    }
    return { ...wideShot(office, rng), archetype: 'wideEstablishing' }; // last-resort, unvalidated
  }

  const groups = groupByFacing(subjects);
  const group = groups[cutIndex % groups.length];

  if (group.length === 1) {
    const s = group[0];
    const gens: Record<string, () => Shot> = {
      otsCloseup: () => otsCloseupCandidate(s, fovY, aspect, rng, office),
      highAngle: () => highAngleCandidate(s, fovY, aspect, rng, office),
      sideProfile: () => sideProfileCandidate(s, fovY, aspect, rng, office),
    };
    for (const name of order(SINGLE_POOL)) {
      const hit = attempt(name, gens[name], [s]);
      if (hit) return hit;
    }
    return { ...closeUpShot(s, fovY, aspect, rng, office), archetype: 'otsCloseup' }; // best-effort fallback
  }

  const gens: Record<string, () => Shot> = {
    groupLevel: () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX),
    elevatedGroup: () => groupCandidate(group, fovY, aspect, rng, office, deg(25), deg(45)),
  };
  for (const name of order(GROUP_POOL)) {
    const hit = attempt(name, gens[name], group);
    if (hit) return hit;
  }
  return { ...groupShot(group, fovY, aspect, rng, office), archetype: 'groupLevel' }; // best-effort fallback
}
```

Keep `closeUpShot`, `groupShot`, `wideShot` intact (they are the unvalidated last-resort paths and existing tests cover them). Delete nothing else.

- [ ] **Step 4: Run tests**

Run: `npx vitest run web/src/scene/movieShots.test.ts`
Expected: PASS. Fix any old `pickShot` tests that asserted the retired close-up/wide alternation.

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/movieShots.ts web/src/scene/movieShots.test.ts
git commit -m "feat: authored shot archetype library with validated, min-distance candidates"
```

---

### Task 4: Committed shots + minimum hold in MovieCamera

**Files:**
- Modify: `web/src/scene/MovieCamera.tsx`

**Interfaces:**
- Consumes: `pickShot(ctx): PickedShot`, `ArchetypeName` (Task 3).
- Produces: no exports change; behavior only.

- [ ] **Step 1: Implement** (no unit test — this is R3F frame-loop glue; the logic lives in Task 3's pure functions)

Rework the cut condition in `MovieCamera.tsx`'s `useFrame`:

```ts
const MIN_HOLD_S = 2.5;
```

Add refs:

```ts
const prevPos = useRef<THREE.Vector3 | null>(null);
const recent = useRef<ArchetypeName[]>([]);
const pendingRecut = useRef(false);
```

Replace the cut block:

```ts
if (key !== setKey.current) {
  setKey.current = key;
  pendingRecut.current = true; // honored only once the hold expires
}
const held = shotAge.current < MIN_HOLD_S;
if (!shot.current || wantCut.current || (!held && (pendingRecut.current || shotAge.current >= shotDuration.current))) {
  wantCut.current = false;
  pendingRecut.current = false;
  const picked = pickShot({
    office, lastActivity, now,
    fovY: THREE.MathUtils.degToRad(camera.fov),
    aspect: camera.aspect,
    rng: Math.random,
    cutIndex: cutIndex.current++,
    prevPosition: prevPos.current,
    recentArchetypes: recent.current,
  });
  shot.current = picked;
  prevPos.current = picked.position.clone();
  recent.current = [picked.archetype, ...recent.current].slice(0, 2);
  shotAge.current = 0;
  shotDuration.current = CUT_MIN_S + Math.random() * (CUT_MAX_S - CUT_MIN_S);
  panDir.current = Math.random() < 0.5 ? -1 : 1;
}
```

Import `type ArchetypeName` from `./movieShots.ts`. Nothing else in the frame loop changes — the shot is committed; only the handheld sinusoids move.

- [ ] **Step 2: Verify in the app**

Run `docker compose up` (or confirm it's already running — source is bind-mounted, changes hot-reload). Open :5173, switch to movie mode. Confirm: cuts land in visibly different places (never a small sidestep), high/overhead angles appear within a dozen idle cuts, and no shot re-jumps within its first half-second even when activity starts/stops.

- [ ] **Step 3: Run the full web test file + typecheck**

Run: `npx vitest run web/src/scene/ && npx tsc -p web --noEmit`
Expected: PASS / no errors. (If the repo has no per-package tsconfig for this, `npm test` suffices.)

- [ ] **Step 4: Commit**

```bash
git add web/src/scene/MovieCamera.tsx
git commit -m "feat: movie camera commits to each shot with a 2.5s minimum hold"
```

---

### Task 5: Screenshot dwell in the streamer

**Files:**
- Modify: `server/src/streamer.ts`
- Test: `server/src/streamer.test.ts`

**Interfaces:**
- Consumes: `MONITOR_IMAGE_MARKER` from `shared/types.ts`.
- Produces: `export const IMAGE_HOLD_MS = 5000`. Queue behavior: emission splits at an image line; the queue then holds (no emits, `isDraining` true) for 5 s; `drained` defers past the hold.

- [ ] **Step 1: Write failing tests**

Add to `streamer.test.ts` (top: `import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';` and add `IMAGE_HOLD_MS` to the streamer import):

```ts
describe('image dwell', () => {
  const IMG = `${MONITOR_IMAGE_MARKER}data:image/png;base64,AAAA`;

  it('splits an emission at the image line and holds 5s before resuming', () => {
    const s = new ScreenStreamer(hooks, 150);
    // 3000 lines → rate 5/tick, so the first tick would emit 5 lines at once
    const lines = [`a`, IMG, ...Array.from({ length: 2998 }, (_, i) => `l${i}`)];
    s.enqueue('emp-1', lines.join('\n'));
    vi.advanceTimersByTime(150);
    // emission stopped AT the image line, not the full 5-line chunk
    expect(emitted).toHaveLength(1);
    expect(emitted[0].text.split('\n')).toEqual(['a', IMG]);
    // held: nothing more for 5s
    vi.advanceTimersByTime(IMAGE_HOLD_MS - 150);
    expect(emitted).toHaveLength(1);
    expect(s.isDraining('emp-1')).toBe(true);
    // resumes after the hold
    vi.advanceTimersByTime(600);
    expect(emitted.length).toBeGreaterThan(1);
  });

  it('defers drained() until the hold expires when the image is last', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', IMG);
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    expect(emitted.map((e) => e.text)).toEqual([IMG]);
    expect(drained).toEqual([]);                    // not yet
    expect(s.isDraining('emp-1')).toBe(true);       // employee stays working
    vi.advanceTimersByTime(IMAGE_HOLD_MS + 300);
    expect(drained).toEqual(['emp-1']);
    expect(s.isDraining('emp-1')).toBe(false);
  });

  it('a non-image line is unaffected', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'plain');
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    expect(drained).toEqual(['emp-1']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/src/streamer.test.ts -t "image dwell"`
Expected: FAIL — `IMAGE_HOLD_MS` not exported; no split/hold behavior.

- [ ] **Step 3: Implement**

In `streamer.ts`:

```ts
import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';

/** A screenshot stays on screen this long — the employee "examines" it. */
export const IMAGE_HOLD_MS = 5000;
```

`Queue` gains `holdUntil?: number`. New `tick()`:

```ts
private tick() {
  const now = Date.now();
  for (const [id, q] of this.queues) {
    if (q.holdUntil !== undefined) {
      if (now < q.holdUntil) continue;          // dwell on the screenshot
      q.holdUntil = undefined;
      if (q.lines.length === 0) {
        this.queues.delete(id);
        this.hooks.drained(id);
        continue;
      }
    }
    q.acc += Math.max(BASE_LINES_PER_TICK, q.rate) * (1 + this.pressure) * (this.boost ? BOOST_FACTOR : 1);
    let n = Math.min(q.lines.length, Math.floor(q.acc));
    // an image line ends its chunk: emit up to and including it, then hold
    const imgIdx = q.lines.slice(0, n).findIndex((l) => l.startsWith(MONITOR_IMAGE_MARKER));
    if (imgIdx !== -1) n = imgIdx + 1;
    if (n > 0) {
      q.acc -= n;
      const chunk = q.lines.splice(0, n);
      this.hooks.emit(id, chunk.join('\n'));
      if (chunk[chunk.length - 1].startsWith(MONITOR_IMAGE_MARKER)) {
        q.holdUntil = now + IMAGE_HOLD_MS;
        continue;                                // drained() waits out the hold
      }
    }
    if (q.lines.length === 0) {
      this.queues.delete(id);
      this.hooks.drained(id);
    }
  }
  if (this.queues.size === 0) this.stop();
}
```

(`vi.useFakeTimers()` fakes `Date.now`, so the tests above are deterministic. A held queue keeps `queues.size > 0`, so the interval keeps running through the hold — correct.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/src/streamer.test.ts server/src/queue.integration.test.ts`
Expected: PASS (the integration test exercises drain timing — confirm no image lines are involved there).

- [ ] **Step 5: Commit**

```bash
git add server/src/streamer.ts server/src/streamer.test.ts
git commit -m "feat: monitors dwell 5s on screenshots before resuming/draining"
```

---

### Task 6: seatOffset/chairHeight — server + shared types

**Files:**
- Modify: `shared/types.ts` (CharacterEntry)
- Modify: `server/src/characters.ts`
- Modify: `server/src/index.ts:85-98` (PATCH handler)
- Test: `server/src/characters.test.ts`

**Interfaces:**
- Produces:
  - `CharacterEntry` gains `seatOffset?: number; chairHeight?: number;`
  - `export function clampOffset(v: number, range: number): number` (clamps to ±range, non-finite → 0)
  - `export const SEAT_OFFSET_RANGE = 0.5; export const CHAIR_HEIGHT_RANGE = 0.4;`
  - `export interface CharacterAdjust { scale?: number; seatOffset?: number; chairHeight?: number }`
  - `CharacterStore.adjust(id: string, adj: CharacterAdjust): boolean` (replaces `setScale`; update its callers)
  - PATCH `/api/characters/:id` accepts any subset of `{scale, seatOffset, chairHeight}` (≥1 finite number required).

- [ ] **Step 1: Write failing tests**

Add to `characters.test.ts` (mirror the existing `clampScale` describe-block style; the existing `CharacterStore` tests show how the store is constructed in tests):

```ts
describe('clampOffset', () => {
  it('passes in-range values, clamps out-of-range, zeroes non-finite', () => {
    expect(clampOffset(0.2, 0.5)).toBe(0.2);
    expect(clampOffset(-0.7, 0.5)).toBe(-0.5);
    expect(clampOffset(9, 0.4)).toBe(0.4);
    expect(clampOffset(NaN, 0.5)).toBe(0);
    expect(clampOffset(Infinity, 0.5)).toBe(0);
  });
});

describe('CharacterStore.adjust', () => {
  it('persists clamped seatOffset/chairHeight and surfaces them in the catalog', () => {
    // construct the store the same way the existing register/setScale tests do
    const store = new CharacterStore();
    // ...register a character 'test_char' per the existing test pattern...
    expect(store.adjust('test_char', { seatOffset: 0.9, chairHeight: -0.2 })).toBe(true);
    const entry = store.mergedCatalog().characters.find((c) => c.id === 'test_char')!;
    expect(entry.seatOffset).toBe(0.5);   // clamped
    expect(entry.chairHeight).toBe(-0.2);
  });

  it('returns false for unknown ids and leaves other fields alone', () => {
    const store = new CharacterStore();
    expect(store.adjust('nope', { seatOffset: 0.1 })).toBe(false);
  });
});
```

(Follow the existing file's setup/teardown for temp data dirs exactly — `characters.test.ts` already isolates `data/`; reuse its helpers.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/src/characters.test.ts`
Expected: FAIL — `clampOffset`/`adjust` don't exist.

- [ ] **Step 3: Implement**

`shared/types.ts`, next to `scale?: number;`:

```ts
  /** vertical offset of the character alone (plants them on the chair seat); absent = 0 */
  seatOffset?: number;
  /** vertical offset of chair + character as a unit (lines hands up with the desk); absent = 0 */
  chairHeight?: number;
```

`server/src/characters.ts`:

```ts
export const SEAT_OFFSET_RANGE = 0.5;
export const CHAIR_HEIGHT_RANGE = 0.4;

export function clampOffset(v: number, range: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(range, Math.max(-range, v));
}

export interface CharacterAdjust {
  scale?: number;
  seatOffset?: number;
  chairHeight?: number;
}
```

`ImportedMeta` gains `seatOffset?: number; chairHeight?: number;`. Replace `setScale` with:

```ts
  adjust(id: string, adj: CharacterAdjust): boolean {
    const meta = this.imported.find((m) => m.id === id);
    if (!meta) return false;
    if (adj.scale !== undefined) meta.scale = clampScale(adj.scale);
    if (adj.seatOffset !== undefined) meta.seatOffset = clampOffset(adj.seatOffset, SEAT_OFFSET_RANGE);
    if (adj.chairHeight !== undefined) meta.chairHeight = clampOffset(adj.chairHeight, CHAIR_HEIGHT_RANGE);
    this.saveMeta();
    return true;
  }
```

`mergedCatalog()` passes both through: add `seatOffset: m.seatOffset, chairHeight: m.chairHeight,` beside `scale: m.scale`.

`server/src/index.ts` PATCH handler:

```ts
    if (charMatch && req.method === 'PATCH') {
      const id = sanitizeId(charMatch[1]);
      if (!id) return send(400, { error: 'bad character id' });
      const body = await readBody();
      const patch: { scale?: number; seatOffset?: number; chairHeight?: number } = {};
      for (const f of ['scale', 'seatOffset', 'chairHeight'] as const) {
        if (typeof body?.[f] === 'number' && Number.isFinite(body[f])) patch[f] = body[f];
      }
      if (Object.keys(patch).length === 0) {
        return send(400, { error: 'need at least one finite number: scale, seatOffset, chairHeight' });
      }
      // builtins are never in the imported list, so adjust 404s them too
      if (!characters.adjust(id, patch)) {
        return send(404, { error: 'not an imported character' });
      }
      publishCatalog();
      return send(200, { ok: true });
    }
```

Update any remaining `setScale` callers/tests to `adjust(id, { scale })`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/src/characters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts server/src/characters.ts server/src/index.ts server/src/characters.test.ts
git commit -m "feat: per-character seatOffset/chairHeight persisted and served via PATCH"
```

---

### Task 7: Apply offsets in the scene (store, Person, Desk)

**Files:**
- Modify: `web/src/store.ts` (generalize `setCharacterScale`)
- Modify: `web/src/scene/Person.tsx`
- Modify: `web/src/scene/Desk.tsx`
- Test: `web/src/store.test.ts`

**Interfaces:**
- Consumes: `CharacterEntry.seatOffset/chairHeight` (Task 6), `CharacterAdjust` shape.
- Produces: store action `patchCharacter(id: string, patch: { scale?: number; seatOffset?: number; chairHeight?: number }): void` — replaces `setCharacterScale` (update its one caller in `CharacterPreview.tsx` minimally here; the full preview rework is Task 8).

- [ ] **Step 1: Write failing test**

In `store.test.ts`, find the existing `setCharacterScale` test and replace/extend:

```ts
it('patchCharacter optimistically patches any adjustment field', () => {
  // seed a catalog the same way the existing setCharacterScale test does
  useStore.getState().applyServerMsg({
    type: 'catalog',
    catalog: { version: 1, generatedAt: '', clipAliases: {}, characters: [
      { id: 'imp', displayName: 'Imp', pack: 'Mixamo', tags: [], rig: 'embedded' },
    ] },
  } as never);
  useStore.getState().patchCharacter('imp', { scale: 2, seatOffset: 0.1, chairHeight: -0.2 });
  const c = useStore.getState().catalog!.characters.find((x) => x.id === 'imp')!;
  expect(c.scale).toBe(2);
  expect(c.seatOffset).toBe(0.1);
  expect(c.chairHeight).toBe(-0.2);
});
```

(Match the actual catalog-seeding helper already used in `store.test.ts` rather than the inline literal above if one exists.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/store.test.ts`
Expected: FAIL — `patchCharacter` doesn't exist.

- [ ] **Step 3: Implement**

`store.ts` — replace `setCharacterScale`:

```ts
  /** optimistic local patch while an adjustment slider drags; server broadcast confirms it */
  patchCharacter: (id: string, patch: { scale?: number; seatOffset?: number; chairHeight?: number }) => void;
```

```ts
  patchCharacter: (id, patch) =>
    set((s) =>
      s.catalog
        ? { catalog: { ...s.catalog, characters: s.catalog.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) } }
        : {},
    ),
```

Update `CharacterPreview.tsx`'s `ScaleSlider` to call `patchCharacter(id, { scale: value })` (full slider rework comes in Task 8 — just keep it compiling here).

`Person.tsx` — apply `seatOffset` to the model only:

```ts
  const scale = entry?.scale ?? 1;
  const seatOffset = entry?.seatOffset ?? 0;
```

```tsx
      <primitive object={clone} scale={scale} position={[0, seatOffset, 0]} />
```

and in the no-head-bone fallback: `headLocal.set(0, FALLBACK_HEAD_TOP * scale + seatOffset, 0);` (the head-bone path reads world bone positions, so it follows automatically).

`Desk.tsx` — chair + person move as a unit. Add imports `{ catalogEntry }` from `../characters/catalog.ts`, then:

```ts
  const chairHeight = useStore((s) => catalogEntry(s.catalog, variant)?.chairHeight ?? 0);
```

```tsx
      <FurnitureModel
        url={boss ? '/models/furniture/armchair_pillows.gltf' : '/models/furniture/chair_A.gltf'}
        position={[0, chairHeight, -1.45]}
        rotation={[0, 0, 0]}
      />
```

and the Person: `position={[0, 0.02 + chairHeight, -1.15]}`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run web/src/store.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.ts web/src/store.test.ts web/src/scene/Person.tsx web/src/scene/Desk.tsx web/src/settings/picker/CharacterPreview.tsx
git commit -m "feat: seatOffset/chairHeight applied to seated characters and chairs"
```

---

### Task 8: Seated preview with three sliders

**Files:**
- Modify: `web/src/settings/picker/CharacterPreview.tsx`

**Interfaces:**
- Consumes: `patchCharacter` (Task 7), `FurnitureModel` (exported from `web/src/scene/Desk.tsx`), `resolveClip(actions, 'Sit_Chair_Idle', aliases)`, catalog fields from Task 6.
- Produces: UI only.

- [ ] **Step 1: Implement the seated preview scene**

In `CharacterPreview.tsx`: for Mixamo entries render a seated desk scene; other packs keep the current spinning idle preview.

```tsx
import { FurnitureModel } from '../../scene/Desk.tsx';
```

In the `Canvas` (bump camera so desk + character fit; keep lookAt y≈1.1 per world scale):

```tsx
        <Canvas
          dpr={[1, 1.5]}
          camera={{ position: [3.1, 2.5, -3.3], fov: 40 }}
          onCreated={({ camera }) => camera.lookAt(0, 1.1, -0.6)}
          shadows
        >
```

(Only apply the new camera when seated; simplest: key the `Canvas` per mode with `camera` chosen by `shown?.pack === 'Mixamo'`, or use two Canvas branches. Keep the ground `circleGeometry` radius at 2.4 for the desk.)

```tsx
          {shown && (
            <Suspense fallback={null}>
              {shown.pack === 'Mixamo' ? <SeatedPreview key={shown.id} entry={shown} /> : <PreviewModel key={shown.id} entry={shown} />}
            </Suspense>
          )}
```

```tsx
/** The character sitting at a real desk+chair — same offsets as Desk.tsx — so
 *  Size / Seat offset / Chair height are judged against desk-top and seat. */
function SeatedPreview({ entry }: { entry: CharacterEntry }) {
  const live = useStore((s) => catalogEntry(s.catalog, entry.id));
  const chairHeight = live?.chairHeight ?? 0;
  return (
    <group rotation={[0, 0.55, 0]}>
      <FurnitureModel url="/models/furniture/table_medium.gltf" />
      <FurnitureModel url="/models/furniture/chair_A.gltf" position={[0, chairHeight, -1.45]} />
      <SeatedModel entry={entry} position={[0, 0.02 + chairHeight, -1.15]} />
    </group>
  );
}

function SeatedModel({ entry, position }: { entry: CharacterEntry; position: [number, number, number] }) {
  const catalog = useStore((s) => s.catalog);
  const live = catalogEntry(catalog, entry.id);
  const scale = live?.scale ?? 1;
  const seatOffset = live?.seatOffset ?? 0;
  const { clone, clips } = useCharacterModel(entry.id, entry);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(clips, group);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.frustumCulled = false;
      }
    });
  }, [clone]);

  // resolve in an effect, not render — actions are null until the group mounts (see Person.tsx)
  const [sit, setSit] = useState<THREE.AnimationAction | null>(null);
  useEffect(() => {
    setSit(resolveClip(actions, 'Sit_Chair_Idle', catalog?.clipAliases));
  }, [actions, catalog]);
  useEffect(() => {
    sit?.reset().play();
    return () => { sit?.stop(); };
  }, [sit]);

  return (
    <group ref={group} position={position}>
      <primitive object={clone} scale={scale} position={[0, seatOffset, 0]} />
    </group>
  );
}
```

- [ ] **Step 2: Generalize the slider**

Replace `ScaleSlider` with one component covering all three (same debounce/flush/PATCH pattern as today, now with `patchCharacter` and a field name):

```tsx
interface AdjustSpec {
  field: 'scale' | 'seatOffset' | 'chairHeight';
  label: string;
  min: number; max: number; step: number;
  fallback: number;
  /** slider-value ↔ real-value mapping (scale is log10; offsets are identity) */
  toSlider: (v: number) => number;
  fromSlider: (v: number) => number;
  format: (v: number) => string;
}

const ADJUSTS: AdjustSpec[] = [
  { field: 'scale', label: 'Size', min: -1, max: 1, step: 0.01, fallback: 1,
    toSlider: Math.log10, fromSlider: (v) => Number((10 ** v).toFixed(2)), format: (v) => `${v.toFixed(2)}×` },
  { field: 'seatOffset', label: 'Seat offset', min: -0.5, max: 0.5, step: 0.01, fallback: 0,
    toSlider: (v) => v, fromSlider: (v) => v, format: (v) => v.toFixed(2) },
  { field: 'chairHeight', label: 'Chair height', min: -0.4, max: 0.4, step: 0.01, fallback: 0,
    toSlider: (v) => v, fromSlider: (v) => v, format: (v) => v.toFixed(2) },
];

function AdjustSlider({ id, spec }: { id: string; spec: AdjustSpec }) {
  const value = useStore((s) => catalogEntry(s.catalog, id)?.[spec.field] ?? spec.fallback);
  const patchCharacter = useStore((s) => s.patchCharacter);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);

  const persist = useCallback((v: number) => {
    pending.current = null;
    fetch(`/api/characters/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [spec.field]: v }),
    }).catch(() => { /* slider keeps working locally; next successful PATCH wins */ });
  }, [id, spec.field]);

  const apply = (v: number) => {
    patchCharacter(id, { [spec.field]: v });
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(v), 300);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current !== null) persist(pending.current);
  }, [persist]);

  return (
    <div style={styles.scaleRow}>
      <span style={styles.scaleLabel}>{spec.label}</span>
      <input type="range" min={spec.min} max={spec.max} step={spec.step}
        value={spec.toSlider(value)}
        onChange={(e) => apply(spec.fromSlider(Number(e.target.value)))}
        style={{ flex: 1 }} />
      <span style={styles.scaleValue}>{spec.format(value)}</span>
      <button style={styles.scaleReset} onClick={() => apply(spec.fallback)} title="Reset">↺</button>
    </div>
  );
}
```

Footer renders all three for Mixamo entries:

```tsx
        {entry?.pack === 'Mixamo' && ADJUSTS.map((spec) => (
          <AdjustSlider key={`${entry.id}:${spec.field}`} id={entry.id} spec={spec} />
        ))}
```

- [ ] **Step 3: Verify in the app**

Open the settings → character picker, select a Mixamo import: the preview shows them seated at desk+chair with the sit animation. Drag each slider: Seat offset moves only the character; Chair height moves chair+character; both persist across a page reload and show up on the live office desk.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/settings/picker/CharacterPreview.tsx
git commit -m "feat: seated desk preview with size/seat-offset/chair-height sliders"
```

---

### Task 9: Urban skybox

**Files:**
- Create: `web/public/skybox/city.jpg` (generated asset, committed)
- Create: `web/src/scene/Skybox.tsx`
- Modify: `web/src/App.tsx` (mount inside the Canvas)

**Interfaces:**
- Produces: `<Skybox />` — sets `scene.background` to the equirect texture; cleans up on unmount.

- [ ] **Step 1: Generate the panorama**

Use the fal.ai MCP tools (`mcp__fal-ai__recommend_model` → `mcp__fal-ai__run_model`) to generate ONE equirectangular urban panorama. Prompt guidance: "photorealistic 360 equirectangular panorama, view from a mid-rise office floor in a dense modern city, glass and concrete towers, overcast late-afternoon light, no people, seamless horizontal wrap", aspect/size 2:1 (e.g. 2048×1024). Prefer a model/preset that supports equirect/360 output; otherwise generate 2:1 and check the seam. Download the result:

```bash
mkdir -p web/public/skybox
curl -sSo web/public/skybox/city.jpg "<result-url>"
```

Sanity: `file web/public/skybox/city.jpg` shows a JPEG ~2:1; open it and check the left/right edges roughly continue each other (minor seam is acceptable behind mullions).

- [ ] **Step 2: Skybox component**

`web/src/scene/Skybox.tsx`:

```tsx
import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';

/** Static equirect city panorama as the scene background — zero per-frame cost. */
export function Skybox() {
  const scene = useThree((s) => s.scene);
  const tex = useTexture('/skybox/city.jpg');
  useEffect(() => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const prev = scene.background;
    scene.background = tex;
    return () => {
      scene.background = prev;
    };
  }, [scene, tex]);
  return null;
}
```

Mount it inside the `<Canvas>` in `App.tsx` (wrapped in the existing `Suspense` if the canvas has one; add `<Suspense fallback={null}><Skybox /></Suspense>` otherwise). If `App.tsx` sets a solid `<color attach="background">`, remove that — the skybox replaces it.

- [ ] **Step 3: Verify in the app**

The sky is only visible through windows after Task 10; temporarily fly above the wall line (walls are still 4.2 until Task 10) or check the canvas background changed from the flat color to the city.

- [ ] **Step 4: Commit**

```bash
git add web/public/skybox/city.jpg web/src/scene/Skybox.tsx web/src/App.tsx
git commit -m "feat: static urban equirect skybox"
```

---

### Task 10: Ceiling, visible light fixtures, transparent windows

**Files:**
- Create: `web/src/scene/wallOpenings.ts`
- Create: `web/src/scene/wallOpenings.test.ts`
- Modify: `web/src/scene/Office.tsx`

**Interfaces:**
- Consumes: `roomDims().height` (Task 1), skybox visible through glass (Task 9).
- Produces:

```ts
export interface Rect { x: number; y: number; w: number; h: number }
/** Split a w×h wall (centered at origin) into up to 4 solid strips around an
 *  opening centered at (ox,oy) with size ow×oh. Zero-area strips are omitted. */
export function wallStrips(w: number, h: number, ox: number, oy: number, ow: number, oh: number): Rect[]
```

- [ ] **Step 1: Write failing tests**

`web/src/scene/wallOpenings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { wallStrips } from './wallOpenings.ts';

describe('wallStrips', () => {
  it('covers wall minus opening exactly, without overlap', () => {
    const strips = wallStrips(10, 7.5, -2.5, -1.65, 3.6, 1.9); // back-wall window
    const area = strips.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(10 * 7.5 - 3.6 * 1.9);
    // strips stay within the wall
    for (const r of strips) {
      expect(r.x - r.w / 2).toBeGreaterThanOrEqual(-5 - 1e-9);
      expect(r.x + r.w / 2).toBeLessThanOrEqual(5 + 1e-9);
      expect(r.y - r.h / 2).toBeGreaterThanOrEqual(-3.75 - 1e-9);
      expect(r.y + r.h / 2).toBeLessThanOrEqual(3.75 + 1e-9);
    }
    // nothing covers the opening's center
    for (const r of strips) {
      const inX = Math.abs(-2.5 - r.x) < r.w / 2;
      const inY = Math.abs(-1.65 - r.y) < r.h / 2;
      expect(inX && inY).toBe(false);
    }
  });

  it('omits zero-width strips when the opening touches an edge', () => {
    const strips = wallStrips(4, 4, -1, 0, 2, 4); // opening spans full height at left half
    expect(strips).toHaveLength(1); // only the right strip remains
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run web/src/scene/wallOpenings.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `wallOpenings.ts`**

```ts
export interface Rect { x: number; y: number; w: number; h: number }

/** Split a w×h wall (centered at origin) into up to 4 solid strips around an
 *  opening centered at (ox,oy) with size ow×oh. Zero-area strips are omitted. */
export function wallStrips(w: number, h: number, ox: number, oy: number, ow: number, oh: number): Rect[] {
  const L = -w / 2, R = w / 2, B = -h / 2, T = h / 2;
  const ol = ox - ow / 2, or_ = ox + ow / 2, ob = oy - oh / 2, ot = oy + oh / 2;
  const strips: Rect[] = [
    { x: (L + ol) / 2, y: 0, w: ol - L, h },                                  // left, full height
    { x: (or_ + R) / 2, y: 0, w: R - or_, h },                                // right, full height
    { x: ox, y: (B + ob) / 2, w: ow, h: ob - B },                             // below opening
    { x: ox, y: (ot + T) / 2, w: ow, h: T - ot },                             // above opening
  ];
  return strips.filter((r) => r.w > 1e-6 && r.h > 1e-6);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run web/src/scene/wallOpenings.test.ts`
Expected: PASS.

- [ ] **Step 5: Rework Office.tsx**

Changes, all inside `Office()` (which now reads `const { width, depth, centerZ, height } = roomDims(maxSeat);` and drops `const wallH = 4.2`, using `height` everywhere `wallH` appeared):

**Reusable pieces** (module-level in Office.tsx):

```tsx
import { wallStrips } from './wallOpenings.ts';

/** A wall plane built from solid strips around a window opening, plus glass + mullions. */
function WallWithWindow({ w, h, ox, oy, ow, oh }: { w: number; h: number; ox: number; oy: number; ow: number; oh: number }) {
  return (
    <group>
      {wallStrips(w, h, ox, oy, ow, oh).map((r, i) => (
        <mesh key={i} receiveShadow position={[r.x, r.y, 0]}>
          <planeGeometry args={[r.w, r.h]} />
          <meshStandardMaterial color="#5c5a68" roughness={1} />
        </mesh>
      ))}
      {/* glass: barely-there tint so the skybox reads through */}
      <mesh position={[ox, oy, 0.01]}>
        <planeGeometry args={[ow, oh]} />
        <meshBasicMaterial color="#aac4d8" transparent opacity={0.1} depthWrite={false} />
      </mesh>
      {/* mullions */}
      <mesh position={[ox, oy, 0.02]}>
        <boxGeometry args={[0.08, oh, 0.03]} />
        <meshStandardMaterial color="#4a4450" />
      </mesh>
      <mesh position={[ox, oy, 0.02]}>
        <boxGeometry args={[ow, 0.08, 0.03]} />
        <meshStandardMaterial color="#4a4450" />
      </mesh>
      {/* frame */}
      <mesh position={[ox, oy, 0.005]}>
        <boxGeometry args={[ow + 0.12, oh + 0.12, 0.02]} />
        <meshStandardMaterial color="#4a4450" />
      </mesh>
    </group>
  );
}

/** Hanging ceiling fixture: rod + housing + emissive panel + point light. */
function CeilingLight({ position, castShadow = false }: { position: [number, number, number]; castShadow?: boolean }) {
  return (
    <group position={position}>
      <mesh position={[0, -0.5, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 1.0]} />
        <meshStandardMaterial color="#26242c" />
      </mesh>
      <mesh position={[0, -1.05, 0]} castShadow={false}>
        <boxGeometry args={[1.7, 0.1, 0.45]} />
        <meshStandardMaterial color="#2b2b30" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[0, -1.11, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.6, 0.38]} />
        <meshBasicMaterial color="#fff7e6" />
      </mesh>
      <pointLight
        color="#f4f1e8"
        intensity={22}
        distance={20}
        decay={2}
        position={[0, -1.3, 0]}
        castShadow={castShadow}
        {...(castShadow ? { 'shadow-mapSize': [1024, 1024] as [number, number], 'shadow-bias': -0.002 } : {})}
      />
    </group>
  );
}
```

**In the JSX:**

1. **Back wall** — replace the single back-wall plane AND the fake dusk-window group with (wall planes are positioned at `y = height/2`, so the window's center y in wall-local coords is `2.1 − height/2`):

```tsx
      <group position={[0, height / 2, backZ]}>
        <WallWithWindow w={width} h={height} ox={-width / 4} oy={2.1 - height / 2} ow={3.6} oh={1.9} />
      </group>
      {/* warm spill through the back window (kept from the old fake window) */}
      <pointLight color="#ffd9a0" intensity={14} distance={12} decay={2} position={[-width / 4, 2.1, backZ + 1]} />
```

2. **Left wall** — replace the plain left-wall plane (windows face outward like before; the group is rotated so the wall's local +z faces into the room):

```tsx
      <group position={[-width / 2, height / 2, centerZ]} rotation={[0, Math.PI / 2, 0]}>
        <WallWithWindow w={depth} h={height} ox={1.0} oy={2.1 - height / 2} ow={3.6} oh={1.9} />
      </group>
```

(In this wall's local x, positive runs toward +z-room; `ox: 1.0` puts the window forward of the couch. Nudge `ox` if it collides with the couch/lamp silhouettes.)

3. **Right wall** — same plane as today but `height` tall (whiteboard stays).

4. **Ceiling + fixtures** — replace the old fixtureless `pointLight` block:

```tsx
      {/* ceiling, high above the room */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, height, centerZ]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#3d3a44" roughness={1} />
      </mesh>
      {/* hanging fixtures: one shadow-caster, three fill */}
      <CeilingLight position={[-width / 4, height, centerZ - depth / 4]} castShadow />
      <CeilingLight position={[width / 4, height, centerZ - depth / 4]} />
      <CeilingLight position={[-width / 4, height, centerZ + depth / 4]} />
      <CeilingLight position={[width / 4, height, centerZ + depth / 4]} />
```

- [ ] **Step 6: Verify in the app**

Fly around (free cam): city visible through both windows; ceiling with 4 visible fixtures; light level comparable to before (tune fixture `intensity` if the room got darker — old central light was intensity 40, four fixtures at 22 ≈ brighter but farther away); camera cannot pass through walls, floor, or ceiling; movie mode's `overheadGod` shots now frame desks from high up. Also check nametags still occlude correctly (the ceiling is scene geometry but sits above tag sightlines).

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/scene/wallOpenings.ts web/src/scene/wallOpenings.test.ts web/src/scene/Office.tsx
git commit -m "feat: high ceiling with visible fixtures, transparent windows onto the city"
```

---

### Task 11: Final verification pass

**Files:** none new.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Live app walkthrough**

With `docker compose up` running and a real Claude session generating activity:
1. Movie mode: watch ~15 cuts. Confirm variety (high/overhead present), no near-duplicate consecutive positions, no split-second re-jumps after a cut, shots hold ≥2.5 s.
2. Trigger an agent Read of a PNG: the image stays on the employee's monitor ~5 s and the employee stays "working" for the duration.
3. Character picker on a Mixamo import: seated preview, all three sliders live-update and persist.
4. Windows show the city; ceiling lights visible; camera caged.

- [ ] **Step 3: Update CLAUDE.md architecture notes**

Add one line to the Architecture web section: movie camera shot archetypes live in `web/src/scene/movieShots.ts` (validated-then-committed shots), and note the 5 s screenshot dwell in the `streamer.ts` bullet. Commit:

```bash
git add CLAUDE.md
git commit -m "docs: note shot archetype library and screenshot dwell"
```
