import * as THREE from 'three';

/** How far from the anchor a head bone may be and still be "this character's". */
const MAX_ANCHOR_DIST = 1.6;
/**
 * Radius around the head bone within which a skinned mesh counts as part of the
 * same character. Desks are 3.4 u apart, so this cannot reach a neighbour, and
 * it deliberately does not go through the skeleton: a Mixamo import arrives as
 * several meshes on several *cloned* skeletons (Body, Hair, Eyes…), and taking
 * only the one the head bone belongs to would measure a character by its
 * eyelashes.
 */
const CLUSTER_R = 1.2;
/**
 * Head bone → face centre, as a fraction of the gap up to the silhouette top,
 * clamped. A quarter rather than a half because the silhouette is not the skull:
 * hats and hair are the difference between "eyes in the middle of the frame" and
 * "a portrait of a hat" (the office's straw-hatted characters carry 0.7 u of hat
 * above the head bone). The clamp floor covers the opposite case — a bare human
 * head, where the whole gap is barely a tenth of a unit.
 */
const SKULL_FRACTION = 0.25;
const MAX_LIFT = 0.3;
const MIN_LIFT = 0.08;

export interface FacePoint {
  /** World position to aim at. */
  point: THREE.Vector3;
  /**
   * Roughly how tall the head is, in world units — everything the character
   * carries above the head bone. Framing scales with it: the office runs from
   * bare human skulls (~0.2) to the chibi cat's 1.2 u head, and one fixed
   * distance either crops her ears or shoots a human from across the desk.
   */
  size: number;
}

/**
 * Where a character's face is, in world space — the point the winner's photo
 * aims at, and how big a subject it is.
 *
 * Measured off the live scene rather than computed from the seat, because
 * neither number is knowable up front: the head bone is wherever the *animated*
 * sit pose put it (measured range across the shipped catalog: y 1.51–2.11 at
 * the same desk), and the face sits somewhere above that bone by an amount that
 * is a rounding error on a human rig and half a unit on the cat. So the bone
 * gives the position and the character's own silhouette gives the head height.
 *
 * Returns null when no head bone is near the anchor — an evicted character, or
 * one whose GLB has no bone matching. The caller falls back to a fixed height.
 */
export function facePoint(scene: THREE.Object3D, x: number, z: number): FacePoint | null {
  scene.updateMatrixWorld(true);

  const bones: THREE.Vector3[] = [];
  const meshes: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      if (/^head$/i.test(obj.name)) bones.push(obj.getWorldPosition(new THREE.Vector3()));
      return;
    }
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(obj);
  });

  let best: THREE.Vector3 | null = null;
  let bestDist = MAX_ANCHOR_DIST;
  for (const world of bones) {
    const d = Math.hypot(world.x - x, world.z - z);
    if (d < bestDist) {
      bestDist = d;
      best = world;
    }
  }
  if (!best) return null;

  // silhouette top of every mesh standing where this head bone is
  const box = new THREE.Box3();
  const centre = new THREE.Vector3();
  let top = -Infinity;
  for (const mesh of meshes) {
    box.setFromObject(mesh);
    if (box.isEmpty()) continue;
    box.getCenter(centre);
    if (Math.hypot(centre.x - best.x, centre.z - best.z) > CLUSTER_R) continue;
    top = Math.max(top, box.max.y);
  }

  const above = Math.max(top - best.y, 0);
  const lift = above > 0 ? THREE.MathUtils.clamp(above * SKULL_FRACTION, MIN_LIFT, MAX_LIFT) : MIN_LIFT;
  return {
    point: new THREE.Vector3(best.x, best.y + lift, best.z),
    // a head bone sits at the base of the skull, so the height above it is most
    // of the head but not all of it
    size: Math.max(above, MIN_LIFT * 2),
  };
}
