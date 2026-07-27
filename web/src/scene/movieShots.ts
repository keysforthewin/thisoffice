import * as THREE from 'three';
import type { OfficeState } from '../../../shared/types.ts';
import { roomDims } from './layout.ts';
import { resolveSeat, resolveWallItem } from './buildLayout.ts';
import { wallFrame, wallToWorld } from './walls.ts';
import { TV_SCREEN_W, TV_SCREEN_H } from './WallTV.tsx';
import { EOTM_KEY, EOTM_W, EOTM_H, EOTM_CAPTION_H } from './eotmTexture.ts';

export const ACTIVE_WINDOW_MS = 22_000;

/**
 * Boss inbox and whiteboard changes are single events (not streams), so their
 * activity window differs from streaming employee monitors: long enough to
 * survive the min shot hold + cut cadence (MIN_HOLD_S + CUT_MAX_S = 20s, so 24s
 * leaves margin), and the status board stays a cut target for minutes after an
 * update. These track the MovieCamera cadence — if the cut timing changes, these
 * have to grow with it or a subject can go stale before it is ever cut to.
 */
const ACTIVITY_TTL_MS: Record<string, number> = { boss: 24_000, whiteboard: 24_000, statusboard: 150_000, tv: 150_000 };
const WALL_BOARD_TTL_MS = 24_000;

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
/** The boss desk's waiting-for-input beacon: WaitingLight's group offset plus the
 *  bulb's own local y (Desk.tsx). Not a screen — it is a framing CONSTRAINT while it
 *  blinks, and only doubles as a shot subject in the last-resort fallback, so its
 *  "size" is the readable patch of desk around it rather than the 0.05 bulb itself. */
const BEACON_OFFSET = new THREE.Vector3(0.7, 1.07, 0.25);
const BEACON_SIZE = 0.9;
export const BEACON_KEY = 'beacon';
/**
 * The 20 Questions bubble as a shot subject. Not a screen and not driven by
 * `lastActivity`: the question is either up or it isn't, and while it is up it
 * is the only thing in the room asking the player for anything. It joins the
 * subject list only when no live screen is active (see pickShot), so it never
 * competes with real work — it fills the silence the ambient wall boards would
 * otherwise own alone.
 */
export const QUIZ_KEY = 'quiz';
/** Wide enough to hold the asker under their bubble, not just the bubble. */
const QUIZ_SIZE = 2.4;
/** The bubble hangs at y 3.0 (askerAnchor); frame from between it and the head. */
const QUIZ_CENTER_DROP = 0.5;
/** Focus/subject keys for the two wall boards — shared with Whiteboard.tsx, which
 *  stamps them on the board meshes so a click (cursor or fly-cam crosshair) lands
 *  on the same subject the movie camera shoots. */
export const TODO_BOARD_KEY = 'whiteboard';
export const STATUS_BOARD_KEY = 'statusboard';

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
  /** canted-angle roll in RADIANS, applied about the view axis after lookAt; absent means no roll */
  roll?: number;
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
  // the beacon sits on the boss's own desk, in front of them: treat it as seat 0 so
  // hasLineOfSight skips the boss's body and monitor rather than self-occluding it
  if (key === 'boss' || key === BEACON_KEY) return 0;
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

/**
 * Subject keys for the wall surfaces map onto wall-item ids. Both live where the
 * layout says they live — any wall, any height — so centre and normal are read
 * off the resolved placement rather than baked in. A board dragged to the back
 * wall gets shot from the front of it, not from inside the wall it used to be on.
 */
const WALL_BOARD_ITEMS: Record<string, { id: string; width: number; height: number }> = {
  [TODO_BOARD_KEY]: { id: 'todoBoard', width: WHITEBOARD_W, height: WHITEBOARD_H },
  [STATUS_BOARD_KEY]: { id: 'statusBoard', width: WHITEBOARD_W, height: WHITEBOARD_H },
  tv: { id: 'tv', width: TV_SCREEN_W, height: TV_SCREEN_H },
  // Photo *and* plaque *and* moulding: the whole point of visiting the frame is
  // reading who won, and the subject size is what every archetype fits its
  // distance to — so this is the outer box (EotmFrame's + 0.16), not the
  // aperture. The moulding is a picture frame's own margin; without it the
  // jittered oblique shots crop a corner off the thing they came to look at.
  [EOTM_KEY]: { id: 'eotm', width: EOTM_W + 0.16, height: EOTM_H + EOTM_CAPTION_H + 0.16 },
};

