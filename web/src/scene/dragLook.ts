import type { CameraMode } from '../store.ts';

/** rad per px of mouse movement — shared by the pointer-locked and right-drag paths */
export const LOOK_SENSITIVITY = 0.0022;
export const MAX_PITCH = Math.PI / 2 - 0.01;
/**
 * Pointer lock can emit one giant bogus delta when the hidden OS cursor warps
 * (WSLg/Wayland screen edge, or right after acquiring the lock). A real flick
 * coalesced at ~60Hz stays around 100px/event, so anything past this is noise.
 */
export const MAX_LOOK_DELTA = 200;

/** Yaw/pitch are the source of truth while aiming; deriving them back from the
 *  quaternion every event is unstable near straight up/down (yaw snaps). */
export interface Look {
  yaw: number;
  pitch: number;
}

export function applyLook(look: Look, movementX: number, movementY: number): Look {
  const pitch = look.pitch - movementY * LOOK_SENSITIVITY;
  return {
    yaw: look.yaw - movementX * LOOK_SENSITIVITY,
    pitch: Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch)),
  };
}

/**
 * Right-drag aims the camera by hand, so every mode that drives the camera to a
 * computed pose has to yield first — a pov/focus lerp or a movie shot would
 * otherwise fight the drag frame for frame. Returns the mode to switch to, or
 * null when the camera is already the user's to aim.
 */
export function modeForDragLook(cur: CameraMode): CameraMode | null {
  return cur.kind === 'free' ? null : { kind: 'free' };
}
