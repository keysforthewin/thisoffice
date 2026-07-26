import * as THREE from 'three';
import { WALL_SIDES, type ItemPose, type OfficeLayout, type WallPlacement, type WallSide } from '../../../shared/types.ts';
import { BACK_Z, defaultBoardOx, roomDims, seatTransform, type BoardId, type SeatTransform } from './layout.ts';
import { VISTA_LAYERS } from './vistaLayers.ts';
import { wallFrame, wallHeightRange } from './walls.ts';

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
  /** render as an animated catalog character (looping `clip`) instead of a static GLB */
  character?: { variant: string; name: string; clip: string };
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
      // The office cat: a mascot who stands in the back-left corner playing the
      // shared Idle clip. She is the same rigged catalog GLB employees can wear,
      // so `url` is unused — `character` routes her through <Person> for the
      // animation and name tag. rotY turns her in off the corner to face the room.
      id: 'catPerson',
      handleH: 2.5,
      url: '/models/characters/CatPerson.glb',
      character: { variant: 'CatPerson', name: 'Kat Person', clip: 'Idle' },
      y: 0,
      footprint: { w: 1.3, d: 0.9, cz: -0.2 },
      collides: true,
      pose: { x: -width / 2 + 1.05, z: backZ + 1.05, rotY: Math.PI / 6 },
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

/**
 * `katPerson: false` takes the office cat out of the room — of the render, of
 * collision, and of the quiz bubble's anchor lookup — while her saved position
 * stays in the layout, so switching her back on returns her to the same corner.
 */
