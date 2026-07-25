import * as THREE from 'three';
import type { ItemPose, OfficeLayout } from '../../../shared/types.ts';
import { BACK_Z, roomDims, seatTransform, type SeatTransform } from './layout.ts';
import { VISTA_LAYERS } from './vistaLayers.ts';

/**
 * Build-mode layout resolution: room-relative defaults (identical to the old
 * hardcoded scene) merged with user overrides from `OfficeLayout`, plus the
 * grid/rotation snapping and 2D collision used while dragging.
 */

export const GRID = 0.2;
export const ROT_SNAP = Math.PI / 12; // 15°

/** Keep dropped items a hair off the wall planes. */
const ROOM_MARGIN = 0.05;
/** Wall-mounted items stop short of the wall's ends. */
const WALL_END_MARGIN = 0.2;

export function snapPose(p: ItemPose): ItemPose {
  return {
    x: Math.round(p.x / GRID) * GRID,
    z: Math.round(p.z / GRID) * GRID,
    rotY: Math.round(p.rotY / ROT_SNAP) * ROT_SNAP,
  };
}

/** 2D footprint of an item on the floor, in its local frame (desk faces +z). */
export interface Footprint {
  w: number;
  d: number;
  /** footprint center offset along local z (a desk's chair hangs off the back) */
  cz: number;
}

const EMPLOYEE_DESK: Footprint = { w: 2.4, d: 2.6, cz: -0.7 };
const BOSS_DESK: Footprint = { w: 2.4 * 1.15, d: 2.6, cz: -0.7 };

export function deskFootprint(boss: boolean): Footprint {
  return boss ? BOSS_DESK : EMPLOYEE_DESK;
}

// ---------------------------------------------------------------------------
// OBB collision (2D, on the floor plane)

export interface Obb {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rotY: number;
}

export function obbFromPose(pose: ItemPose, fp: Footprint): Obb {
  // footprint center = pose origin + cz along local z, rotated into the world.
  // three.js Y-rotation by θ maps local (0,0,1) → (sinθ, 0, cosθ)
  return {
    cx: pose.x + Math.sin(pose.rotY) * fp.cz,
    cz: pose.z + Math.cos(pose.rotY) * fp.cz,
    hw: fp.w / 2,
    hd: fp.d / 2,
    rotY: pose.rotY,
  };
}

/** The two edge axes of an OBB in the (x,z) plane: local +x and local +z. */
function axes(o: Obb): Array<[number, number]> {
  return [
    [Math.cos(o.rotY), -Math.sin(o.rotY)], // local +x
    [Math.sin(o.rotY), Math.cos(o.rotY)], // local +z
  ];
}

function corners(o: Obb): Array<[number, number]> {
  const [ux, uz] = axes(o);
  const out: Array<[number, number]> = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      out.push([
        o.cx + ux[0] * o.hw * sx + uz[0] * o.hd * sz,
        o.cz + ux[1] * o.hw * sx + uz[1] * o.hd * sz,
      ]);
    }
  }
  return out;
}

