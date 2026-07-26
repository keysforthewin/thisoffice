import * as THREE from 'three';
import { roomDims, ROOM_HEIGHT } from '../scene/layout.ts';

/** Head-and-shoulders framing, without the wide-angle nose. */
const PHOTO_FOV = 45;
/** How many head-heights of frame the shot tries to fill. */
const HEADS_IN_FRAME = 2.2;
/** Closest the lens ever gets, however small the head. */
const MIN_STANDOFF = 1.3;
/**
 * Furthest the lens may back off from a character *at a desk*.
 *
 * A seated character faces their own monitor: it stands 1.15 u in front of them
 * (desk-local z 0.35, a 1.35 × 0.85 panel at eye height), so past ~1.45 u the
 * camera is behind the screen and the portrait becomes a photo of the back of
 * one. The only head-on shot of a seated character that exists is the one taken
 * from the gap between their face and their monitor, so the framing gives way
 * here rather than the angle.
 */
const MAX_SEATED_STANDOFF = 1.45;
/** Standing characters (Kat Person) have the whole room, so a big head can be fitted. */
const MAX_STANDOFF = 3;
/** Eye-line lift: a hair above the face, so the shot isn't up the subject's nose. */
const CAMERA_LIFT = 0.1;
/** Keep the camera off the walls even in the smallest room. */
const WALL_MARGIN = 0.5;

/**
 * A head-on portrait of the winner: the lens is planted directly in front of
 * the face, on the character's own facing axis, aimed at their head.
 *
 * `facingY` is the character's world Y-rotation — characters are rendered
 * looking down their local +z, so the camera goes at `face + forward *
 * standoff` and looks back. `face` is the real, measured face (see facePoint),
 * not a seat centre: seated poses lean, characters differ in height by half a
 * unit, and a fixed eye height would frame a chest as readily as a face.
 *
 * Deterministic, and clamped so the camera never ends up inside a wall — a
 * clamped shot loses the head-on angle but keeps the head in frame, since the
 * look-at is the face either way.
 */
export function photoShot(
  face: THREE.Vector3,
  facingY: number,
  maxSeat: number,
  { headSize = 0.3, seated = true }: { headSize?: number; seated?: boolean } = {},
): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
  const { width, depth, centerZ } = roomDims(maxSeat);
  const halfW = width / 2 - WALL_MARGIN;
  const frontZ = centerZ + depth / 2 - WALL_MARGIN;
  const backZ = centerZ - depth / 2 + WALL_MARGIN;

  // distance at which `HEADS_IN_FRAME` heads fill the frame vertically
  const fit = (headSize * HEADS_IN_FRAME) / 2 / Math.tan((PHOTO_FOV * Math.PI) / 360);
  const standoff = THREE.MathUtils.clamp(fit, MIN_STANDOFF, seated ? MAX_SEATED_STANDOFF : MAX_STANDOFF);

  const forward = new THREE.Vector3(Math.sin(facingY), 0, Math.cos(facingY));
  const position = new THREE.Vector3(
    THREE.MathUtils.clamp(face.x + forward.x * standoff, -halfW, halfW),
    THREE.MathUtils.clamp(face.y + CAMERA_LIFT, 0.6, ROOM_HEIGHT - 0.3),
    THREE.MathUtils.clamp(face.z + forward.z * standoff, backZ, frontZ),
  );
  return { position, lookAt: face.clone(), fov: PHOTO_FOV };
}
