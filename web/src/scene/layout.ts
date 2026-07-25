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

/** Whiteboard hangs on the right wall near the boss end of the room. */
export function whiteboardTransform(maxSeat: number) {
  const { width } = roomDims(maxSeat);
  return {
    position: new THREE.Vector3(width / 2 - 0.06, 2.0, -1.2),
    rotationY: -Math.PI / 2,
    // camera spot: back a few units along -x, at board height
    camera: new THREE.Vector3(width / 2 - 4.2, 2.0, -1.2),
    lookAt: new THREE.Vector3(width / 2, 2.0, -1.2),
  };
}

export function roomDims(maxSeat: number) {
  const rows = Math.max(1, Math.ceil(Math.max(0, maxSeat) / COLS));
  const frontZ = FIRST_ROW_Z + rows * ROW_SPACING + 2.4;
  const depth = frontZ - BACK_Z;
  const width = COLS * COL_SPACING + 5;
  const centerZ = (frontZ + BACK_Z) / 2;
  return { width, depth, centerZ, height: ROOM_HEIGHT };
}
