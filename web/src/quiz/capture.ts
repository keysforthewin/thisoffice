import type * as THREE from 'three';

/** Camera fly-in and the beat it holds before the shutter. */
export const PHOTO_FLY_MS = 1200;
export const PHOTO_HOLD_MS = 400;
/**
 * How long the camera stays on the winner's face after the shutter. The photo
 * is taken in the first second and a half of a shot that runs for twelve: the
 * point of flying over there is that the room sees who won, and a cut back the
 * instant the file uploads is over before anyone has looked up.
 */
export const PHOTO_LINGER_MS = 10_000;

/**
 * Read the scene out of the WebGL canvas.
 *
 * The render and the read MUST happen in the same tick: the drawing buffer is
 * cleared after a normal frame, so `toDataURL` on its own returns a blank image.
 * The alternative — `preserveDrawingBuffer: true` on the Canvas — taxes every
 * frame forever for one screenshot per game, so it stays off.
 */
export async function captureCanvas(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<Blob> {
  gl.render(scene, camera);
  const dataUrl = gl.domElement.toDataURL('image/png');
  const res = await fetch(dataUrl);
  return res.blob();
}