/** The live subject for a wall surface, from wherever the layout hangs it. */
function wallBoardSubject(key: string, office: OfficeState | null): Subject | null {
  const def = WALL_BOARD_ITEMS[key];
  if (!def) return null;
  const ms = maxSeat(office);
  const placement = resolveWallItem(office?.layout, def.id, ms);
  const frame = wallFrame(placement.wall, ms);
  return {
    key,
    center: wallToWorld(placement.wall, placement.ox, placement.oy, ms),
    normal: frame.normal.clone(),
    width: def.width,
    height: def.height,
  };
}

export function isWallBoard(key: string): boolean {
  return key in WALL_BOARD_ITEMS;
}

/**
 * The bubble is a drei `<Html>`, so it always faces the camera and is legible
 * from anywhere — which makes "readable from" the wrong question. What matters
 * is that the camera stands in open floor rather than inside a wall behind the
 * asker, so the normal points from the anchor toward the middle of the room.
 * That works for a seated employee, the boss against the back wall and Kat
 * Person in her corner alike, without knowing which of the three it is.
 */
export function quizSubject(anchor: [number, number, number], office: OfficeState | null): Subject {
  const { centerZ } = roomDims(maxSeat(office));
  const center = new THREE.Vector3(anchor[0], anchor[1] - QUIZ_CENTER_DROP, anchor[2]);
  const toCenter = new THREE.Vector3(0, 0, centerZ).sub(center);
  toCenter.y = 0;
  const normal = toCenter.lengthSq() < 1e-6 ? new THREE.Vector3(0, 0, 1) : toCenter.normalize();
  return { key: QUIZ_KEY, center, normal, width: QUIZ_SIZE, height: QUIZ_SIZE };
}

