import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { photoShot } from './photoShot.ts';
import { roomDims, seatTransform, ROOM_HEIGHT } from '../scene/layout.ts';

const SEATS = [0, 1, 2, 3, 5, 9, 12];
/** A plausible measured face for a seated character at a given seat. */
function faceAt(seat: number): { face: THREE.Vector3; rotY: number } {
  const { position, rotationY } = seatTransform(seat);
  const forward = new THREE.Vector3(Math.sin(rotationY), 0, Math.cos(rotationY));
  return { face: position.clone().addScaledVector(forward, -1.15).setY(1.9), rotY: rotationY };
}

function cameraFor(shot: ReturnType<typeof photoShot>) {
  const camera = new THREE.PerspectiveCamera(shot.fov, 16 / 9, 0.1, 100);
  camera.position.copy(shot.position);
  camera.lookAt(shot.lookAt);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe('photoShot', () => {
  it('keeps the camera inside the room for every seat', () => {
    for (const maxSeat of [3, 6, 12]) {
      const { width, depth, centerZ } = roomDims(maxSeat);
      for (const seat of SEATS) {
        const { face, rotY } = faceAt(seat);
        const { position } = photoShot(face, rotY, maxSeat);
        expect(Math.abs(position.x)).toBeLessThan(width / 2);
        expect(position.z).toBeGreaterThan(centerZ - depth / 2);
        expect(position.z).toBeLessThan(centerZ + depth / 2);
        expect(position.y).toBeGreaterThan(0.5);
        expect(position.y).toBeLessThan(ROOM_HEIGHT);
      }
    }
  });

  it('stands in front of the face, on the direction the character is looking', () => {
    for (const seat of SEATS) {
      const { face, rotY } = faceAt(seat);
      const { position } = photoShot(face, rotY, 12);
      const forward = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      const toCamera = position.clone().sub(face).setY(0).normalize();
      // head-on: the camera sits along the facing axis, not off to one side
      expect(toCamera.dot(forward)).toBeGreaterThan(0.99);
    }
  });

  it('centres the face in the frame and shoots it near eye level', () => {
    const { face, rotY } = faceAt(2);
    const shot = photoShot(face, rotY, 6);
    const ndc = face.clone().project(cameraFor(shot));
    expect(Math.abs(ndc.x)).toBeLessThan(0.01);
    expect(Math.abs(ndc.y)).toBeLessThan(0.01);
    // a touch above the face, so the shot isn't looking up the subject's nose
    expect(shot.position.y).toBeGreaterThan(face.y);
    expect(shot.position.y - face.y).toBeLessThan(0.25);
  });

  it('stays short of the desk monitor however big the winner is', () => {
    const { face, rotY } = faceAt(2);
    for (const headSize of [0.2, 0.7, 1.2]) {
      const { position } = photoShot(face, rotY, 6, { headSize });
      const d = position.distanceTo(face);
      expect(d).toBeGreaterThan(0.8);
      // the character sits 1.15 back from the desk centre and the monitor stands
      // at desk-local z 0.35: past that the lens is behind the screen
      expect(d).toBeLessThan(1.15 + 0.35);
    }
  });

  it('backs off for a big head when the winner is not at a desk', () => {
    const face = new THREE.Vector3(-6.8, 1.5, -7.1);
    const small = photoShot(face, Math.PI / 6, 6, { headSize: 0.2, seated: false });
    const big = photoShot(face, Math.PI / 6, 6, { headSize: 1.2, seated: false });
    expect(big.position.distanceTo(face)).toBeGreaterThan(small.position.distanceTo(face) + 1);
    // and the big head still fits the frame it was sized for
    const ndc = face.clone().setY(face.y + 0.6).project(cameraFor(big));
    expect(Math.abs(ndc.y)).toBeLessThan(1);
  });

  it('frames a head-and-shoulders crop rather than the whole room', () => {
    const { face, rotY } = faceAt(2);
    const shot = photoShot(face, rotY, 6);
    const camera = cameraFor(shot);
    // a point one head-height above the face must still be well inside the frame,
    // and a point a metre above it must not be
    expect(Math.abs(face.clone().setY(face.y + 0.25).project(camera).y)).toBeLessThan(0.9);
    expect(Math.abs(face.clone().setY(face.y + 1).project(camera).y)).toBeGreaterThan(1);
  });

  it('is deterministic', () => {
    const { face, rotY } = faceAt(4);
    const a = photoShot(face, rotY, 6);
    const b = photoShot(face, rotY, 6);
    expect(a.position.toArray()).toEqual(b.position.toArray());
    expect(a.lookAt.toArray()).toEqual(b.lookAt.toArray());
    expect(a.fov).toBe(b.fov);
  });
});
