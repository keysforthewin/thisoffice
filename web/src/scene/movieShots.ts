import * as THREE from 'three';
import type { OfficeState } from '../../../shared/types.ts';
import { roomDims, whiteboardTransform } from './layout.ts';
import { resolveSeat } from './buildLayout.ts';

export const ACTIVE_WINDOW_MS = 10_000;

/** Boss inbox and whiteboard changes are single events (not streams), so their shots expire sooner. */
const ACTIVITY_TTL_MS: Record<string, number> = { boss: 5_000, whiteboard: 5_000 };

export function activityTtl(key: string): number {
  return ACTIVITY_TTL_MS[key] ?? ACTIVE_WINDOW_MS;
}

/** Body sphere radii for LOS line-of-sight checking. */
const HEAD_R = 0.3;
const TORSO_R = 0.4;

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
  return Object.keys(lastActivity).filter((k) => now - lastActivity[k] < activityTtl(k));
}

/**
 * Stable fingerprint of the active set; the movie camera recuts when it changes.
 * Filtered to keys with a resolvable subject so an evicted employee's screen
 * disappearing from the office triggers an immediate recut.
 */
export function activeSetKey(lastActivity: Record<string, number>, now: number, office: OfficeState | null): string {
  return activeKeys(lastActivity, now)
    .filter((k) => subjectFor(k, office) !== null)
    .sort()
    .join('|');
}

function maxSeat(office: OfficeState | null): number {
  return Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
}

/** Keep a camera position above the floor, under the wall tops, and inside the walls. */
export function clampToRoom(pos: THREE.Vector3, office: OfficeState | null): THREE.Vector3 {
  const { width, depth, centerZ, height } = roomDims(maxSeat(office));
  const backZ = centerZ - depth / 2;
  const frontZ = centerZ + depth / 2;
  pos.y = THREE.MathUtils.clamp(pos.y, 0.4, height - 0.3);
  pos.x = THREE.MathUtils.clamp(pos.x, -(width / 2 - 0.3), width / 2 - 0.3);
  pos.z = THREE.MathUtils.clamp(pos.z, backZ + 0.3, frontZ - 0.3);
  return pos;
}

/** Occupied seat numbers: boss (seat 0) plus every employee's seat. */
function occupiedSeats(office: OfficeState | null): number[] {
  return [0, ...(office?.employees.map((e) => e.seat) ?? [])];
}

/** World-space seated-person base position for a seat (see Desk.tsx local offset [0,0,-1.15]). */
function personPosition(seat: number, office: OfficeState | null): THREE.Vector3 {
  const { position, rotationY } = resolveSeat(office?.layout, seat, maxSeat(office));
  const local = new THREE.Vector3(0, 0, -1.15).applyAxisAngle(UP, rotationY);
  return position.clone().add(local);
}

function monitorAABB(seat: number, office: OfficeState | null): THREE.Box3 {
  const { position, rotationY } = resolveSeat(office?.layout, seat, maxSeat(office));
  const center = position.clone().add(MONITOR_OFFSET.clone().applyAxisAngle(UP, rotationY));
  const half = new THREE.Vector3(MONITOR_W / 2, MONITOR_H / 2, 0.15);
  return new THREE.Box3(center.clone().sub(half), center.clone().add(half));
}

function seatForKey(key: string, office: OfficeState | null): number | null {
  if (key === 'boss') return 0;
  const emp = office?.employees.find((e) => e.id === key);
  return emp ? emp.seat : null;
}

export function segmentHitsSphere(a: THREE.Vector3, b: THREE.Vector3, center: THREE.Vector3, radius: number): boolean {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-9) return a.distanceTo(center) <= radius;
  const t = THREE.MathUtils.clamp(center.clone().sub(a).dot(ab) / len2, 0, 1);
  const closest = a.clone().addScaledVector(ab, t);
  return closest.distanceTo(center) <= radius;
}