export function resolveFurniture(
  layout: OfficeLayout | undefined,
  maxSeat: number,
  katPerson = true,
): ResolvedFurniture[] {
  return defaultFurniture(maxSeat)
    .filter((f) => katPerson || f.id !== 'catPerson')
    .map((f) => {
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
// Wall items: which wall, how far along it (`ox`), how high (`oy`)

export interface WallItemDef {
  id: string;
  /** the wall it hangs on out of the box; build mode can move it to any of them */
  wall: WallSide;
  /** half-width along the wall, including frames */
  halfW: number;
  /** half-height, including frames — items only collide where they overlap in BOTH axes */
  halfH: number;
  /** default height above the floor, in world units */
  oy: number;
  /**
   * Windows are openings cut into the wall, not things hung on it: the wall
   * mesh is built around them and they carry a parallax vista and a light
   * spill. They move like anything else, but the wall they land on has to
   * render differently, so the renderer needs to tell them apart.
   */
  window?: boolean;
}

export const WALL_ITEMS: WallItemDef[] = [
  { id: 'windowBack', wall: 'back', halfW: 1.9, halfH: 1.05, oy: 2.1, window: true },
  { id: 'windowLeft', wall: 'left', halfW: 1.9, halfH: 1.05, oy: 2.1, window: true },
  { id: 'wallArt', wall: 'back', halfW: 1.0, halfH: 0.85, oy: 2.15 },
  { id: 'tv', wall: 'left', halfW: 1.5, halfH: 0.9, oy: 2.2 },
  { id: 'eotm', wall: 'back', halfW: 0.8, halfH: 0.65, oy: 2.15 },
  // the two right-wall boards: the frame is 3.4 wide, so they touch at 3.4 apart
  { id: 'todoBoard', wall: 'right', halfW: 1.7, halfH: 1.075, oy: 2.0 },
  { id: 'statusBoard', wall: 'right', halfW: 1.7, halfH: 1.075, oy: 2.0 },
];

export function wallItem(id: string): WallItemDef | undefined {
  return WALL_ITEMS.find((w) => w.id === id);
}

export function defaultWallOffset(id: string, maxSeat: number): number {
  const { width } = roomDims(maxSeat);
  switch (id) {
    case 'windowBack':
      return -width / 4;
    case 'windowLeft':
      // was 4.5: at minimum room size that overlapped the TV's corner, so 1.5
      // keeps window and TV non-colliding at every room size.
      return 1.5;
    case 'wallArt':
      return width / 4 + 0.5;
    case 'eotm':
      // dead centre of the back wall, directly behind the boss. windowBack sits at
      // -width/4 and wallArt at width/4 + 0.5, so 0 clears both half-widths at every
      // room size (width is constant as the room grows).
      return 0;
    case 'tv':
      // Left-wall `ox` maps to world z = centerZ - ox, so a SMALLER ox sits further
      // forward (nearer the employees). 5.0 is the furthest forward the TV can go:
      // windowLeft is pinned at 1.5 and the two half-widths sum to 3.4, so anything
      // below 4.9 overlaps the window. Unlike the old room-relative offset this is
      // constant, so the TV slides toward the employees as the room grows.
      return 5.0;
    case 'todoBoard':
    case 'statusBoard':
      // right wall: ox is measured forward from centerZ, so these convert the
      // boards' historical fixed world z (layout.ts owns the anchor)
      return defaultBoardOx(id, maxSeat);
    default:
      return 0;
  }
}

/** The margin the vista invariant keeps between a layer edge and the wall's end. */
const VISTA_MARGIN = 0.1;

/**
 * Vista invariant (vistaLayers.ts): no parallax layer of the *back* window may
 * cross the wall's end, where it would be visible edge-on through another
 * window. Derived from that set's leftmost layer edge.
 */
export const MIN_BACK_WINDOW_OX: number = (() => {
  const { width } = roomDims(3); // width is constant across room growth
  const leftmost = Math.min(...VISTA_LAYERS.back.map((l) => l.x - l.w / 2));
  return -width / 2 + VISTA_MARGIN - leftmost;
})();

/**
 * How much of a wall's end a window must keep clear, beyond its own half-width.
 *
 * A window's parallax layers are far wider than its opening — the `back` set
 * spans ~24 units against a 15.2-unit wall — so "no layer may cross the wall's
 * end" is satisfiable on one side at best. These are the two rules the fixed
 * windows always had, now applied on whichever wall the window hangs on:
 * `windowBack`'s layers are pushed to one side, so it holds that side
 * explicitly; `windowLeft`'s are centred, so it just stays well off both ends.
 *
 * The cost is the leak the design accepts: two windows on adjacent walls at
 * extreme offsets can catch a glimpse of each other's city. Closing it properly
 * means authoring a vista set per wall, which is art, not code.
 */
function vistaInset(id: string): { min?: number; ends?: number } {
  if (id === 'windowBack') {
    const leftmost = Math.min(...VISTA_LAYERS.back.map((l) => l.x - l.w / 2));
    return { min: VISTA_MARGIN - leftmost };
  }
  if (id === 'windowLeft') return { ends: 2.5 };
  return {};
}

/** Legal [min,max] along-wall offsets for an item on a given wall in the current room. */
export function wallOffsetRange(id: string, wall: WallSide, maxSeat: number): [number, number] {
  const def = wallItem(id);
  const span = wallFrame(wall, maxSeat).span / 2;
  const halfW = def?.halfW ?? 0;
  const inset = vistaInset(id);
  if (inset.ends !== undefined) return [-span + inset.ends, span - inset.ends];
  let min = -span + halfW + WALL_END_MARGIN;
  const max = span - halfW - WALL_END_MARGIN;
  if (inset.min !== undefined) min = Math.max(min, -span + inset.min);
  return min <= max ? [min, max] : [min, min];
}

/** Legal [min,max] heights for an item, clear of the floor and ceiling. */
export function wallItemHeightRange(id: string): [number, number] {
  return wallHeightRange(wallItem(id)?.halfH ?? 0);
}

/** The placement an item takes with nothing saved for it. */
export function defaultWallPlacement(id: string, maxSeat: number): WallPlacement {
  const def = wallItem(id);
  const wall = def?.wall ?? 'back';
  return { wall, ox: defaultWallOffset(id, maxSeat), oy: def?.oy ?? 2.1 };
}

/**
 * The saved placement of a wall item, clamped into the current room.
 *
 * A bare number is the legacy shape — an along-wall offset on the item's
 * original wall, from before walls became movable — so an office saved then
 * still hangs everything where it was.
 */
export function resolveWallItem(layout: OfficeLayout | undefined, id: string, maxSeat: number): WallPlacement {
  const saved = layout?.wallItems?.[id];
  const def = defaultWallPlacement(id, maxSeat);
  let wall = def.wall;
  let ox = def.ox;
  let oy = def.oy;
  if (typeof saved === 'number') {
    if (Number.isFinite(saved)) ox = saved;
  } else if (saved && typeof saved === 'object') {
    if (WALL_SIDES.includes(saved.wall)) wall = saved.wall;
    if (Number.isFinite(saved.ox)) ox = saved.ox;
    if (Number.isFinite(saved.oy)) oy = saved.oy;
  }
  const [minX, maxX] = wallOffsetRange(id, wall, maxSeat);
  const [minY, maxY] = wallItemHeightRange(id);
  return { wall, ox: THREE.MathUtils.clamp(ox, minX, maxX), oy: THREE.MathUtils.clamp(oy, minY, maxY) };
}

/** Back-compat shim for callers that only care where along its wall an item sits. */
export function resolveWallOffset(layout: OfficeLayout | undefined, id: string, maxSeat: number): number {
  return resolveWallItem(layout, id, maxSeat).ox;
}

/**
 * Range check plus 2D overlap against the other items on the same wall.
 *
 * Two items clash only when they overlap along the wall AND in height, so a
 * board can hang above another rather than the wall filling up in one
 * dimension. Items on *adjacent* walls are not checked against each other: they
 * meet at a right angle at the corner, and a hanging is a few centimetres deep.
 */
export function isWallPlacementValid(
  layout: OfficeLayout | undefined,
  id: string,
  placement: WallPlacement,
  maxSeat: number,
): boolean {
  const def = wallItem(id);
  if (!def) return false;
  const [minX, maxX] = wallOffsetRange(id, placement.wall, maxSeat);
  if (placement.ox < minX - 1e-9 || placement.ox > maxX + 1e-9) return false;
  const [minY, maxY] = wallItemHeightRange(id);
  if (placement.oy < minY - 1e-9 || placement.oy > maxY + 1e-9) return false;
  for (const other of WALL_ITEMS) {
    if (other.id === id) continue;
    const o = resolveWallItem(layout, other.id, maxSeat);
    if (o.wall !== placement.wall) continue;
    const apart = Math.abs(placement.ox - o.ox) >= def.halfW + other.halfW;
    const clear = Math.abs(placement.oy - o.oy) >= def.halfH + other.halfH;
    if (!apart && !clear) return false;
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
  katPerson = true,
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
  for (const f of resolveFurniture(layout, maxSeat, katPerson)) {
    if (!f.collides) continue;
    if (moving.kind === 'furniture' && moving.key === f.id) continue;
    if (obbIntersects(movingObb, obbFromPose(f.pose, f.footprint))) return false;
  }
  return true;
}
