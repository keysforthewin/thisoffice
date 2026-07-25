// web/src/scene/vistaGeometry.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vistaBoxFaces } from './vistaGeometry.ts';

describe('vistaBoxFaces', () => {
  const w = 14, h = 10, d = 24;
  const faces = vistaBoxFaces(w, h, d);

  it('returns five faces whose areas cover the box minus the open side', () => {
    expect(faces).toHaveLength(5);
    const area = faces.reduce((a, f) => a + f.size[0] * f.size[1], 0);
    expect(area).toBeCloseTo(w * h + 2 * d * h + 2 * w * d);
    expect(faces.filter((f) => f.kind === 'back')).toHaveLength(1);
  });

  it('every face normal points into the box', () => {
    const center = new THREE.Vector3(0, 0, -d / 2);
    for (const f of faces) {
      const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...f.rotation));
      const toCenter = center.clone().sub(new THREE.Vector3(...f.position));
      expect(n.dot(toCenter)).toBeGreaterThan(0);
    }
  });

  // sample interior "camera" points (z>0, incl. far-lateral grazing spots)
  const cams = [
    new THREE.Vector3(0, 0, 3),
    new THREE.Vector3(11, 0, 0.5),   // hard grazing from the side
    new THREE.Vector3(-11, 3, 0.5),
    new THREE.Vector3(0, 5, 0.3),    // grazing from above (near ceiling)
    new THREE.Vector3(4, -0.9, 8),
  ];
  // points spanning the window opening at z=0 (opening 3.6×1.9 centered at origin)
  const targets = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1.8, 0.95, 0),
    new THREE.Vector3(-1.8, -0.95, 0),
    new THREE.Vector3(1.8, -0.95, 0),
    new THREE.Vector3(-1.8, 0.95, 0),
  ];

  /** Asserts no sight line through the opening escapes between the faces. */
  const expectClosed = (box: ReturnType<typeof vistaBoxFaces>) => {
    for (const cam of cams) {
      for (const t of targets) {
        const dir = t.clone().sub(cam).normalize();
        if (dir.z >= -1e-6) continue; // not entering the box
        const hit = box.some((f) => {
          const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...f.rotation));
          const p = new THREE.Vector3(...f.position);
          const denom = n.dot(dir);
          if (Math.abs(denom) < 1e-9) return false;
          const s = n.dot(p.clone().sub(t)) / denom;
          if (s < 1e-6) return false;
          const q = t.clone().addScaledVector(dir, s);
          // point-in-rect in the face's local axes
          const local = q.sub(p);
          const eu = new THREE.Euler(...f.rotation);
          local.applyEuler(new THREE.Euler(-eu.x, -eu.y, -eu.z, 'ZYX'));
          return Math.abs(local.x) <= f.size[0] / 2 + 1e-6 && Math.abs(local.y) <= f.size[1] / 2 + 1e-6;
        });
        expect(hit, `ray from ${cam.toArray()} via ${t.toArray()} escaped the box`).toBe(true);
      }
    }
  };

  it('any ray entering through the open side hits a face, even at grazing angles', () => {
    expectClosed(faces);
  });

  it('a laterally shifted box is still closed to every ray through the opening', () => {
    // the back window's real config: shifted +x so it never crosses the left wall
    expectClosed(vistaBoxFaces(32, 20, 24, 12.3));
  });

  it('cx slides the cross-section without resizing it', () => {
    const shifted = vistaBoxFaces(32, 20, 24, 12.3);
    const base = vistaBoxFaces(32, 20, 24);
    for (let i = 0; i < base.length; i++) {
      expect(shifted[i].kind).toBe(base[i].kind);
      expect(shifted[i].size).toEqual(base[i].size);
      expect(shifted[i].rotation).toEqual(base[i].rotation);
      expect(shifted[i].position[0]).toBeCloseTo(base[i].position[0] + 12.3);
      expect(shifted[i].position[1]).toBeCloseTo(base[i].position[1]);
      expect(shifted[i].position[2]).toBeCloseTo(base[i].position[2]);
    }
    // box spans x∈[cx-w/2, cx+w/2]
    expect(shifted.find((f) => f.kind === 'left')!.position[0]).toBeCloseTo(-3.7);
    expect(shifted.find((f) => f.kind === 'right')!.position[0]).toBeCloseTo(28.3);
  });
});
