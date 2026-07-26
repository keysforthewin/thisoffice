import * as THREE from 'three';

/**
 * Seat 0 = boss, at the back wall facing the room (+z).
 * Employee seats 1..n fill a classroom grid facing the boss (-z).
 */

export const COLS = 3;
const COL_SPACING = 3.4;
const ROW_SPACING = 3.6;
const FIRST_ROW_Z = 0.6;
export const BOSS_Z = -4.6;
export const ROOM_HEIGHT = 7.5;

export interface SeatTransform {
  position: THREE.Vector3;
  /** rotation around Y of the whole desk group; desk faces +z at rotation 0 */
  rotationY: number;
}

export function seatTransform(seat: number): SeatTransform {
  if (seat === 0) {
    return { position: new THREE.Vector3(0, 0, BOSS_Z), rotationY: 0 };
  }
  const i = seat - 1;
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = (col - (COLS - 1) / 2) * COL_SPACING;
  const z = FIRST_ROW_Z + row * ROW_SPACING;
  return { position: new THREE.Vector3(x, 0, z), rotationY: Math.PI };
}

export const BACK_Z = BOSS_Z - 3.8;

/**
 * Where the two right-wall boards hang by default, in world z. Build mode moves
 * them along the wall, and a wall item's saved offset is measured from the
 * room's centre (`ox`, see buildLayout.ts) — the room grows forward, so an
 * offset that stayed put in world space would drift as seats are added. These
 * absolute z values are the anchor `defaultBoardOx` converts from.
 */
export const BOARD_DEFAULT_Z = { todoBoard: -1.2, statusBoard: -5.6 } as const;
export type BoardId = keyof typeof BOARD_DEFAULT_Z;

/** Default along-wall offset (world z = centerZ + ox) for a right-wall board. */
export function defaultBoardOx(id: BoardId, maxSeat: number): number {
  return BOARD_DEFAULT_Z[id] - roomDims(maxSeat).centerZ;
}

/*
 * There is deliberately no boardTransform/whiteboardTransform here any more.
 * Both boards are wall items now and can hang on any wall at any height, so
 * anything that needs one asks `resolveWallItem` + `wallToWorld` (walls.ts).
 * A transform that baked in the right wall would silently keep aiming at where
 * a board used to be.
 */

export function roomDims(maxSeat: number) {
  const rows = Math.max(1, Math.ceil(Math.max(0, maxSeat) / COLS));
  const frontZ = FIRST_ROW_Z + rows * ROW_SPACING + 2.4;
  const depth = frontZ - BACK_Z;
  const width = COLS * COL_SPACING + 5;
  const centerZ = (frontZ + BACK_Z) / 2;
  return { width, depth, centerZ, height: ROOM_HEIGHT };
}
