import * as THREE from 'three';

/**
 * All-or-nothing nametag occlusion: a tag renders only when every sample point
 * on its camera-facing quad has a clear line from the camera. Characters opt
 * out of raycasting (NO_RAYCAST in Person.tsx), so they never block a tag —
 * tags draw depth-test-off and show through them; everything else that
 * raycasts (walls, desks, monitors, whiteboard, furniture) hides the tag
 * entirely if it clips any part of it.
 */

/** Assign to `object.raycast` to exclude it from tag occlusion (and all raycasts). */
export const NO_RAYCAST = () => {};

const _raycaster = new THREE.Raycaster();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();

// Sample grid over the quad: corners, edge midpoints, center.
const OFFSETS: Array<[number, number]> = [
  [-0.5, -0.5], [0, -0.5], [0.5, -0.5],
  [-0.5, 0], [0, 0], [0.5, 0],
  [-0.5, 0.5], [0, 0.5], [0.5, 0.5],
];

/** End rays just short of the tag plane so the tag never occludes itself. */
const FAR_EPS = 1e-3;

/**
 * World-space sample points of a sprite quad centered at `center`, sized
 * width×height, billboarded to the camera orientation `camQuat` (sprites
 * align to the camera's view plane: right/up are the camera's right/up).
 */
export function tagSamplePoints(
  center: THREE.Vector3,
  camQuat: THREE.Quaternion,
  width: number,
  height: number
): THREE.Vector3[] {
  const right = _right.set(1, 0, 0).applyQuaternion(camQuat);
  const up = _up.set(0, 1, 0).applyQuaternion(camQuat);
  return OFFSETS.map(([sx, sy]) =>
    center
      .clone()
      .addScaledVector(right, sx * width)
      .addScaledVector(up, sy * height)
  );
}

/**
 * True only when no raycastable geometry blocks any sample point of the tag.
 * `ignore` exempts specific objects — the tag owner's body collider — so a
 * tag still shows through its own avatar but not through anyone else's.
 */
export function isTagFullyVisible(
  scene: THREE.Object3D,
  camPos: THREE.Vector3,
  camQuat: THREE.Quaternion,
  center: THREE.Vector3,
  width: number,
  height: number,
  ignore?: (obj: THREE.Object3D) => boolean
): boolean {
  for (const point of tagSamplePoints(center, camQuat, width, height)) {
    const dist = _dir.subVectors(point, camPos).length();
    if (dist < FAR_EPS) continue;
    _raycaster.set(camPos, _dir.divideScalar(dist));
    _raycaster.near = 0;
    _raycaster.far = dist - FAR_EPS;
    const hits = _raycaster.intersectObject(scene, true);
    if (ignore ? hits.some((h) => !ignore(h.object)) : hits.length > 0) return false;
  }
  return true;
}

/**
 * The bone to hang a nametag over: the highest-sitting bone whose name
 * contains "head" (crown bones like HeadTop_End win over the head pivot).
 * Works for KayKit ("head") and Mixamo ("mixamorigHead") rigs alike.
 */
export function findHeadBone(root: THREE.Object3D): THREE.Object3D | null {
  root.updateMatrixWorld(true);
  let best: THREE.Object3D | null = null;
  let bestY = -Infinity;
  const world = new THREE.Vector3();
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone || !/head/i.test(obj.name)) return;
    const y = obj.getWorldPosition(world).y;
    if (y > bestY) {
      bestY = y;
      best = obj;
    }
  });
  return best;
}