/** Separating-axis test for two rotated rectangles on the floor plane. */
export function obbIntersects(a: Obb, b: Obb): boolean {
  const ca = corners(a);
  const cb = corners(b);
  for (const axis of [...axes(a), ...axes(b)]) {
    const proj = (c: [number, number]) => c[0] * axis[0] + c[1] * axis[1];
    const pa = ca.map(proj);
    const pb = cb.map(proj);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Room bounds

/** Axis-aligned half-extents of a footprint rotated by rotY, relative to the pose origin. */
function aabbOfFootprint(pose: ItemPose, fp: Footprint) {
  const o = obbFromPose(pose, fp);
  const cs = corners(o);
  const xs = cs.map((c) => c[0] - pose.x);
  const zs = cs.map((c) => c[1] - pose.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** Clamp a pose so its (rotated) footprint stays inside the current room. */
export function clampPoseToRoom(pose: ItemPose, fp: Footprint, maxSeat: number): ItemPose {
  const { width, depth, centerZ } = roomDims(maxSeat);
  const frontZ = centerZ + depth / 2;
  const e = aabbOfFootprint(pose, fp);
  const x = THREE.MathUtils.clamp(pose.x, -width / 2 + ROOM_MARGIN - e.minX, width / 2 - ROOM_MARGIN - e.maxX);
  const z = THREE.MathUtils.clamp(pose.z, BACK_Z + ROOM_MARGIN - e.minZ, frontZ - ROOM_MARGIN - e.maxZ);
  return x === pose.x && z === pose.z ? pose : { ...pose, x, z };
}

function insideRoom(pose: ItemPose, fp: Footprint, maxSeat: number): boolean {
  const c = clampPoseToRoom(pose, fp, maxSeat);
  return Math.abs(c.x - pose.x) < 1e-9 && Math.abs(c.z - pose.z) < 1e-9;
}

// ---------------------------------------------------------------------------
// Floor furniture defaults (the exact arithmetic previously inlined in Office.tsx)

export interface FurnitureLight {
  /** offset from the item origin, in the item's local frame */
  offset: [number, number, number];
  color: string;
  intensity: number;
  distance: number;
}

export interface ResolvedFurniture {
  id: string;
  url: string;
  y: number;
  scale?: [number, number, number];
  footprint: Footprint;
  /** rug is false: things sit on it */
  collides: boolean;
  /** drag-collider height (roughly the model's height) */
  handleH: number;
  light?: FurnitureLight;
  pose: ItemPose;
}

export function defaultFurniture(maxSeat: number): ResolvedFurniture[] {
  const { width, centerZ } = roomDims(maxSeat);
  const backZ = BACK_Z;
  return [
    {
      id: 'lampBack',
      handleH: 2.4,
      url: '/models/furniture/lamp_standing.gltf',
      y: 0,
      footprint: { w: 0.5, d: 0.5, cz: 0 },
      collides: true,
      light: { offset: [0, 2.4, 0.1], color: '#ffcf96', intensity: 10, distance: 9 },
      pose: { x: width / 2 - 1, z: backZ + 0.9, rotY: -Math.PI / 4 },
    },
    {
      id: 'couch2',
      handleH: 1.1,
      url: '/models/furniture/couch_pillows.gltf',
      y: 0,
      footprint: { w: 2.2, d: 1.0, cz: 0 },
      collides: true,
      pose: { x: width / 2 - 0.9, z: centerZ + 3.2, rotY: -Math.PI / 2 },
    },
    {
      id: 'lampCouch2',
      handleH: 2.4,
      url: '/models/furniture/lamp_standing.gltf',
      y: 0,
      footprint: { w: 0.5, d: 0.5, cz: 0 },
      collides: true,
      light: { offset: [0, 2.2, 0], color: '#ffcf96', intensity: 10, distance: 9 },
      pose: { x: width / 2 - 0.7, z: centerZ + 1.4, rotY: -Math.PI / 3 },
    },
    {
      id: 'cactusBig',
      handleH: 1.0,
      url: '/models/furniture/cactus_medium_A.gltf',
      y: 0,
      footprint: { w: 0.5, d: 0.5, cz: 0 },
      collides: true,
      pose: { x: -width / 2 + 0.8, z: backZ + 0.8, rotY: 0 },
    },
    {
      id: 'cactusSmall',
      handleH: 0.7,
      url: '/models/furniture/cactus_small_A.gltf',
      y: 0,
      footprint: { w: 0.4, d: 0.4, cz: 0 },
      collides: true,
      pose: { x: -width / 2 + 0.6, z: centerZ + 3, rotY: 0 },
    },
    {
      id: 'couch',
      handleH: 1.1,
      url: '/models/furniture/couch_pillows.gltf',
      y: 0,
      footprint: { w: 2.2, d: 1.0, cz: 0 },
      collides: true,
      pose: { x: -width / 2 + 0.9, z: centerZ + 0.6, rotY: Math.PI / 2 },
    },
    {
      id: 'lampCouch',
      handleH: 2.4,
      url: '/models/furniture/lamp_standing.gltf',
      y: 0,
      footprint: { w: 0.5, d: 0.5, cz: 0 },
      collides: true,
      light: { offset: [0, 2.2, 0], color: '#ffcf96', intensity: 10, distance: 9 },
      pose: { x: -width / 2 + 0.7, z: centerZ - 1.7, rotY: Math.PI / 3 },
    },
  ];
}

export function resolveFurniture(layout: OfficeLayout | undefined, maxSeat: number): ResolvedFurniture[] {
  return defaultFurniture(maxSeat).map((f) => {
    const o = layout?.furniture?.[f.id];
    if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z) || !Number.isFinite(o.rotY)) return f;
    return { ...f, pose: clampPoseToRoom({ x: o.x, z: o.z, rotY: o.rotY }, f.footprint, maxSeat) };
  });
}

// ---------------------------------------------------------------------------
// Seats

export function resolveSeat(layout: OfficeLayout | undefined, seat: number, maxSeat: number): SeatTransform {
  const def = seatTransform(seat);
  const o = layout?.seats?.[seat];
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z) || !Number.isFinite(o.rotY)) return def;
  const pose = clampPoseToRoom({ x: o.x, z: o.z, rotY: o.rotY }, deskFootprint(seat === 0), maxSeat);
  return { position: new THREE.Vector3(pose.x, 0, pose.z), rotationY: pose.rotY };
}

// ---------------------------------------------------------------------------
// Wall items (1D placement along a wall's local `ox` axis)

export type WallId = 'back' | 'left';

export interface WallItemDef {
  id: string;
  wall: WallId;
  /** half-width along the wall, including frames */
  halfW: number;
}

export const WALL_ITEMS: WallItemDef[] = [
  { id: 'windowBack', wall: 'back', halfW: 1.9 },
  { id: 'windowLeft', wall: 'left', halfW: 1.9 },
  { id: 'wallArt', wall: 'back', halfW: 1.0 },
  { id: 'pictureFrame', wall: 'back', halfW: 0.6 },
];