export function subjectFor(key: string, office: OfficeState | null): Subject | null {
  if (key === BEACON_KEY) {
    const { position, rotationY } = resolveSeat(office?.layout, 0, maxSeat(office));
    return {
      key,
      center: position.clone().add(BEACON_OFFSET.clone().applyAxisAngle(UP, rotationY)),
      // the desk faces +z with the occupant behind it at local z −1.15, so the light
      // reads from the room side and slightly above (it points up off the desk top)
      normal: new THREE.Vector3(0, 0.4, 1).normalize().applyAxisAngle(UP, rotationY),
      width: BEACON_SIZE,
      height: BEACON_SIZE,
    };
  }
  const board = wallBoardSubject(key, office);
  if (board) return board;
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

/**
 * Is `point` inside the frame of a camera at `camPos` looking at `lookAt`? LOS answers
 * "is it unoccluded", which is not the same question — a subject can be perfectly
 * visible and sit far outside the frame. `margin` (< 1) shrinks the frustum so the
 * point lands off the frame edge, which also absorbs the ≤15° roll a dutch shot adds
 * after lookAt and the handheld sinusoid noise MovieCamera layers on every frame.
 */
export function pointInFrame(
  camPos: THREE.Vector3, lookAt: THREE.Vector3, point: THREE.Vector3,
  fovY: number, aspect: number, margin = 0.85,
): boolean {
  const forward = lookAt.clone().sub(camPos);
  if (forward.lengthSq() < 1e-9) return false;
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, UP);
  if (right.lengthSq() < 1e-9) return false; // dead-vertical view: no stable basis
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const v = point.clone().sub(camPos);
  const z = v.dot(forward);
  if (z <= 1e-3) return false; // behind the camera (or on the lens)
  const tanY = Math.tan(fovY / 2) * margin;
  return Math.abs(v.dot(up)) <= z * tanY && Math.abs(v.dot(right)) <= z * tanY * aspect;
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
  | 'staticCloseup' | 'staticProfile' | 'staticHighAngle' | 'staticLow' | 'dutchStatic' | 'tiltReveal'
  | 'groupLevel' | 'elevatedGroup' | 'groupArc' | 'staticGroup'
  | 'overheadGod' | 'highCorner' | 'lowDolly' | 'wideEstablishing' | 'staticWide' | 'staticCorner';

/** Selection weight and static/moving classification per archetype. Statics are
 *  weighted heavily (3, staticGroup 5 — the group pool only has one static member
 *  so it needs extra weight to clear the ~55-65% per-pool static-share target);
 *  gentle authored motion 1.5; big showy moves 1. See pickShot's weighted order(). */
export const ARCHETYPES: Record<ArchetypeName, { weight: number; static: boolean }> = {
  otsCloseup: { weight: 1.5, static: false },
  highAngle: { weight: 1.5, static: false },
  sideProfile: { weight: 1.5, static: false },
  pushInCloseup: { weight: 1, static: false },
  orbitArc: { weight: 1, static: false },
  zoomPunch: { weight: 1, static: false },
  lowPush: { weight: 1, static: false },
  boardPan: { weight: 1.5, static: false },
  staticCloseup: { weight: 3, static: true },
  staticProfile: { weight: 3, static: true },
  staticHighAngle: { weight: 3, static: true },
  staticLow: { weight: 3, static: true },
  dutchStatic: { weight: 3, static: true },
  tiltReveal: { weight: 1.5, static: false },
  groupLevel: { weight: 1.5, static: false },
  elevatedGroup: { weight: 1, static: false },
  groupArc: { weight: 1, static: false },
  staticGroup: { weight: 5, static: true },
  overheadGod: { weight: 1, static: false },
  highCorner: { weight: 1.5, static: false },
  lowDolly: { weight: 1.5, static: false },
  wideEstablishing: { weight: 1, static: false },
  staticWide: { weight: 3.5, static: true },
  staticCorner: { weight: 3.5, static: true },
};

export interface PickedShot extends Shot {
  archetype: ArchetypeName;
  /** active subject key the shot is built around; absent for idle B-roll */
  primaryKey?: string;
}

interface ShotConstraints {
  /** LOS to every one of these is required along the whole move; empty for idle B-roll */
  subjects: Subject[];
  office: OfficeState | null;
  prev: THREE.Vector3 | null;
  minDist: number;
  /** must be unoccluded AND inside the frame at every sample (the blinking beacon) */
  framed?: { subject: Subject; fovY: number; aspect: number };
  /** camera must stay within `max` of `center` — the close/medium ceiling */
  maxRange?: { center: THREE.Vector3; max: number };
}

/** Camera pose at eased progress `e` through a shot. */
function poseAt(shot: Shot, e: number): { pos: THREE.Vector3; look: THREE.Vector3 } {
  return {
    pos: shot.position.clone().lerp(shot.positionEnd ?? shot.position, e),
    look: shot.lookAt.clone().lerp(shot.lookAtEnd ?? shot.lookAt, e),
  };
}

/** A shot passes only if its whole camera path (start, midpoint, end) stays
 *  outside occluders and sees every required subject, and it starts far enough
 *  from the previous shot. Empty subjects (idle B-roll) skips LOS. */
function validShot(shot: Shot, c: ShotConstraints): boolean {
  if (c.prev && shot.position.distanceTo(c.prev) < c.minDist) return false;
  // a lookAt-only move (boardPan, tiltReveal) holds position but re-aims, so framing
  // has to be sampled across it too — hence poses, not just positions
  const moves = !!shot.positionEnd || !!shot.lookAtEnd;
  const poses = moves ? [poseAt(shot, 0), poseAt(shot, 0.5), poseAt(shot, 1)] : [poseAt(shot, 0)];
  // frame the required point at the TIGHTEST fov the shot reaches, so a zoomPunch
  // narrowing to 34° can't push it out mid-move
  const fovDeg = Math.min(shot.fov ?? Infinity, shot.fovEnd ?? Infinity);
  const framedFovY = Number.isFinite(fovDeg) ? deg(fovDeg) : c.framed?.fovY ?? 0;
  // cheap pose-local tests first: they're plain vector math, while the occluder/LOS
  // pass below loops every occupied seat's body spheres and monitor box
  for (const { pos, look } of poses) {
    if (c.maxRange && pos.distanceTo(c.maxRange.center) > c.maxRange.max) return false;
    if (c.framed && !pointInFrame(pos, look, c.framed.subject.center, framedFovY, c.framed.aspect)) return false;
  }
  for (const { pos } of poses) {
    if (isInsideOccluder(pos, c.office)) return false;
    if (!c.subjects.every((s) => hasLineOfSight(pos, s, c.office))) return false;
    if (c.framed && !hasLineOfSight(pos, c.framed.subject, c.office)) return false;
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

function staticCloseupCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // the OTS framing without the push-in: fixed at the closeup distance
  return dollyCandidate(s, fovY, aspect, rng, office, CLOSEUP_YAW, CLOSEUP_PITCH_MIN, CLOSEUP_PITCH_MAX, 1.05, 1.05, 1.3);
}

function staticProfileCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // sideProfileCandidate's framing with no lateral truck
  const sign = rng() < 0.5 ? -1 : 1;
  const yaw = sign * (deg(55) + rng() * deg(25));
  const pitch = deg(5) + rng() * deg(15);
  const dist = fitDistance(s.width, s.height, fovY, aspect, 1.3) * 1.8;
  const dir = jitterDir(s.normal.clone().applyAxisAngle(UP, yaw), rng, 0, pitch, pitch);
  const position = clampToRoom(s.center.clone().addScaledVector(dir, dist), office);
  return { position, lookAt: s.center.clone() };
}

function staticHighAngleCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // the existing high angle with no arc
  return dollyCandidate(s, fovY, aspect, rng, office, deg(35), deg(45), deg(65), 1.6, 1.6, 1.3);
}

function staticLowCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // worm's-eye: camera below screen center looking up; clampToRoom keeps y >= 0.4
  return dollyCandidate(s, fovY, aspect, rng, office, deg(30), deg(-10), deg(0), 1.4, 1.4, 1.3);
}

function dutchStaticCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // medium static shot, canted roll for a dutch-angle look
  const shot = dollyCandidate(s, fovY, aspect, rng, office, CLOSEUP_YAW, CLOSEUP_PITCH_MIN, CLOSEUP_PITCH_MAX, 1.3, 1.3, 1.3);
  const sign = rng() < 0.5 ? -1 : 1;
  shot.roll = sign * (deg(8) + rng() * deg(7));
  return shot;
}

function tiltRevealCandidate(s: Subject, fovY: number, aspect: number, rng: () => number, office: OfficeState | null): Shot {
  // static position; the look target tilts up from desk level to the screen
  const dist = fitDistance(s.width, s.height, fovY, aspect, 1.3) * 1.5;
  const dir = jitterDir(s.normal, rng, CLOSEUP_YAW, CLOSEUP_PITCH_MIN, CLOSEUP_PITCH_MAX);
  const position = clampToRoom(s.center.clone().addScaledVector(dir, dist), office);
  return {
    position,
    lookAt: s.center.clone().sub(new THREE.Vector3(0, 0.9, 0)),
    lookAtEnd: s.center.clone(),
    ease: 'inOut',
    minDuration: 4,
  };
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

function staticWideCandidate(office: OfficeState | null, rng: () => number): Shot {
  // the wide establishing framing with no fov zoom and no move
  const { width, depth, centerZ, height } = roomDims(maxSeat(office));
  const angle = rng() * Math.PI * 2;
  const position = clampToRoom(new THREE.Vector3(
    Math.cos(angle) * width * 0.42, 2.2 + rng() * (height - 4.2), centerZ + Math.sin(angle) * depth * 0.42), office);
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
}

function staticCornerCandidate(office: OfficeState | null, rng: () => number): Shot {
  // high-corner position with a fixed look at the room center (no surveillance pan)
  const { width, depth, centerZ } = roomDims(maxSeat(office));
  const sx = rng() < 0.5 ? -1 : 1;
  const sz = rng() < 0.5 ? -1 : 1;
  const position = clampToRoom(new THREE.Vector3(
    sx * (width / 2 - 0.6), 3.0 + rng() * 0.5, centerZ + sz * (depth / 2 - 0.6)), office);
  return { position, lookAt: new THREE.Vector3(0, 1.2, centerZ) };
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

export const SINGLE_POOL: ArchetypeName[] = [
  'otsCloseup', 'highAngle', 'sideProfile', 'pushInCloseup', 'orbitArc', 'zoomPunch', 'lowPush',
  'staticCloseup', 'staticProfile', 'staticHighAngle', 'staticLow', 'dutchStatic', 'tiltReveal',
];
export const GROUP_POOL: ArchetypeName[] = ['groupLevel', 'elevatedGroup', 'groupArc', 'staticGroup'];
export const IDLE_POOL: ArchetypeName[] = ['overheadGod', 'highCorner', 'lowDolly', 'wideEstablishing', 'staticWide', 'staticCorner'];

/**
 * Pseudo-primary for the room itself: the idle pool's wides, offered as a peer of
 * the ambient wall surfaces rather than only as the empty-set branch.
 *
 * Without it an office with nothing live parks on its set dressing. The TV and the
 * status board carry 150-second activity windows *because* they are ambient, and a
 * lone stamped one is still `subjects.length > 0` — so every cut for two and a half
 * minutes had exactly one primary to choose from and the camera sat on the TV. Now
 * the room competes for those cuts, and since it is recorded in `recentPrimaries`
 * like any other primary, the least-recently-led ordering alternates them.
 */
export const IDLE_KEY = 'idle';

/**
 * Subjects that are not driven by `lastActivity` and so can never "go quiet":
 * the room, an open question, a hung photo, the blinking beacon. Each has its own
 * lifecycle, and the camera already recuts on all of them.
 */
const STANDING_KEYS = new Set([IDLE_KEY, QUIZ_KEY, EOTM_KEY, BEACON_KEY]);

/**
 * The shot we are holding is on a screen that has just gone quiet.
 *
 * Worth its own signal rather than leaving it to the active-set fingerprint: that
 * recut waits out the full `MIN_HOLD_S`, which means up to five seconds of staring
 * at a monitor that stopped streaming. The camera cuts away on the shortened
 * preempt floor instead — long enough to finish the beat, short enough not to
 * dwell on a dead screen.
 */
export function watchedSubjectWentQuiet(
  primaryKey: string | undefined,
  lastActivity: Record<string, number>,
  now: number,
): boolean {
  if (!primaryKey || STANDING_KEYS.has(primaryKey)) return false;
  return !activeKeys(lastActivity, now).includes(primaryKey);
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
  /** committed position of the previous shot; candidates closer than MIN_SHOT_DIST are rejected */
  prevPosition?: THREE.Vector3 | null;
  /** archetype names of the last three shots — never repeated */
  recentArchetypes?: ArchetypeName[];
  /** primary subject keys of recent shots, most recent first (least-recently-shot weighting) */
  recentPrimaries?: string[];
  /** whether each of the recent shots had motion, most recent first — two moving shots
   *  in a row force the next pick's candidate order to try static archetypes first */
  recentMotion?: boolean[];
  /** the boss-desk beacon is blinking: every shot must frame it (office.waitingForInput) */
  waiting?: boolean;
  /** subject key to try first regardless of weighting — a new inbox message forces 'boss' */
  forcePrimary?: string;
  /** world anchor of the open 20 Questions bubble, if one is up (quiz/askerAnchor.ts) */
  quizAnchor?: [number, number, number] | null;
  /** the Employee of the Month frame is hanging with a photo in it: keep it in the rotation */
  awardFrame?: boolean;
}

/**
 * Long-lived wall surfaces: they stay "active" for minutes (see ACTIVITY_TTL_MS) so
 * they read as ambient set dressing, not live work. A primary is only ever drawn from
 * them when nothing live — a streaming monitor or the todo board — is active at all.
 *
 * `EOTM_KEY` belongs here for a stronger reason than the other two: it has no
 * activity window at all — while the game is on, the award frame is *always* a
 * candidate — so anything but ambient rank would park the camera on a wall
 * hanging while real work streamed, and its permanent presence in the active set
 * would also stop the quiz bubble ever joining the cast (see `pickShot`, which
 * admits the bubble only when everything else on offer is ambient).
 */
const AMBIENT_KEYS = new Set([STATUS_BOARD_KEY, 'tv', EOTM_KEY]);

/** Camera distance ceiling while anything is active, as a multiple of the primary's
 *  fit distance: a busy office gets close/medium coverage where a screen is legible.
 *  2.4 keeps pushInCloseup (starts at ×2.2) and everything tighter; wides are already
 *  unreachable here since IDLE_POOL only runs on an empty active set. */
export const MEDIUM_MAX_MUL = 2.4;

/** How many primaries a single cut will try before falling back. */
const MAX_PRIMARY_TRIES = 3;

/** Weighted sampling without replacement: repeatedly draw from the remaining set by
 *  weight. Higher-weight items tend to sort earlier, but it's still randomized (not a
 *  plain sort), so ties and near-ties still shuffle. */
function weightedShuffle<T>(items: T[], weight: (t: T) => number, rng: () => number): T[] {
  const remaining = items.slice();
  const out: T[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, t) => sum + weight(t), 0);
    let r = rng() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= weight(remaining[i]);
      if (r < 0) { idx = i; break; }
    }
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

/** The room outweighs its own set dressing. An idle office is mostly a room to look
 *  at, punctuated by the boards — not a TV with the occasional glance elsewhere. */
const IDLE_WEIGHT = 3;

/**
 * Boss screen and the todo board fire rarely; give them extra draw weight so their
 * brief activity windows actually land as shots among streaming employee monitors.
 *
 * The AMBIENT surfaces get no such help, and deliberately so — the bonus exists for
 * subjects whose window is *short*, and theirs run for minutes. Weighting them up
 * only ever mattered inside the idle tier, where they compete with the room rather
 * than with live work, and there it read as the camera parking on the TV.
 */
function subjectWeight(s: { key: string }): number {
  if (s.key === IDLE_KEY) return IDLE_WEIGHT;
  if (AMBIENT_KEYS.has(s.key)) return 1;
  return s.key === 'boss' || s.key === QUIZ_KEY || isWallBoard(s.key) ? 2 : 1;
}

/**
 * The whole tier in try-order: least-recently-led first (weighted within each half),
 * recently-led as a last resort. An ORDER rather than a single draw because a primary
 * can now fail outright — the beacon-framing and close/medium constraints reject every
 * candidate for some subjects — and the next one should get its turn instead of the
 * cut collapsing to the unvalidated fallback.
 */
function orderPrimaries<T extends { key: string }>(subjects: T[], recentPrimaries: string[], rng: () => number): T[] {
  // How far back "recently led" looks. Capped so it can never cover the whole tier
  // minus one: at that point exactly one candidate is ever fresh, the draw becomes a
  // fixed round-robin and the weights stop meaning anything — which is how a stamped
  // TV and status board got a guaranteed third of every idle cut each. The no-repeat
  // rule below is what keeps variety in a small tier; the window handles large ones.
  const recent = recentPrimaries.slice(0, Math.max(0, Math.min(2, subjects.length - 2)));
  const ordered = [
    ...weightedShuffle(subjects.filter((s) => !recent.includes(s.key)), subjectWeight, rng),
    ...weightedShuffle(subjects.filter((s) => recent.includes(s.key)), subjectWeight, rng),
  ];
  // Never lead on the same *subject* twice running while another is on offer. The
  // least-recently-led split above degenerates when the tier is smaller than the
  // window it looks back over — with two candidates, one cut each puts BOTH in
  // `recent`, the first half empties, and the draw collapses to raw weight. That
  // is what let a lone stamped TV take two, three cuts in a row.
  //
  // `IDLE_KEY` is exempt: it is not a subject but the room, and two consecutive
  // idle cuts are two different wides (different archetype — `recent` bars the
  // last three — from a different randomized position), not the same shot twice.
  // Without the exemption this rule forces strict alternation and hands the TV
  // every other cut no matter what its weight says.
  if (ordered.length > 1 && ordered[0].key === recentPrimaries[0] && ordered[0].key !== IDLE_KEY) {
    [ordered[0], ordered[1]] = [ordered[1], ordered[0]];
  }
  return ordered;
}

export function pickShot(ctx: ShotContext): PickedShot {
  const { office, fovY, aspect, rng } = ctx;
  const prev = ctx.prevPosition ?? null;
  const recent = ctx.recentArchetypes ?? [];
  const stamped = activeKeys(ctx.lastActivity, ctx.now)
    .map((k) => subjectFor(k, office))
    .filter((s): s is Subject => s !== null);
  // The award frame has no activity to stamp — a photo hangs there for days —
  // so it is simply always in the cast while the game is on, at ambient rank.
  // No activity window to expire — a photo hangs there for days — so while the game
  // is on and someone has won it is simply always in the cast, at ambient rank. It
  // used to be rationed to one cut in three, because a silent office would otherwise
  // have had it as the *only* candidate and parked on it; `IDLE_KEY` is what stops
  // that now, for every ambient subject at once, so the ration is gone.
  const award = ctx.awardFrame ? subjectFor(EOTM_KEY, office) : null;
  const active = award ? [...stamped, award] : stamped;
  // An open question joins the cast only while no live screen is streaming: with
  // work on the monitors the bubble waits its turn, and with the office quiet it
  // becomes one of the things the camera cuts to instead of pure B-roll.
  const quiz =
    ctx.quizAnchor && active.every((s) => AMBIENT_KEYS.has(s.key)) ? quizSubject(ctx.quizAnchor, office) : null;
  const subjects = quiz ? [...active, quiz] : active;

  const weightedOrder = (names: ArchetypeName[]): ArchetypeName[] =>
    weightedShuffle(names, (n) => ARCHETYPES[n].weight, rng);

  // Two moving shots in a row: break the streak by trying every static candidate —
  // fresh ones first, then recently-used ones — before any moving candidate at all
  // (moving archetypes become pure validation fallback for this cut).
  const breakStreak = ctx.recentMotion?.[0] === true && ctx.recentMotion?.[1] === true;

  /** fresh archetypes first (weighted order), recently-used ones as a last resort;
   *  under a moving streak, static-ness takes priority over freshness. */
  const order = (pool: ArchetypeName[]): ArchetypeName[] => {
    const fresh = pool.filter((n) => !recent.includes(n));
    const used = pool.filter((n) => recent.includes(n));
    if (breakStreak) {
      const isStatic = (n: ArchetypeName) => ARCHETYPES[n].static;
      return [
        ...weightedOrder(fresh.filter(isStatic)),
        ...weightedOrder(used.filter(isStatic)),
        ...weightedOrder(fresh.filter((n) => !isStatic(n))),
        ...weightedOrder(used.filter((n) => !isStatic(n))),
      ];
    }
    return [...weightedOrder(fresh), ...weightedOrder(used)];
  };

  // While the boss-desk beacon blinks it is a hard framing requirement on EVERY shot:
  // unoccluded and inside the frame at start, midpoint and end. It outranks the
  // active-screen preference — a screen is framed only if a beacon-valid shot happens
  // to include one.
  const beacon = ctx.waiting ? subjectFor(BEACON_KEY, office) : null;
  const framed = beacon ? { subject: beacon, fovY, aspect } : undefined;

  const attempt = (
    name: ArchetypeName, gen: () => Shot, losSubjects: Subject[],
    minDist: number, maxRange: ShotConstraints['maxRange'],
  ): PickedShot | null => {
    for (let i = 0; i < LOS_CANDIDATES; i++) {
      const shot = gen();
      if (validShot(shot, { subjects: losSubjects, office, prev, minDist, framed, maxRange })) {
        return { ...shot, archetype: name };
      }
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
    maxRange?: ShotConstraints['maxRange'],
  ): PickedShot | null => {
    const ordered = order(pool);
    for (const minDist of [MIN_SHOT_DIST, MIN_SHOT_DIST / 2]) {
      for (const name of ordered) {
        const hit = attempt(name, gens[name], losSubjects, minDist, maxRange);
        if (hit) return hit;
      }
    }
    return null;
  };

  /** Last resort while the beacon blinks: a close-up on the beacon itself, which frames
   *  it by construction. Preferred over any unvalidated fallback that might miss it. */
  const beaconFallback = (): PickedShot | null =>
    beacon ? { ...closeUpShot(beacon, fovY, aspect, rng, office), archetype: 'staticCloseup', primaryKey: BEACON_KEY } : null;

  /** The room itself as a shot: the idle pool's wides, with no subject to hold LOS on. */
  const idleShot = (): PickedShot | null => {
    const gens: Record<string, () => Shot> = {
      overheadGod: () => overheadGodCandidate(office, rng),
      highCorner: () => highCornerCandidate(office, rng),
      lowDolly: () => lowDollyCandidate(office, rng),
      wideEstablishing: () => wideEstablishingCandidate(office, rng),
      staticWide: () => staticWideCandidate(office, rng),
      staticCorner: () => staticCornerCandidate(office, rng),
    };
    const hit = tryPool(IDLE_POOL, gens, []);
    return hit ? { ...hit, primaryKey: IDLE_KEY } : null;
  };

  if (subjects.length === 0) {
    const hit = idleShot();
    if (hit) return hit;
    // an idle office whose light is blinking still owes the viewer the light
    return beaconFallback() ?? { ...wideShot(office, rng), archetype: 'wideEstablishing' }; // last-resort, unvalidated
  }

  // One primary subject per cut — the hard invariant is LOS to this ONE active
  // screen (validated along the whole camera move). Facing-compatible neighbors
  // are framed opportunistically by group archetypes but never constrain LOS,
  // so a crowd of active monitors can't starve boss/board shots anymore.
  //
  // Live monitors and the todo board outrank the ambient wall boards, whose activity
  // windows run for minutes: never cut to set dressing while real work is on screen.
  // The quiz bubble sits in the same tier as the ambient boards rather than above
  // them: with the office quiet the camera rotates between the question, the status
  // board and the TV, instead of parking on the bubble for every cut.
  //
  // With nothing live, the room joins that tier as `IDLE_KEY`: an office whose only
  // stamped subject is a long-window wall surface is idle, and the wides belong in
  // the rotation rather than being reserved for the (rare) empty active set.
  const live = subjects.filter((s) => !AMBIENT_KEYS.has(s.key) && s.key !== QUIZ_KEY);
  const tier: ({ key: string } | Subject)[] = live.length > 0 ? live : [...subjects, { key: IDLE_KEY }];
  let ordered = orderPrimaries(tier, ctx.recentPrimaries ?? [], rng);
  if (ctx.forcePrimary) {
    const forced = subjects.find((s) => s.key === ctx.forcePrimary) ?? subjectFor(ctx.forcePrimary, office);
    if (forced) ordered = [forced, ...ordered.filter((s) => s.key !== forced.key)];
  }

  // bounded so a hard cut (every candidate for every archetype rejected) can't fan out
  // across a nine-desk office: three primaries is enough for the constraints to find air
  for (const entry of ordered.slice(0, MAX_PRIMARY_TRIES)) {
    if (entry.key === IDLE_KEY) {
      const hit = idleShot();
      if (hit) return hit;
      continue; // the room was unshootable from here; the stamped subjects get their turn
    }
    const primary = entry as Subject;
    const neighbors = subjects.filter((s) => s.key !== primary.key && s.normal.dot(primary.normal) > -0.01);

    const gens: Record<string, () => Shot> = {
      otsCloseup: () => otsCloseupCandidate(primary, fovY, aspect, rng, office),
      highAngle: () => highAngleCandidate(primary, fovY, aspect, rng, office),
      sideProfile: () => sideProfileCandidate(primary, fovY, aspect, rng, office),
      pushInCloseup: () => pushInCloseupCandidate(primary, fovY, aspect, rng, office),
      orbitArc: () => orbitArcCandidate(primary, fovY, aspect, rng, office),
      zoomPunch: () => zoomPunchCandidate(primary, aspect, rng, office),
      lowPush: () => lowPushCandidate(primary, fovY, aspect, rng, office),
      boardPan: () => boardPanCandidate(primary, fovY, aspect, rng, office),
      staticCloseup: () => staticCloseupCandidate(primary, fovY, aspect, rng, office),
      staticProfile: () => staticProfileCandidate(primary, fovY, aspect, rng, office),
      staticHighAngle: () => staticHighAngleCandidate(primary, fovY, aspect, rng, office),
      staticLow: () => staticLowCandidate(primary, fovY, aspect, rng, office),
      dutchStatic: () => dutchStaticCandidate(primary, fovY, aspect, rng, office),
      tiltReveal: () => tiltRevealCandidate(primary, fovY, aspect, rng, office),
    };
    // something is active, so this cut stays at close/medium range on its primary:
    // far coverage is reserved for the idle branch above
    const maxRange = {
      center: primary.center,
      max: fitDistance(primary.width, primary.height, fovY, aspect, 1.3) * MEDIUM_MAX_MUL,
    };

    // Only offer group archetypes for a cluster tight enough to shoot from inside that
    // ceiling — nearest neighbor first, stopping at the first one that pushes the framing
    // too far back. At the default 3.4-unit desk spacing that means no group shot at all
    // (fitting two desks needs ~8 units, which is a wide), but desks dragged together in
    // build mode still get one. dist + |centroid − primary| bounds the camera-to-primary
    // distance from above, so a group that passes here can't breach the ceiling later.
    const group = [primary];
    for (const n of [...neighbors].sort((a, b) => a.center.distanceTo(primary.center) - b.center.distanceTo(primary.center))) {
      const trial = [...group, n];
      const { centroid, dist } = groupFraming(trial, fovY, aspect);
      if (dist + centroid.distanceTo(primary.center) > maxRange.max) break;
      group.push(n);
    }

    let pool: ArchetypeName[] = [...SINGLE_POOL];
    if (isWallBoard(primary.key)) pool.push('boardPan');
    if (group.length > 1) {
      gens.groupLevel = () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX, 'truck');
      gens.elevatedGroup = () => groupCandidate(group, fovY, aspect, rng, office, deg(25), deg(45), 'pushIn');
      gens.groupArc = () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX, 'arc');
      gens.staticGroup = () => groupCandidate(group, fovY, aspect, rng, office, GROUP_PITCH_MIN, GROUP_PITCH_MAX, 'none');
      pool = [...pool, ...GROUP_POOL];
    }

    const hit = tryPool(pool, gens, [primary], maxRange);
    if (hit) return { ...hit, primaryKey: primary.key };
  }

  // best-effort fallback: static close-up on the beacon (if it must be framed) or the
  // first-choice real subject — `IDLE_KEY` carries no geometry to close in on, and its
  // own unvalidated fallback is the wide below
  const fallbackPrimary = ordered.find((s): s is Subject => s.key !== IDLE_KEY);
  return (
    beaconFallback() ??
    (fallbackPrimary
      ? { ...closeUpShot(fallbackPrimary, fovY, aspect, rng, office), archetype: 'otsCloseup', primaryKey: fallbackPrimary.key }
      : { ...wideShot(office, rng), archetype: 'wideEstablishing', primaryKey: IDLE_KEY })
  );
}
