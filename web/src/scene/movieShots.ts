import * as THREE from 'three';
import type { OfficeState } from '../../../shared/types.ts';
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
function personPosition(seat: number): THREE.Vector3 {
  const { position, rotationY } = seatTransform(seat);
  const local = new THREE.Vector3(0, 0, -1.15).applyAxisAngle(UP, rotationY);
  return position.clone().add(local);
}

function monitorAABB(seat: number): THREE.Box3 {
  const { position, rotationY } = seatTransform(seat);
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
    const p = personPosition(seat);
    if (pos.distanceTo(p.clone().add(new THREE.Vector3(0, 1.8, 0))) <= 0.35) return true;
    if (pos.distanceTo(p.clone().add(new THREE.Vector3(0, 1.25, 0))) <= 0.45) return true;
  }
  for (const seat of occupiedSeats(office)) {
    if (monitorAABB(seat).containsPoint(pos)) return true;
  }
  return false;
}

/**
 * Does camPos see subject.center? Blocked by any occupied seat's person (head/torso
 * spheres) or by any OTHER seat's monitor panel (the subject's own monitor is skipped
 * since the segment ends on it).
 */
export function hasLineOfSight(camPos: THREE.Vector3, subject: Subject, office: OfficeState | null): boolean {
  for (const seat of occupiedSeats(office)) {
    const p = personPosition(seat);
    const head = p.clone().add(new THREE.Vector3(0, 1.8, 0));
    const torso = p.clone().add(new THREE.Vector3(0, 1.25, 0));
    if (segmentHitsSphere(camPos, subject.center, head, 0.35)) return false;
    if (segmentHitsSphere(camPos, subject.center, torso, 0.45)) return false;
  }
  const ownSeat = seatForKey(subject.key, office);
  for (const seat of occupiedSeats(office)) {
    if (ownSeat !== null && seat === ownSeat) continue;
    if (segmentHitsBox(camPos, subject.center, monitorAABB(seat))) return false;
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

export function groupShot(subjects: Subject[], fovY: number, aspect: number, rng: () => number, office: OfficeState | null = null): Shot {
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
      return closeUpShot(all[Math.floor(rng() * all.length)], fovY, aspect, rng, office);
    }
    return wideShot(office, rng);
  }

  const groups = groupByFacing(subjects);
  const group = groups[cutIndex % groups.length];
  return group.length === 1
    ? closeUpShot(group[0], fovY, aspect, rng, office)
    : groupShot(group, fovY, aspect, rng, office);
}
