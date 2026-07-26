import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  NO_RAYCAST,
  crownOffset,
  fillsView,
  findHeadBone,
  isTagFullyVisible,
  resetOccluderCache,
  tagSamplePoints,
} from './nametagVisibility.ts';

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

describe('tagSamplePoints scratch reuse', () => {
  it('returns the same array and vectors on every call (documented scratch contract)', () => {
    const a = tagSamplePoints(TAG_CENTER, CAM_QUAT, TAG_W, TAG_H);
    const firstA = a[0];
    const b = tagSamplePoints(new THREE.Vector3(9, 9, 9), CAM_QUAT, TAG_W, TAG_H);
    expect(b).toBe(a);
    expect(b[0]).toBe(firstA);
    // and it really did recompute rather than hand back stale values
    expect(b[0].x).toBeCloseTo(9);
  });
});

describe('occluder cache', () => {
  it('reuses the collected occluders inside the refresh window', () => {
    resetOccluderCache();
    const scene = sceneWith(planeAt(-8));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, undefined, 1000)).toBe(true);

    // a wall appears, but within the window the cached list has not seen it
    scene.add(planeAt(-3));
    scene.updateMatrixWorld(true);
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, undefined, 1100)).toBe(true);
  });

  it('picks up new geometry after the refresh window elapses', () => {
    resetOccluderCache();
    const scene = sceneWith(planeAt(-8));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, undefined, 1000)).toBe(true);

    scene.add(planeAt(-3));
    scene.updateMatrixWorld(true);
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, undefined, 2000)).toBe(false);
  });

  it('rebuilds when the scene identity changes even inside the window', () => {
    resetOccluderCache();
    const a = sceneWith(planeAt(-8));
    expect(isTagFullyVisible(a, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, undefined, 1000)).toBe(true);
    const b = sceneWith(planeAt(-3));
    expect(isTagFullyVisible(b, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H, undefined, 1010)).toBe(false);
  });

  it('omitting `now` forces a fresh walk (the test/default path)', () => {
    resetOccluderCache();
    const scene = sceneWith(planeAt(-8));
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(true);
    scene.add(planeAt(-3));
    scene.updateMatrixWorld(true);
    expect(isTagFullyVisible(scene, CAM_POS, CAM_QUAT, TAG_CENTER, TAG_W, TAG_H)).toBe(false);
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

describe('fillsView', () => {
  const cam = (fov: number) => {
    const c = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
    return c;
  };

  it('lets a tag through at a normal viewing distance', () => {
    expect(fillsView(0.22, 6, cam(50), 0.2)).toBe(false);
  });

  it('culls the same tag once the camera is on top of it', () => {
    expect(fillsView(0.22, 0.5, cam(50), 0.2)).toBe(true);
  });

  it('culls sooner at a longer lens, from the very same spot', () => {
    // the movie camera zooms fov mid-shot, which is why this is measured in
    // screen fraction and not in world units
    expect(fillsView(0.22, 2, cam(50), 0.2)).toBe(false);
    expect(fillsView(0.22, 2, cam(18), 0.2)).toBe(true);
  });

  it('gives a big surface a proportionally closer cutoff at the same threshold', () => {
    // a 1.3-unit card and a 0.22-unit pill cannot share one distance rule
    expect(fillsView(1.3, 3, cam(50), 0.2)).toBe(true);
    expect(fillsView(0.22, 3, cam(50), 0.2)).toBe(false);
  });

  it('treats a degenerate distance as filling the view rather than dividing by zero', () => {
    expect(fillsView(0.22, 0, cam(50), 0.2)).toBe(true);
  });

  it('never culls under an orthographic camera, which has no fov to reason about', () => {
    expect(fillsView(0.22, 0.01, new THREE.OrthographicCamera(-1, 1, 1, -1), 0.2)).toBe(false);
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

describe('crownOffset', () => {
  /** SkinnedMesh with a `head` bone bound at `boneY` and geometry topping out at `topY`. */
  function makeCharacter(boneY: number, topY: number) {
    const root = new THREE.Object3D();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    const head = new THREE.Bone();
    head.name = 'head';
    head.position.y = boneY;
    hips.add(head);
    root.add(hips);
    root.updateMatrixWorld(true);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, topY, 0], 3));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([hips, head]));
    root.add(mesh);
    root.updateMatrixWorld(true);
    return { root, head };
  }

  it('measures skull height above the head bone', () => {
    // Knight: head bone binds at 1.241, skinned head geometry tops out at 2.31
    const { root, head } = makeCharacter(1.241, 2.31);
    expect(crownOffset(root, head)).toBeCloseTo(2.31 - 1.241, 5);
  });

  it('reports a much larger offset for a chibi head than the old 0.3 constant', () => {
    const { root, head } = makeCharacter(1.241, 2.464); // the cat person
    expect(crownOffset(root, head)!).toBeGreaterThan(0.3);
  });

  it('ignores unskinned meshes parented to bones (KayKit weapons are bone-local)', () => {
    const { root, head } = makeCharacter(1.241, 2.31);
    // a 2H sword hanging off a hand bone: local bounds say 1.96, model space says otherwise
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.92, 0.1), new THREE.MeshBasicMaterial());
    sword.name = '2H_Sword';
    head.add(sword);
    root.updateMatrixWorld(true);
    expect(crownOffset(root, head)).toBeCloseTo(2.31 - 1.241, 5);
  });

  it('returns null without a head bone or without skinned geometry', () => {
    const { root } = makeCharacter(1.241, 2.31);
    expect(crownOffset(root, null)).toBeNull();
    const bare = new THREE.Object3D();
    const loose = new THREE.Bone();
    loose.name = 'head';
    bare.add(loose);
    bare.updateMatrixWorld(true);
    expect(crownOffset(bare, loose)).toBeNull();
  });

  it('converts centimetre skin space to root units (Mixamo armature scale)', () => {
    // Mixamo: geometry in cm under an armature node scaled back to metres.
    const root = new THREE.Object3D();
    const armature = new THREE.Object3D();
    armature.scale.setScalar(0.01);
    root.add(armature);
    const hips = new THREE.Bone();
    hips.name = 'hips';
    const head = new THREE.Bone();
    head.name = 'mixamorigHead';
    head.position.y = 150;
    hips.add(head);
    armature.add(hips);
    root.updateMatrixWorld(true);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 180, 0], 3));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    armature.add(mesh);
    // GLTFLoader binds with the file's inverseBindMatrices and an identity bind
    // matrix, so the inverses stay in the skin's own (centimetre) space rather
    // than picking up the armature scale from bone.matrixWorld.
    const inverses = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(0, -150, 0)];
    mesh.bind(new THREE.Skeleton([hips, head], inverses), new THREE.Matrix4());
    root.updateMatrixWorld(true);

    // 30 cm of skull, not 30 metres
    expect(crownOffset(root, head)).toBeCloseTo(0.3, 5);
  });

  it('never returns a negative offset', () => {
    const { root, head } = makeCharacter(2.0, 1.0); // bone above the silhouette top
    expect(crownOffset(root, head)).toBe(0);
  });
});
