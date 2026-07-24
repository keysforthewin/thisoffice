import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { normalizeMixamoName, normalizeTrackName, measureSkinnedHeight } from './convert.ts';

describe('normalizeMixamoName', () => {
  it('strips every Mixamo prefix variant', () => {
    expect(normalizeMixamoName('mixamorig:Hips')).toBe('Hips');
    expect(normalizeMixamoName('mixamorigHips')).toBe('Hips');
    expect(normalizeMixamoName('mixamorig_LeftUpLeg')).toBe('LeftUpLeg');
    expect(normalizeMixamoName('MixamoRig:Spine1')).toBe('Spine1');
  });

  it('leaves non-Mixamo names alone', () => {
    expect(normalizeMixamoName('Hips')).toBe('Hips');
    expect(normalizeMixamoName('Beta_Surface')).toBe('Beta_Surface');
  });
});

describe('normalizeTrackName', () => {
  it('normalizes only the node segment', () => {
    expect(normalizeTrackName('mixamorig:Hips.position')).toBe('Hips.position');
    expect(normalizeTrackName('mixamorigSpine.quaternion')).toBe('Spine.quaternion');
    expect(normalizeTrackName('Hips.position')).toBe('Hips.position');
  });
});

describe('measureSkinnedHeight', () => {
  it('measures skinned meshes only, ignoring helper nodes', () => {
    const group = new THREE.Group();
    const skinned = new THREE.SkinnedMesh(
      new THREE.BoxGeometry(1, 1.8, 1), // character-sized
      new THREE.MeshBasicMaterial(),
    );
    skinned.position.y = 0.9; // feet at y=0
    group.add(skinned);
    // stray tall helper mesh like the ones Mixamo FBX exports sometimes carry
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 100, 1), new THREE.MeshBasicMaterial());
    group.add(helper);
    group.add(new THREE.Object3D());

    expect(measureSkinnedHeight(group)).toBeCloseTo(1.8);
  });

  it('returns 0 when there is no skinned mesh', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 5, 1), new THREE.MeshBasicMaterial()));
    expect(measureSkinnedHeight(group)).toBe(0);
  });
});