function wallItem(id: string): WallItemDef | undefined {
  return WALL_ITEMS.find((w) => w.id === id);
}

export function defaultWallOffset(id: string, maxSeat: number): number {
  const { width } = roomDims(maxSeat);
  switch (id) {
    case 'windowBack':
      return -width / 4;
    case 'windowLeft':
      return 4.5;
    case 'wallArt':
      return width / 4 + 0.5;
    case 'pictureFrame':
      return 0;
    default:
      return 0;
  }
}

/**
 * Vista invariant (vistaLayers.ts): no back-window parallax layer may cross the
 * left wall plane (world -width/2), with the same 0.1 margin BACK_LOCAL_WALL_X
 * bakes in. Layers ride the opening, so the opening's minimum world x follows
 * from the leftmost layer edge.
 */
export const MIN_BACK_WINDOW_OX: number = (() => {
  const { width } = roomDims(3); // width is constant across room growth
  const minLayerLeftEdge = Math.min(...VISTA_LAYERS.back.map((l) => l.x - l.w / 2));
  return -width / 2 + 0.1 - minLayerLeftEdge;
})();

/** Legal [min,max] along-wall offsets for a wall item in the current room. */
export function wallOffsetRange(id: string, maxSeat: number): [number, number] {
  const def = wallItem(id);
  const { width, depth } = roomDims(maxSeat);
  const span = (def?.wall === 'left' ? depth : width) / 2;
  let min = -span + (def?.halfW ?? 0) + WALL_END_MARGIN;
  const max = span - (def?.halfW ?? 0) - WALL_END_MARGIN;
  if (id === 'windowBack') min = Math.max(min, MIN_BACK_WINDOW_OX);
  if (id === 'windowLeft') {
    // conservative: the left vista's layers are centered, keep them well off both wall ends
    return [-span + 2.5, span - 2.5];
  }
  return [min, max];
}

export function resolveWallOffset(layout: OfficeLayout | undefined, id: string, maxSeat: number): number {
  const o = layout?.wallItems?.[id];
  const [min, max] = wallOffsetRange(id, maxSeat);
  if (typeof o !== 'number' || !Number.isFinite(o)) {
    return defaultWallOffset(id, maxSeat);
  }
  return THREE.MathUtils.clamp(o, min, max);
}

/** Range check + 1D interval overlap against the other items on the same wall. */
export function isWallPlacementValid(
  layout: OfficeLayout | undefined,
  id: string,
  offset: number,
  maxSeat: number,
): boolean {
  const def = wallItem(id);
  if (!def) return false;
  const [min, max] = wallOffsetRange(id, maxSeat);
  if (offset < min - 1e-9 || offset > max + 1e-9) return false;
  for (const other of WALL_ITEMS) {
    if (other.id === id || other.wall !== def.wall) continue;
    const otherOx = resolveWallOffset(layout, other.id, maxSeat);
    if (Math.abs(offset - otherOx) < def.halfW + other.halfW) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Placement validity for floor items

export interface MovingItem {
  kind: 'seat' | 'furniture';
  /** seat number or furniture id */
  key: number | string;
  pose: ItemPose;
}

/**
 * Can `moving` be dropped at its pose? Checks room bounds and OBB collision
 * against every other desk (occupied seats incl. the boss) and every colliding
 * furniture item. The moving item itself is excluded; the rug never collides.
 */
export function isPlacementValid(
  layout: OfficeLayout | undefined,
  moving: MovingItem,
  occupiedSeats: number[],
  maxSeat: number,
): boolean {
  const movingFp =
    moving.kind === 'seat'
      ? deskFootprint(moving.key === 0)
      : defaultFurniture(maxSeat).find((f) => f.id === moving.key)?.footprint ?? { w: 0.5, d: 0.5, cz: 0 };
  if (!insideRoom(moving.pose, movingFp, maxSeat)) return false;
  if (moving.kind === 'furniture') {
    const def = defaultFurniture(maxSeat).find((f) => f.id === moving.key);
    if (def && !def.collides) return true; // non-colliding items: bounds check only
  }
  const movingObb = obbFromPose(moving.pose, movingFp);
  for (const seat of occupiedSeats) {
    if (moving.kind === 'seat' && moving.key === seat) continue;
    const { position, rotationY } = resolveSeat(layout, seat, maxSeat);
    const obb = obbFromPose({ x: position.x, z: position.z, rotY: rotationY }, deskFootprint(seat === 0));
    if (obbIntersects(movingObb, obb)) return false;
  }
  for (const f of resolveFurniture(layout, maxSeat)) {
    if (!f.collides) continue;
    if (moving.kind === 'furniture' && moving.key === f.id) continue;
    if (obbIntersects(movingObb, obbFromPose(f.pose, f.footprint))) return false;
  }
  return true;
}
