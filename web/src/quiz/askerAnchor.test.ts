import { describe, it, expect } from 'vitest';
import { askerAnchor, fallbackAnchor } from './askerAnchor.ts';
import { seatTransform, roomDims } from '../scene/layout.ts';
import type { OfficeLayout } from '../../../shared/types.ts';

const noLayout: { layout?: OfficeLayout } = {};

describe('askerAnchor', () => {
  it('anchors the boss above seat 0', () => {
    // boss ignores the `seat` argument entirely — always seat 0
    const [x, y, z] = askerAnchor('boss', null, noLayout, 5)!;
    expect(x).toBeCloseTo(seatTransform(0).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(0).position.z, 5);
    // above a ~2.3-unit character in a 1.35x-scale world, not at head height
    expect(y).toBeGreaterThan(2.3);
    expect(y).toBeLessThan(4);
  });

  it('anchors an employee above their own seat', () => {
    // caller has already resolved the asker id to seat 5 (e.g. Rey, seat 5)
    const [x, , z] = askerAnchor('e2', 5, noLayout, 5)!;
    expect(x).toBeCloseTo(seatTransform(5).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(5).position.z, 5);
  });

  it('follows a desk moved in build mode', () => {
    const layout: OfficeLayout = { seats: { 1: { x: 2.5, z: 3.5, rotY: 0 } } };
    const [x, , z] = askerAnchor('e1', 1, { layout }, 5)!;
    expect(x).toBeCloseTo(2.5, 5);
    expect(z).toBeCloseTo(3.5, 5);
  });

  it('anchors Kat Person over her furniture slot, inside the room', () => {
    // catPerson is furniture, not staff: `seat` is irrelevant and ignored
    const [x, , z] = askerAnchor('catPerson', null, noLayout, 5)!;
    const { width, depth, centerZ } = roomDims(5);
    expect(Math.abs(x)).toBeLessThan(width / 2);
    expect(z).toBeGreaterThan(centerZ - depth / 2);
    expect(z).toBeLessThan(centerZ + depth / 2);
  });

  it('returns null for an unknown asker and for no office', () => {
    // an unknown asker resolves to a null seat (the caller couldn't find them)
    expect(askerAnchor('ghost', null, noLayout, 5)).toBeNull();
    expect(askerAnchor('boss', null, null, 5)).toBeNull();
  });

  it('places an evicted asker at their old seat rather than nowhere', () => {
    // the seat rides the question, so the asker's absence from the roster is
    // irrelevant — the bubble stays put, and therefore stays answerable
    const [x, , z] = askerAnchor('evicted-emp-1', 4, noLayout, 3)!;
    expect(x).toBeCloseTo(seatTransform(4).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(4).position.z, 5);
  });

  it('fallbackAnchor lands inside the room, so a null resolution never renders nothing', () => {
    const [x, y, z] = fallbackAnchor(5);
    const { width, depth, centerZ } = roomDims(5);
    expect(Math.abs(x)).toBeLessThan(width / 2);
    expect(z).toBeGreaterThan(centerZ - depth / 2);
    expect(z).toBeLessThan(centerZ + depth / 2);
    expect(y).toBeGreaterThan(2.3);
  });
});