export function segmentHitsBox(a: THREE.Vector3, b: THREE.Vector3, box: THREE.Box3): boolean {
  const dir = b.clone().sub(a);
  let tmin = 0;
  let tmax = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    const origin = a[axis];
    const minB = box.min[axis];
    const maxB = box.max[axis];
    if (Math.abs(d) < 1e-9) {
      if (origin < minB || origin > maxB) return false;
      continue;
    }
    let t1 = (minB - origin) / d;
    let t2 = (maxB - origin) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/** True if camPos is inside a person's body sphere or a monitor's AABB (unusable camera spot). */
function isInsideOccluder(pos: THREE.Vector3, office: OfficeState | null): boolean {
  for (const seat of occupiedSeats(office)) {
    const p = personPosition(seat, office);
    if (pos.distanceTo(p.clone().add(new THREE.Vector3(0, 1.8, 0))) <= HEAD_R + 0.05) return true;
    if (pos.distanceTo(p.clone().add(new THREE.Vector3(0, 1.25, 0))) <= TORSO_R + 0.05) return true;
  }
  for (const seat of occupiedSeats(office)) {
    if (monitorAABB(seat, office).containsPoint(pos)) return true;
  }
  return false;
}

/**
 * Does camPos see subject.center? Blocked by any other occupied seat's person (head/torso
 * spheres) or by any OTHER seat's monitor panel. The subject's own seat occupant never
 * blocks their own screen (over-the-shoulder camera angles).
 */
export function hasLineOfSight(camPos: THREE.Vector3, subject: Subject, office: OfficeState | null): boolean {
  const ownSeat = seatForKey(subject.key, office);
  for (const seat of occupiedSeats(office)) {
    if (ownSeat !== null && seat === ownSeat) continue; // over-the-shoulder is the point
    const p = personPosition(seat, office);
    const head = p.clone().add(new THREE.Vector3(0, 1.8, 0));
    const torso = p.clone().add(new THREE.Vector3(0, 1.25, 0));
    if (segmentHitsSphere(camPos, subject.center, head, HEAD_R)) return false;
    if (segmentHitsSphere(camPos, subject.center, torso, TORSO_R)) return false;
  }
  for (const seat of occupiedSeats(office)) {
    if (ownSeat !== null && seat === ownSeat) continue;
    if (segmentHitsBox(camPos, subject.center, monitorAABB(seat, office))) return false;
  }
  return true;
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
  const { position, rotationY } = resolveSeat(office?.layout, seat, maxSeat(office));
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

/** dir must be unit; returns dir yawed/pitched by small random angles.
 *  Positive pitch tilts the direction UPWARD (raises the resulting camera position,
 *  since candidates are computed as subject.center + dir*dist) — verified via
 *  right = cross(UP, d): rotating d about +right by +pitch alone would rotate its
 *  y component negative, so the rotation angle is negated here to keep the sign
 *  convention "positive pitch = higher camera" intuitive for callers. */
function jitterDir(dir: THREE.Vector3, rng: () => number, yawRange: number, pitchMin: number, pitchMax: number): THREE.Vector3 {
  const yaw = (rng() * 2 - 1) * yawRange;
  const pitch = pitchMin + rng() * (pitchMax - pitchMin);
  const d = dir.clone().applyAxisAngle(UP, yaw);
  const right = new THREE.Vector3().crossVectors(UP, d).normalize();
  return d.applyAxisAngle(right, -pitch).normalize();
}

// widened so an over-the-shoulder angle exists — the seated character is right in
// front of their own screen, so a straight-on close-up is usually self-occluded
const CLOSEUP_YAW = THREE.MathUtils.degToRad(35);
const CLOSEUP_PITCH_MIN = THREE.MathUtils.degToRad(-5);
const CLOSEUP_PITCH_MAX = THREE.MathUtils.degToRad(25);
const LOS_CANDIDATES = 16;

export function closeUpShot(subject: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null = null): Shot {
  // margin 1.3: the jittered angle foreshortens the rect, and we want a little air
  const dist = fitDistance(subject.width, subject.height, fovY, aspect, 1.3);
  let bestPos: THREE.Vector3 | null = null;
  let bestSeen = -1;
  for (let i = 0; i < LOS_CANDIDATES; i++) {
    const dir = jitterDir(subject.normal, rng, CLOSEUP_YAW, CLOSEUP_PITCH_MIN, CLOSEUP_PITCH_MAX);
    const pos = clampToRoom(subject.center.clone().addScaledVector(dir, dist), office);
    if (isInsideOccluder(pos, office)) continue;
    const seen = hasLineOfSight(pos, subject, office) ? 1 : 0;
    if (seen === 1) return { position: pos, lookAt: subject.center.clone() };
    if (seen > bestSeen) {
      bestSeen = seen;
      bestPos = pos;
    }
  }
  // Every one of the LOS_CANDIDATES landed inside an occluder (rare — only happens in a
  // very cramped/crowded room). Fall back to a straight-on shot with NO occluder/LOS
  // validation, still clamped to the room: this is the one residual corner where a
  // close-up could clip through a person or monitor.
  bestPos ??= clampToRoom(subject.center.clone().addScaledVector(subject.normal, dist), office);
  return { position: bestPos, lookAt: subject.center.clone() };
}

const GROUP_YAW = THREE.MathUtils.degToRad(40);
const GROUP_PITCH_MIN = THREE.MathUtils.degToRad(5);
const GROUP_PITCH_MAX = THREE.MathUtils.degToRad(20);
/** min dot(viewDir→camera, screen normal) for a screen to read as front-facing */
const FRONT_FACING_DOT = 0.25;

/** Shared geometry prologue for group framing: centroid, average facing normal, and
 *  the distance at which the bounding sphere of every screen corner fits the frustum. */
function groupFraming(subjects: Subject[], fovY: number, aspect: number): { centroid: THREE.Vector3; avgNormal: THREE.Vector3; dist: number } {
  const centroid = subjects
    .reduce((acc, s) => acc.add(s.center), new THREE.Vector3())
    .divideScalar(subjects.length);
  const avgNormal = subjects
    .reduce((acc, s) => acc.add(s.normal), new THREE.Vector3())
    .normalize();

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
  return { centroid, avgNormal, dist };
}

export function groupShot(subjects: Subject[], fovY: number, aspect: number, rng: () => number, office: OfficeState | null = null): Shot {
  const { centroid, avgNormal, dist } = groupFraming(subjects, fovY, aspect);

  // Evaluate occluder/LOS for every candidate (not just front-facing ones), and use
  // front-facing-ness as a ranking criterion instead of a hard pre-filter, so an
  // occluder-avoiding-but-imperfectly-facing candidate is never discarded in favor of
  // an untested one. Tiers, best to worst: (1) fully front-facing AND full LOS — return
  // immediately; (2) among occluder-free candidates, most front-facing subjects, then
  // most subjects with LOS. Only every-candidate-inside-an-occluder falls through to an
  // unvalidated direction below.
  let bestPos: THREE.Vector3 | null = null;
  let bestFrontFacing = -1;
  let bestSeen = -1;
  for (let i = 0; i < LOS_CANDIDATES; i++) {
    const cand = jitterDir(avgNormal, rng, GROUP_YAW, GROUP_PITCH_MIN, GROUP_PITCH_MAX);
    const pos = clampToRoom(centroid.clone().addScaledVector(cand, dist), office);
    if (isInsideOccluder(pos, office)) continue;
    const frontFacingCount = subjects.filter((s) => cand.dot(s.normal) > FRONT_FACING_DOT).length;
    const fullyFrontFacing = frontFacingCount === subjects.length;
    const seen = subjects.filter((s) => hasLineOfSight(pos, s, office)).length;
    if (fullyFrontFacing && seen === subjects.length) return { position: pos, lookAt: centroid.clone() };
    if (frontFacingCount > bestFrontFacing || (frontFacingCount === bestFrontFacing && seen > bestSeen)) {
      bestFrontFacing = frontFacingCount;
      bestSeen = seen;
      bestPos = pos;
    }
  }
  if (bestPos) return { position: bestPos, lookAt: centroid.clone() };
  // Every one of the LOS_CANDIDATES landed inside an occluder (rare — only happens in a
  // very cramped/crowded room). Fall back to a deterministic, front-leaning direction
  // with NO occluder/LOS validation: this is the one residual corner where a group shot
  // could clip through a person or monitor.
  const fallbackDir = jitterDir(avgNormal, () => 0.5, 0, GROUP_PITCH_MIN, GROUP_PITCH_MIN);
  const pos = clampToRoom(centroid.clone().addScaledVector(fallbackDir, dist), office);
  return { position: pos, lookAt: centroid.clone() };
}

function wideShot(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ } = roomDims(maxSeat(office));
  const angle = rng() * Math.PI * 2;
  const position = clampToRoom(
    new THREE.Vector3(
      Math.cos(angle) * width * 0.42,
      3.0 + rng() * 1.0,
      centerZ + Math.sin(angle) * depth * 0.42,
    ),
    office,
  );
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
}

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
  minDist: number = MIN_SHOT_DIST,
): boolean {
  if (isInsideOccluder(pos, office)) return false;
  if (prev && pos.distanceTo(prev) < minDist) return false;
  return subjects.every((s) => hasLineOfSight(pos, s, office));
}

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

