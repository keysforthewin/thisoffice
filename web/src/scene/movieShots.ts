import * as THREE from 'three';
import type { OfficeState } from '../../../shared/types.ts';
import { roomDims, whiteboardTransform, statusBoardTransform } from './layout.ts';
import { resolveSeat, resolveWallOffset } from './buildLayout.ts';
import { TV_SCREEN_W, TV_SCREEN_H } from './WallTV.tsx';

export const ACTIVE_WINDOW_MS = 10_000;

/**
 * Boss inbox and whiteboard changes are single events (not streams), so their
 * activity window differs from streaming employee monitors: long enough to
 * survive the min shot hold + cut cadence (14s), and the status board stays a
 * cut target for minutes after an update.
 */
const ACTIVITY_TTL_MS: Record<string, number> = { boss: 14_000, whiteboard: 14_000, statusboard: 150_000, tv: 150_000 };
const WALL_BOARD_TTL_MS = 14_000;

export function activityTtl(key: string): number {
  return ACTIVITY_TTL_MS[key] ?? (isWallBoard(key) ? WALL_BOARD_TTL_MS : ACTIVE_WINDOW_MS);
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
  /** motion endpoints — absent means a static shot */
  positionEnd?: THREE.Vector3;
  lookAtEnd?: THREE.Vector3;
  /** fov move in DEGREES; absent keeps the camera's base fov */
  fov?: number;
  fovEnd?: number;
  /** default 'inOut' (smoothstep) */
  ease?: 'linear' | 'inOut';
  /** minimum seconds so slow moves aren't cut short by the random 3–10s duration */
  minDuration?: number;
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

/** A wall-mounted board subject: everything needed to place, size, and orient it. */
interface WallBoardDef {
  center(office: OfficeState | null): THREE.Vector3;
  /** unit, readable-from direction */
  normal: THREE.Vector3;
  width: number;
  height: number;
}

/** World-space center of the TV, mirroring Office.tsx's placement (which owns the
 *  authoritative render): left wall, layout-draggable along z via resolveWallOffset. */
function tvCenter(office: OfficeState | null): THREE.Vector3 {
  const ms = maxSeat(office);
  const { width, centerZ } = roomDims(ms);
  const ox = resolveWallOffset(office?.layout, 'tv', ms);
  return new THREE.Vector3(-width / 2 + 0.07, 2.2, centerZ - ox);
}

/** Wall-mounted board subjects: whiteboard/statusboard on the right wall (readable
 *  from −x), the stats tv on the left wall (readable from +x). */
const WALL_BOARDS: Record<string, WallBoardDef> = {
  whiteboard: {
    center: (office) => whiteboardTransform(maxSeat(office)).position.clone(),
    normal: new THREE.Vector3(-1, 0, 0),
    width: WHITEBOARD_W,
    height: WHITEBOARD_H,
  },
  statusboard: {
    center: (office) => statusBoardTransform(maxSeat(office)).position.clone(),
    normal: new THREE.Vector3(-1, 0, 0),
    width: WHITEBOARD_W,
    height: WHITEBOARD_H,
  },
  tv: {
    center: tvCenter,
    normal: new THREE.Vector3(1, 0, 0),
    width: TV_SCREEN_W,
    height: TV_SCREEN_H,
  },
};

export function isWallBoard(key: string): boolean {
  return key in WALL_BOARDS;
}

export function subjectFor(key: string, office: OfficeState | null): Subject | null {
  const board = WALL_BOARDS[key];
  if (board) {
    return { key, center: board.center(office), normal: board.normal.clone(), width: board.width, height: board.height };
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
  | 'pushInCloseup' | 'orbitArc' | 'zoomPunch' | 'lowPush' | 'boardPan'
  | 'groupLevel' | 'elevatedGroup' | 'groupArc'
  | 'overheadGod' | 'highCorner' | 'lowDolly' | 'wideEstablishing';

export interface PickedShot extends Shot {
  archetype: ArchetypeName;
  /** active subject key the shot is built around; absent for idle B-roll */
  primaryKey?: string;
}

/** A shot passes only if its whole camera path (start, midpoint, end) stays
 *  outside occluders and sees every required subject, and it starts far enough
 *  from the previous shot. Empty subjects (idle B-roll) skips LOS. */
function validShot(
  shot: Shot,
  subjects: Subject[],
  office: OfficeState | null,
  prev: THREE.Vector3 | null,
  minDist: number = MIN_SHOT_DIST,
): boolean {
  if (prev && shot.position.distanceTo(prev) < minDist) return false;
  const points = [shot.position];
  if (shot.positionEnd) {
    points.push(shot.positionEnd, shot.position.clone().lerp(shot.positionEnd, 0.5));
  }
  for (const pos of points) {
    if (isInsideOccluder(pos, office)) return false;
    if (!subjects.every((s) => hasLineOfSight(pos, s, office))) return false;
  }
  return true;
}

const deg = THREE.MathUtils.degToRad;

/** Dolly along one sight line: start at dist·mulStart, end at dist·mulEnd (equal = static). */
function dollyCandidate(
  subject: Subject, fovY: number, aspect: number, rng: () => number,
  office: OfficeState | null,
  yawRange: number, pitchMin: number, pitchMax: number,
  mulStart: number, mulEnd: number, margin: number, extra: Partial<Shot> = {},
): Shot {
  const dist = fitDistance(subject.width, subject.height, fovY, aspect, margin);
  const dir = jitterDir(subject.normal, rng, yawRange, pitchMin, pitchMax);
  const position = clampToRoom(subject.center.clone().addScaledVector(dir, dist * mulStart), office);
  const shot: Shot = { position, lookAt: subject.center.clone(), ...extra };
  if (mulEnd !== mulStart) {
    shot.positionEnd = clampToRoom(subject.center.clone().addScaledVector(dir, dist * mulEnd), office);
  }
  return shot;
}

/** Orbit around the subject: the camera slides along an arc while looking at the screen. */
function arcCandidate(
  subject: Subject, fovY: number, aspect: number, rng: () => number,
  office: OfficeState | null,
  yawRange: number, pitchMin: number, pitchMax: number,
  distMul: number, arcRad: number, margin: number,
): Shot {
  const dist = fitDistance(subject.width, subject.height, fovY, aspect, margin) * distMul;
  const dir = jitterDir(subject.normal, rng, yawRange, pitchMin, pitchMax);
  const sign = rng() < 0.5 ? -1 : 1;
  const dirEnd = dir.clone().applyAxisAngle(UP, sign * arcRad);
  return {
    position: clampToRoom(subject.center.clone().addScaledVector(dir, dist), office),
    positionEnd: clampToRoom(subject.center.clone().addScaledVector(dirEnd, dist), office),
    lookAt: subject.center.clone(),
  };
}

function otsCloseupCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // gentle push-in on the classic over-the-shoulder framing
  return dollyCandidate(s, fovY, aspect, rng, office, CLOSEUP_YAW, CLOSEUP_PITCH_MIN, CLOSEUP_PITCH_MAX, 1.15, 1.0, 1.3);
}

function highAngleCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // slow orbit at the existing high angle
  return arcCandidate(s, fovY, aspect, rng, office, deg(35), deg(45), deg(65), 1.6, deg(12), 1.3);
}

function sideProfileCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  const sign = rng() < 0.5 ? -1 : 1;
  const yaw = sign * (deg(55) + rng() * deg(25));
  const pitch = deg(5) + rng() * deg(15);
  const dist = fitDistance(s.width, s.height, fovY, aspect, 1.3) * 1.8;
  const dir = jitterDir(s.normal.clone().applyAxisAngle(UP, yaw), rng, 0, pitch, pitch);
  const position = clampToRoom(s.center.clone().addScaledVector(dir, dist), office);
  // lateral truck: the camera slides along its own right axis, subject stays centered
  const forward = s.center.clone().sub(position).normalize();
  const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
  const positionEnd = clampToRoom(position.clone().addScaledVector(right, (rng() < 0.5 ? -1 : 1) * 0.8), office);
  return { position, positionEnd, lookAt: s.center.clone() };
}

function pushInCloseupCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // wide → close-up dolly; needs time to breathe
  return dollyCandidate(s, fovY, aspect, rng, office, CLOSEUP_YAW, deg(0), deg(20), 2.2, 1.0, 1.3, { minDuration: 6 });
}

function orbitArcCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  return { ...arcCandidate(s, fovY, aspect, rng, office, deg(25), deg(10), deg(25), 1.6, deg(20) + rng() * deg(15), 1.3), minDuration: 5 };
}

const ZOOM_PUNCH_FOV_START = 50;
const ZOOM_PUNCH_FOV_END = 34;

function zoomPunchCandidate(s: Subject, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // static camera, lens zooms in; distance framed for the NARROW end so the
  // subject fits (and fills the frame) for the entire move
  const dist = fitDistance(s.width, s.height, deg(ZOOM_PUNCH_FOV_END), aspect, 1.3) * 1.0;
  const dir = jitterDir(s.normal, rng, deg(25), deg(0), deg(20));
  return {
    position: clampToRoom(s.center.clone().addScaledVector(dir, dist), office),
    lookAt: s.center.clone(),
    fov: ZOOM_PUNCH_FOV_START,
    fovEnd: ZOOM_PUNCH_FOV_END,
    minDuration: 5,
  };
}

function lowPushCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // near-floor push-in; clampToRoom keeps the camera above y=0.4
  return dollyCandidate(s, fovY, aspect, rng, office, deg(30), deg(-5), deg(5), 2.0, 1.3, 1.3, { minDuration: 4 });
}

function boardPanCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // fixed reading position; the look target sweeps across the board like reading it
  const dist = fitDistance(s.width * 0.55, s.height, fovY, aspect, 1.2);
  const dir = jitterDir(s.normal, rng, deg(10), deg(-3), deg(8));
  const right = new THREE.Vector3().crossVectors(UP, s.normal).normalize();
  const sign = rng() < 0.5 ? -1 : 1;
  return {
    position: clampToRoom(s.center.clone().addScaledVector(dir, dist), office),
    lookAt: s.center.clone().addScaledVector(right, -sign * s.width * 0.35),
    lookAtEnd: s.center.clone().addScaledVector(right, sign * s.width * 0.35),
    ease: 'linear',
    minDuration: 6,
  };
}

type GroupMotion = 'truck' | 'pushIn' | 'arc' | 'none';

function groupCandidate(
  subjects: Subject[], fovY: number, aspect: number, rng: () => number,
  office: OfficeState | null, pitchMin: number, pitchMax: number, motion: GroupMotion = 'none',
): Shot {
  const { centroid, avgNormal, dist } = groupFraming(subjects, fovY, aspect);
  const dir = jitterDir(avgNormal, rng, GROUP_YAW, pitchMin, pitchMax);
  const position = clampToRoom(centroid.clone().addScaledVector(dir, dist), office);
  const shot: Shot = { position, lookAt: centroid.clone() };
  const sign = rng() < 0.5 ? -1 : 1;
  if (motion === 'truck') {
    const forward = centroid.clone().sub(position).normalize();
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
    shot.positionEnd = clampToRoom(position.clone().addScaledVector(right, sign * 0.6), office);
  } else if (motion === 'pushIn') {
    shot.positionEnd = clampToRoom(centroid.clone().addScaledVector(dir, dist * 0.85), office);
  } else if (motion === 'arc') {
    const dirEnd = dir.clone().applyAxisAngle(UP, sign * deg(15));
    shot.positionEnd = clampToRoom(centroid.clone().addScaledVector(dirEnd, dist), office);
    shot.minDuration = 5;
  }
  return shot;
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
  // slow orbit about the look target
  const sign = rng() < 0.5 ? -1 : 1;
  const positionEnd = clampToRoom(
    position.clone().sub(lookAt).applyAxisAngle(UP, sign * deg(15)).add(lookAt), office);
  return { position, positionEnd, lookAt, minDuration: 5 };
}

function highCornerCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ } = roomDims(maxSeat(office));
  const sx = rng() < 0.5 ? -1 : 1;
  const sz = rng() < 0.5 ? -1 : 1;
  const position = clampToRoom(new THREE.Vector3(
    sx * (width / 2 - 0.6), 3.0 + rng() * 0.5, centerZ + sz * (depth / 2 - 0.6)), office);
  // surveillance-camera pan across the room
  const lookAt = new THREE.Vector3(-width * 0.2, 1.2, centerZ);
  const lookAtEnd = new THREE.Vector3(width * 0.2, 1.2, centerZ);
  if (rng() < 0.5) return { position, lookAt: lookAtEnd, lookAtEnd: lookAt, ease: 'linear', minDuration: 5 };
  return { position, lookAt, lookAtEnd, ease: 'linear', minDuration: 5 };
}

function lowDollyCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { depth, centerZ } = roomDims(maxSeat(office));
  const sx = rng() < 0.5 ? -1 : 1;
  const z = centerZ + (rng() - 0.5) * depth * 0.6;
  // track runs down the aisles between desk columns (x = ±3.4, ~1.1 half-width), not
  // along the side walls where the couch/lamp line lives.
  const position = clampToRoom(new THREE.Vector3(sx * (1.7 + (rng() - 0.5) * 0.4), 1.1 + rng() * 0.3, z), office);
  const lookAt = new THREE.Vector3(0, 1.3, z + (rng() - 0.5) * 2);
  // a real dolly move: camera and look target travel together down the aisle
  const dz = (rng() < 0.5 ? -1 : 1) * (1.2 + rng() * 0.6);
  return {
    position,
    positionEnd: clampToRoom(position.clone().add(new THREE.Vector3(0, 0, dz)), office),
    lookAt,
    lookAtEnd: lookAt.clone().add(new THREE.Vector3(0, 0, dz)),
    minDuration: 5,
  };
}

