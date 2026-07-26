import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { photoShot } from './photoShot.ts';
import { roomDims, seatTransform, ROOM_HEIGHT } from '../scene/layout.ts';

const SEATS = [0, 1, 2, 3, 5, 9, 12];

describe('photoShot', () => {
  it('keeps the camera inside the room for every seat', () => {
    for (const maxSeat of [3, 6, 12]) {
      const { width, depth, centerZ } = roomDims(maxSeat);
      for (const seat of SEATS) {
        const subject = seatTransform(seat).position;
        const { position } = photoShot(subject, maxSeat);
        expect(Math.abs(position.x)).toBeLessThan(width / 2);
        expect(position.z).toBeGreaterThan(centerZ - depth / 2);
        expect(position.z).toBeLessThan(centerZ + depth / 2);
        expect(position.y).toBeGreaterThan(0.5);
        expect(position.y).toBeLessThan(ROOM_HEIGHT);
      }
    }
  });

  it('frames the subject within the shot', () => {
    const subject = seatTransform(2).position;
    const { position, lookAt, fov } = photoShot(subject, 6);
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
    camera.position.copy(position);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const ndc = subject.clone().setY(1.4).project(camera);
    expect(Math.abs(ndc.x)).toBeLessThan(1);
    expect(Math.abs(ndc.y)).toBeLessThan(1);
    expect(ndc.z).toBeGreaterThan(-1);
    expect(ndc.z).toBeLessThan(1);
  });

  it('places the subject off-centre so colleagues fill the rest of the frame', () => {
    const subject = seatTransform(2).position;
    const { position, lookAt, fov } = photoShot(subject, 6);
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
    camera.position.copy(position);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const ndcX = subject.clone().setY(1.4).project(camera).x;
    expect(Math.abs(ndcX)).toBeGreaterThan(0.08);
  });

  it('stands far enough back to catch more than just the subject', () => {
    const subject = seatTransform(2).position;
    const { position } = photoShot(subject, 6);
    expect(position.distanceTo(subject)).toBeGreaterThan(3);
  });

  it('is deterministic', () => {
    const subject = seatTransform(4).position;
    const a = photoShot(subject, 6);
    const b = photoShot(subject, 6);
    expect(a.position.toArray()).toEqual(b.position.toArray());
    expect(a.fov).toBe(b.fov);
  });
});