function groupCandidate(
  subjects: Subject[], fovY: number, aspect: number, rng: () => number,
  office: OfficeState | null, pitchMin: number, pitchMax: number,
): Shot {
  const { centroid, avgNormal, dist } = groupFraming(subjects, fovY, aspect);
  const dir = jitterDir(avgNormal, rng, GROUP_YAW, pitchMin, pitchMax);
  const position = clampToRoom(centroid.clone().addScaledVector(dir, dist), office);
  return { position, lookAt: centroid.clone() };
}

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
  const { depth, centerZ } = roomDims(maxSeat(office));
  const sx = rng() < 0.5 ? -1 : 1;
  const z = centerZ + (rng() - 0.5) * depth * 0.6;
  // track runs down the aisles between desk columns (x = ±3.4, ~1.1 half-width), not
  // along the side walls where the couch/shelf/lamp line lives.
  const position = clampToRoom(new THREE.Vector3(sx * (1.7 + (rng() - 0.5) * 0.4), 1.1 + rng() * 0.3, z), office);
  return { position, lookAt: new THREE.Vector3(0, 1.3, z + (rng() - 0.5) * 2) };
}

function wideEstablishingCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ, height } = roomDims(maxSeat(office));
  const angle = rng() * Math.PI * 2;
  const position = clampToRoom(new THREE.Vector3(
    Math.cos(angle) * width * 0.42, 2.2 + rng() * (height - 4.2), centerZ + Math.sin(angle) * depth * 0.42), office);
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
}

