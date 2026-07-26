import { describe, it, expect } from 'vitest';
import { askerAnchor } from './askerAnchor.ts';
import { seatTransform, roomDims } from '../scene/layout.ts';
import type { OfficeState } from '../../../shared/types.ts';

const office = (): OfficeState => ({
  officeName: 'This Office',
  boss: { name: 'Boss', variant: 'Knight' },
  bossStatus: 'idle',
  employees: [
    { id: 'e1', name: 'Dana', seat: 1, variant: 'Mage', hiredAt: '', status: 'idle', task: null },
    { id: 'e2', name: 'Rey', seat: 5, variant: 'Rogue', hiredAt: '', status: 'idle', task: null },
  ],
  inbox: [],
  todos: null,
  status: [],
  staffing: { minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 },
  waitingForInput: false,
});

describe('askerAnchor', () => {
  it('anchors the boss above seat 0', () => {
    const [x, y, z] = askerAnchor('boss', office(), 5)!;
    expect(x).toBeCloseTo(seatTransform(0).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(0).position.z, 5);
    // above a ~2.3-unit character in a 1.35x-scale world, not at head height
    expect(y).toBeGreaterThan(2.3);
    expect(y).toBeLessThan(4);
  });

  it('anchors an employee above their own seat', () => {
    const [x, , z] = askerAnchor('e2', office(), 5)!;
    expect(x).toBeCloseTo(seatTransform(5).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(5).position.z, 5);
  });

  it('follows a desk moved in build mode', () => {
    const withLayout = { ...office(), layout: { seats: { 1: { x: 2.5, z: 3.5, rotY: 0 } } } };
    const [x, , z] = askerAnchor('e1', withLayout, 5)!;
    expect(x).toBeCloseTo(2.5, 5);
    expect(z).toBeCloseTo(3.5, 5);
  });

  it('anchors Kat Person over her furniture slot, inside the room', () => {
    const [x, , z] = askerAnchor('catPerson', office(), 5)!;
    const { width, depth, centerZ } = roomDims(5);
    expect(Math.abs(x)).toBeLessThan(width / 2);
    expect(z).toBeGreaterThan(centerZ - depth / 2);
    expect(z).toBeLessThan(centerZ + depth / 2);
  });

  it('returns null for an unknown asker and for no office', () => {
    expect(askerAnchor('ghost', office(), 5)).toBeNull();
    expect(askerAnchor('boss', null, 5)).toBeNull();
  });
});