function wideEstablishingCandidate(office: OfficeState | null, rng: () => number): Shot {
  const { width, depth, centerZ, height } = roomDims(maxSeat(office));
  const angle = rng() * Math.PI * 2;
  const position = clampToRoom(new THREE.Vector3(
    Math.cos(angle) * width * 0.42, 2.2 + rng() * (height - 4.2), centerZ + Math.sin(angle) * depth * 0.42), office);
  // slow creeping zoom on the wide
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ), fov: 50, fovEnd: 43, minDuration: 6 };
}

export const SINGLE_POOL: ArchetypeName[] = ['otsCloseup', 'highAngle', 'sideProfile', 'pushInCloseup', 'orbitArc', 'zoomPunch', 'lowPush'];
export const GROUP_POOL: ArchetypeName[] = ['groupLevel', 'elevatedGroup', 'groupArc'];
export const IDLE_POOL: ArchetypeName[] = ['overheadGod', 'highCorner', 'lowDolly', 'wideEstablishing'];

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
  /** primary subject keys of recent shots, most recent first (least-recently-shot weighting) */
  recentPrimaries?: string[];
}

/** Boss screen and wall boards fire rarely; give them extra draw weight so their
 *  brief activity windows actually land as shots among streaming employee monitors. */
function subjectWeight(s: Subject): number {
  return s.key === 'boss' || isWallBoard(s.key) ? 2 : 1;
}

function pickPrimary(subjects: Subject[], recentPrimaries: string[], rng: () => number): Subject {
  const recent = recentPrimaries.slice(0, 2);
  const fresh = subjects.filter((s) => !recent.includes(s.key));
  const pool = fresh.length > 0 ? fresh : subjects;
  const total = pool.reduce((sum, s) => sum + subjectWeight(s), 0);
  let r = rng() * total;
  for (const s of pool) {
    r -= subjectWeight(s);
    if (r < 0) return s;
  }
  return pool[pool.length - 1];
}

export function pickShot(ctx: ShotContext): PickedShot {
  const { office, fovY, aspect, rng } = ctx;
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
      if (validShot(shot, losSubjects, office, prev, minDist)) return { ...shot, archetype: name };
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

  // One primary subject per cut — the hard invariant is LOS to this ONE active
  // screen (validated along the whole camera move). Facing-compatible neighbors
  // are framed opportunistically by group archetypes but never constrain LOS,
  // so a crowd of active monitors can't starve boss/board shots anymore.
  const primary = pickPrimary(subjects, ctx.recentPrimaries ?? [], rng);
  const neighbors = subjects.filter((s) => s !== primary && s.normal.dot(primary.normal) > -0.01);

  const gens: Record<string, () => Shot> = {
    otsCloseup: () => otsCloseupCandidate(primary, fovY, aspect, rng, office),
    highAngle: () => highAngleCandidate(primary, fovY, aspect, rng, office),
    sideProfile: () => sideProfileCandidate(primary, fovY, aspect, rng, office),
    pushInCloseup: () => pushInCloseupCandidate(primary, fovY, aspect, rng, office),
    orbitArc: () => orbitArcCandidate(primary, fovY, aspect, rng, office),
    zoomPunch: () => zoomPunchCandidate(primary, aspect, rng, office),
    lowPush: () => lowPushCandidate(primary, fovY, aspect, rng, office),
    boardPan: () => boardPanCandidate(primary, fovY, aspect, rng, office),
  };
  let pool: ArchetypeName[] = [...SINGLE_POOL];
  if (isWallBoard(primary.key)) pool.push('boardPan');
  if (neighbors.length > 0) {
    const group = [primary, ...neighbors];
    gens.groupLevel = () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX, 'truck');
    gens.elevatedGroup = () => groupCandidate(group, fovY, aspect, rng, office, deg(25), deg(45), 'pushIn');
    gens.groupArc = () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX, 'arc');
    pool = [...pool, ...GROUP_POOL];
  }

  const hit = tryPool(pool, gens, [primary]);
  if (hit) return { ...hit, primaryKey: primary.key };
  // best-effort fallback: static close-up on the primary
  return { ...closeUpShot(primary, fovY, aspect, rng, office), archetype: 'otsCloseup', primaryKey: primary.key };
}