const SINGLE_POOL: ArchetypeName[] = ['otsCloseup', 'highAngle', 'sideProfile'];
const GROUP_POOL: ArchetypeName[] = ['groupLevel', 'elevatedGroup'];
const IDLE_POOL: ArchetypeName[] = ['overheadGod', 'highCorner', 'lowDolly', 'wideEstablishing'];

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

  const attempt = (name: ArchetypeName, gen: () => Shot, losSubjects: Subject[], minDist: number = MIN_SHOT_DIST): PickedShot | null => {
    for (let i = 0; i < LOS_CANDIDATES; i++) {
      const shot = gen();
      if (validCandidate(shot.position, losSubjects, office, prev, minDist)) return { ...shot, archetype: name };
    }
    return null;
  };

  /** Try every archetype in the ordered pool at the full min-distance requirement, then
   *  again at half that (occluder/LOS checks unchanged) before giving up — this rescues
   *  cuts in tight quarters where the previous shot happens to block every full-distance
   *  candidate, instead of falling straight through to the unvalidated fallback. */
  const tryPool = (
    pool: ArchetypeName[],
    gens: Record<string, () => Shot>,
    losSubjects: Subject[],
  ): PickedShot | null => {
    const ordered = order(pool);
    for (const name of ordered) {
      const hit = attempt(name, gens[name], losSubjects);
      if (hit) return hit;
    }
    for (const name of ordered) {
      const hit = attempt(name, gens[name], losSubjects, MIN_SHOT_DIST / 2);
      if (hit) return hit;
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
    const hit = tryPool(IDLE_POOL, gens, []);
    if (hit) return hit;
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
    const hit = tryPool(SINGLE_POOL, gens, [s]);
    if (hit) return hit;
    return { ...closeUpShot(s, fovY, aspect, rng, office), archetype: 'otsCloseup' }; // best-effort fallback
  }

  const gens: Record<string, () => Shot> = {
    groupLevel: () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX),
    elevatedGroup: () => groupCandidate(group, fovY, aspect, rng, office, deg(25), deg(45)),
  };
  const hit = tryPool(GROUP_POOL, gens, group);
  if (hit) return hit;
  return { ...groupShot(group, fovY, aspect, rng, office), archetype: 'groupLevel' }; // best-effort fallback
}
