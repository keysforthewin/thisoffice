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
