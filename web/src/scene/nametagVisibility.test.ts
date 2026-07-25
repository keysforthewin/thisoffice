import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NO_RAYCAST, findHeadBone, isTagFullyVisible, tagSamplePoints } from './nametagVisibility.ts';

// Camera at origin looking down -z (identity quaternion): right=+x, up=+y.
const CAM_POS = new THREE.Vector3(0, 0, 0);
const CAM_QUAT = new THREE.Quaternion();
const TAG_CENTER = new THREE.Vector3(0, 0, -5);
const TAG_W = 1;
const TAG_H = 0.5;

function planeAt(z: number, size = 20): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial());
  mesh.position.z = z;
  mesh.updateMatrixWorld();
  return mesh;
}

/** A small box that covers only the tag's left edge (x ≈ -0.5), centered on the tag height. */
function cornerBlockerAt(z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 0.1), new THREE.MeshBasicMaterial());
  // Between camera and tag the quad shrinks proportionally; at z the tag's left
  // edge ray passes through x = -0.5 * (z / -5). Place the blocker there.
  mesh.position.set(-0.5 * (z / -5), 0, z);
  mesh.updateMatrixWorld();
  return mesh;
}

function sceneWith(...objects: THREE.Object3D[]): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(...objects);
  scene.updateMatrixWorld(true);
  return scene;
}

describe('tagSamplePoints', () => {
  it('returns 9 points spanning the camera-facing quad: corners, edge midpoints, center', () => {
    const pts = tagSamplePoints(TAG_CENTER, CAM_QUAT, TAG_W, TAG_H);
    expect(pts).toHaveLength(9);
    const xs = pts.map((p) => p.x).sort((a, b) => a - b);
    const ys = pts.map((p) => p.y).sort((a, b) => a - b);
    expect(Math.min(...xs)).toBeCloseTo(-TAG_W / 2);
    expect(Math.max(...xs)).toBeCloseTo(TAG_W / 2);
    expect(Math.min(...ys)).toBeCloseTo(-TAG_H / 2);
    expect(Math.max(...ys)).toBeCloseTo(TAG_H / 2);
    for (const p of pts) expect(p.z).toBeCloseTo(-5);
  });

  it('orients the quad by the camera quaternion', () => {
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const pts = tagSamplePoints(TAG_CENTER, quat, TAG_W, TAG_H);
    // Rolled 90°: width now spans y, height spans x.
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(TAG_W / 2);
    expect(Math.max(...xs)).toBeCloseTo(TAG_H / 2);
  });
});

describe('isTagFullyVisible', () => {
  it('visible with nothing in the way', () => {
    const scene = sceneWith(planeAt(-8));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(true);
  });

  it('hidden when a wall fully covers it', () => {
    const scene = sceneWith(planeAt(-3));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(false);
  });

  it('hidden when geometry covers only one edge (all-or-nothing)', () => {
    const scene = sceneWith(cornerBlockerAt(-3));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(false);
  });

  it('visible through meshes opted out of raycasting (characters)', () => {
    const body = planeAt(-3);
    body.raycast = NO_RAYCAST;
    const scene = sceneWith(body);
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(true);
  });

  it('ignores geometry behind the tag', () => {
    const scene = sceneWith(planeAt(-5.01));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(true);
  });

  it('still raycasts invisible meshes (person colliders are visible=false)', () => {
    const blocker = planeAt(-3);
    blocker.visible = false;
    const scene = sceneWith(blocker);
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(false);
  });

  it('the ignore predicate exempts the own avatar collider but not others', () => {
    const own = planeAt(-3);
    const other = planeAt(-3.5);
    const scene = sceneWith(own, other);
    const ignoreOwn = (o: THREE.Object3D) => o === own;
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, ignoreOwn)).toBe(false);
    other.removeFromParent();
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, ignoreOwn)).toBe(true);
  });
});

describe('findHeadBone', () => {
  function rig(...names: string[]): THREE.Object3D {
    const root = new THREE.Object3D();
    let parent: THREE.Object3D = root;
    for (const [i, name] of names.entries()) {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.y = 0.5 - i * 0.1; // each child sits a bit higher in world space
      parent.add(bone);
      parent = bone;
    }
    return root;
  }

  it('picks the highest head-ish bone (the crown, when the rig has one)', () => {
    const root = rig('spine', 'neck', 'Head', 'HeadTop_End');
    expect(findHeadBone(root)?.name).toBe('HeadTop_End');
  });

  it('finds mixamo-style names', () => {
    const root = rig('mixamorigSpine', 'mixamorigHead');
    expect(findHeadBone(root)?.name).toBe('mixamorigHead');
  });

  it('returns null when the rig has no head bone', () => {
    const root = rig('spine', 'neck');
    expect(findHeadBone(root)).toBeNull();
  });

  it('ignores non-bone nodes named head', () => {
    const root = new THREE.Object3D();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.name = 'head';
    root.add(mesh);
    expect(findHeadBone(root)).toBeNull();
  });
});
