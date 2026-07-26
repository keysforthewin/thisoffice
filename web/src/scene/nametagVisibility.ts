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

// Sample grid over the quad: center first, then edge midpoints, then corners.
// Order matters for cost, not correctness: the check is all-or-nothing, so an
// occluded tag exits on its first blocked sample — and anything large enough to
// hide a tag almost always covers the center, so testing it first turns the
// common failing case into one ray instead of up to nine.
const OFFSETS: Array<[number, number]> = [
  [0, 0],
  [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0],
  [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5],
];

/** Reused across calls — see the scratch-array warning on tagSamplePoints. */
const _points = OFFSETS.map(() => new THREE.Vector3());

/** End rays just short of the tag plane so the tag never occludes itself. */
const FAR_EPS = 1e-3;

/**
 * World-space sample points of a sprite quad centered at `center`, sized
 * width×height, billboarded to the camera orientation `camQuat` (sprites
 * align to the camera's view plane: right/up are the camera's right/up).
 *
 * SCRATCH: the returned array and its vectors are module-level and are
 * overwritten by the next call. Read them before calling again; never retain
 * them. This runs for every nametag on every occlusion tick, so allocating
 * nine Vector3s per call showed up as real GC pressure.
 */
export function tagSamplePoints(
  center: THREE.Vector3,
  camQuat: THREE.Quaternion,
  width: number,
  height: number
): THREE.Vector3[] {
  const right = _right.set(1, 0, 0).applyQuaternion(camQuat);
  const up = _up.set(0, 1, 0).applyQuaternion(camQuat);
  for (let i = 0; i < OFFSETS.length; i++) {
    const [sx, sy] = OFFSETS[i];
    _points[i]
      .copy(center)
      .addScaledVector(right, sx * width)
      .addScaledVector(up, sy * height);
  }
  return _points;
}

/**
 * Flat list of everything that can block a tag, refreshed on a timer.
 *
 * Raycasting the scene root recursively re-walks the whole graph — including
 * every bone of every skeleton — for each of the nine samples of each tag.
 * Collecting the candidate meshes once and raycasting the flat array instead
 * makes that walk shared and non-recursive: skeletons are visited once per
 * refresh rather than 9 × (number of tags) times per frame.
 *
 * Cached per scene and rebuilt every REFRESH_MS; the office only gains or loses
 * geometry when someone is hired, evicted, or drags furniture in build mode, and
 * a tag flickering for a fraction of a second in those cases is not worth
 * plumbing invalidation through the whole scene tree.
 */
const OCCLUDER_REFRESH_MS = 500;
let _occluders: THREE.Object3D[] = [];
let _occluderScene: THREE.Object3D | null = null;
let _occludersAt = -Infinity;

function occludersOf(scene: THREE.Object3D, now: number): THREE.Object3D[] {
  if (scene === _occluderScene && now - _occludersAt < OCCLUDER_REFRESH_MS) return _occluders;
  const list: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    // NO_RAYCAST covers characters and the tags themselves; sprites and lights
    // have nothing to intersect. Invisible meshes stay — the person colliders
    // are visible=false on purpose (see Person.tsx).
    if (!(obj as THREE.Mesh).isMesh) return;
    if (obj.raycast === NO_RAYCAST) return;
    list.push(obj);
  });
  _occluders = list;
  _occluderScene = scene;
  _occludersAt = now;
  return list;
}

/** Drop the occluder cache — for tests, and whenever a scene is torn down. */
export function resetOccluderCache(): void {
  _occluders = [];
  _occluderScene = null;
  _occludersAt = -Infinity;
}

/**
 * True only when no raycastable geometry blocks any sample point of the tag.
 * `ignore` exempts specific objects — the tag owner's body collider — so a
 * tag still shows through its own avatar but not through anyone else's.
 *
 * `now` (epoch ms) drives the occluder cache; callers in the render loop should
 * pass the frame's clock. Omitting it forces a fresh scene walk, which is what
 * tests want.
 */
export function isTagFullyVisible(
  scene: THREE.Object3D,
  camPos: THREE.Vector3,
  camQuat: THREE.Quaternion,
  center: THREE.Vector3,
  width: number,
  height: number,
  ignore?: (obj: THREE.Object3D) => boolean,
  now?: number
): boolean {
  if (now === undefined) resetOccluderCache();
  const targets = occludersOf(scene, now ?? 0);
  for (const point of tagSamplePoints(center, camQuat, width, height)) {
    const dist = _dir.subVectors(point, camPos).length();
    if (dist < FAR_EPS) continue;
    _raycaster.set(camPos, _dir.divideScalar(dist));
    _raycaster.near = 0;
    _raycaster.far = dist - FAR_EPS;
    const hits = _raycaster.intersectObjects(targets, false);
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

/**
 * How far a character's skull rises above its head bone, measured in the bind
 * pose: skinned silhouette top minus the head bone's bind height. Callers add
 * this to the *animated* head bone each frame, so the tag tracks a seated
 * character's head instead of floating at standing height.
 *
 * Skinned meshes only. KayKit GLBs parent their weapon set (swords, shields,
 * helmet, cape) to bones as unskinned meshes whose geometry bounds live in
 * bone-local space — 2H_Sword reads max.y 1.96 in its own frame, which is not
 * comparable to model space. Skinned geometry is authored in skeleton space, so
 * it is the only thing measurable against the head bone's bind height.
 *
 * The result is in `root`-local units, NOT skin units. Mixamo GLBs author
 * geometry in centimetres and shrink it back with a ~0.01 scale on the armature
 * node, so a raw skin-space subtraction returns ~60 where the caller expects
 * ~0.6 — that is what put tags through the ceiling. Each mesh's measurements are
 * therefore multiplied by the scale accumulated from the mesh up to (excluding)
 * `root`, which is 1 for KayKit and ~0.01 for Mixamo.
 *
 * Returns null when the model has no skinned geometry or the head bone is not in
 * the skeleton; callers fall back to a fixed allowance.
 */
export function crownOffset(root: THREE.Object3D, headBone: THREE.Object3D | null): number | null {
  if (!headBone) return null;
  let top = -Infinity;
  let bindY: number | null = null;
  const tmp = new THREE.Matrix4();
  root.traverse((obj) => {
    const m = obj as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    // skin space → root space; `root.scale` itself is excluded because the caller
    // multiplies by it (the primitive carries the catalog scale).
    let unit = 1;
    for (let n: THREE.Object3D | null = m; n && n !== root; n = n.parent) unit *= n.scale.y;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox) top = Math.max(top, m.geometry.boundingBox.max.y * unit);
    if (bindY === null && m.skeleton) {
      const i = m.skeleton.bones.indexOf(headBone as THREE.Bone);
      if (i >= 0) bindY = tmp.copy(m.skeleton.boneInverses[i]).invert().elements[13] * unit;
    }
  });
  if (!Number.isFinite(top) || bindY === null) return null;
  return Math.max(0, top - bindY);
}
