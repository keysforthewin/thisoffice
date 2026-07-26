import * as THREE from 'three';
import { roomDims, ROOM_HEIGHT } from '../scene/layout.ts';

/** Eye height of the shot: chest-high on a ~2.3-unit character, so faces read. */
const CAMERA_Y = 1.9;
/** What the lens is pointed at, slightly above the desk tops (y=1.0). */
const LOOK_Y = 1.4;
/** Back far enough that neighbours land in frame behind the winner. */
const STANDOFF = 5.2;
/** Wide enough for a group shot without fisheye. */
const PHOTO_FOV = 46;
/**
 * The look-at is nudged sideways from the subject, which pushes the winner off
 * centre — they stay the subject, but the frame is a group photo, not a mugshot.
 */
const OFFSET = 1.15;
/** Keep the camera off the walls even in the smallest room. */
const WALL_MARGIN = 0.8;

/**
 * A "live picture" of the winner: shot from in front of and slightly to the side
 * of them, low enough to catch faces, wide enough that whoever else is nearby
 * ends up in it too. Deterministic, so the same winner always gets the same
 * composition, and clamped so the camera never ends up behind a wall.
 */
export function photoShot(
  subject: THREE.Vector3,
  maxSeat: number,
): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
  const { width, depth, centerZ } = roomDims(maxSeat);
  const halfW = width / 2 - WALL_MARGIN;
  const frontZ = centerZ + depth / 2 - WALL_MARGIN;
  const backZ = centerZ - depth / 2 + WALL_MARGIN;

  // stand on the room-centre side of the subject, so the shot looks back across the office
  const towardCentre = Math.sign(centerZ - subject.z) || 1;
  const position = new THREE.Vector3(
    THREE.MathUtils.clamp(subject.x + OFFSET * 1.6, -halfW, halfW),
    THREE.MathUtils.clamp(CAMERA_Y, 0.6, ROOM_HEIGHT - 0.5),
    THREE.MathUtils.clamp(subject.z + towardCentre * STANDOFF, backZ, frontZ),
  );
  const lookAt = new THREE.Vector3(
    THREE.MathUtils.clamp(subject.x - OFFSET, -halfW, halfW),
    LOOK_Y,
    subject.z,
  );
  return { position, lookAt, fov: PHOTO_FOV };
}
