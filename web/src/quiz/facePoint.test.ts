import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { facePoint } from './facePoint.ts';

/** A stand-in character: a head bone at `headY` under a body mesh of height `top`. */
function character(x: number, z: number, headY: number, top: number, boneName = 'Head') {
  const root = new THREE.Group();
  root.position.set(x, 0, z);

  const bone = new THREE.Bone();
  bone.name = boneName;
  bone.position.set(0, headY, 0);
  root.add(bone);

  // a plain Mesh flagged as skinned: facePoint only measures silhouettes, and a
  // real SkinnedMesh would need a bound skeleton to say nothing extra
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, top, 0.8));
  (mesh as unknown as { isSkinnedMesh: boolean }).isSkinnedMesh = true;
  mesh.position.set(0, top / 2, 0);
  root.add(mesh);

  return root;
}

describe('facePoint', () => {
  it('aims just above the head bone of a bare human head', () => {
    const scene = new THREE.Scene();
    scene.add(character(3, 5, 1.8, 2.0));
    const p = facePoint(scene, 3, 5)!;
    expect(p).not.toBeNull();
    expect(p.point.x).toBeCloseTo(3);
    expect(p.point.z).toBeCloseTo(5);
    expect(p.point.y).toBeGreaterThan(1.8);
    expect(p.point.y).toBeLessThan(1.95);
    expect(p.size).toBeCloseTo(0.2);
  });

  it('does not aim at the hat', () => {
    const scene = new THREE.Scene();
    // 0.7 u of straw hat above the head bone: the face is nowhere near the crown
    scene.add(character(0, 2, 1.5, 2.2));
    const p = facePoint(scene, 0, 2)!;
    expect(p.point.y).toBeLessThan(1.75);
    // …but the shot still has to fit the hat, so the size is the whole silhouette
    expect(p.size).toBeCloseTo(0.7);
  });

  it('handles a big head on a low bone (the chibi cat)', () => {
    const scene = new THREE.Scene();
    scene.add(character(-6, -7, 1.2, 2.44, 'head'));
    const p = facePoint(scene, -6, -7)!;
    expect(p.point.y).toBeGreaterThan(1.4);
    expect(p.point.y).toBeLessThan(2.44);
    expect(p.size).toBeCloseTo(1.24);
  });

  it('picks the character nearest the anchor, not a neighbour', () => {
    const scene = new THREE.Scene();
    scene.add(character(0, 0, 1.6, 2.0));
    scene.add(character(3.4, 0, 1.9, 2.3));
    const p = facePoint(scene, 3.4, 0)!;
    expect(p.point.x).toBeCloseTo(3.4);
    expect(p.point.y).toBeCloseTo(2.0);
  });

  it('is null when nothing is standing near the anchor', () => {
    const scene = new THREE.Scene();
    scene.add(character(0, 0, 1.6, 2.0));
    expect(facePoint(scene, 0, 8)).toBeNull();
  });

  it('ignores meshes that are not characters', () => {
    const scene = new THREE.Scene();
    scene.add(character(0, 0, 1.8, 2.0));
    // a desk lamp right beside them: tall, and not skinned
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 0.4));
    lamp.position.set(0.5, 2.5, 0);
    scene.add(lamp);
    const p = facePoint(scene, 0, 0)!;
    expect(p.point.y).toBeCloseTo(1.88);
    expect(p.size).toBeCloseTo(0.2);
  });
});
