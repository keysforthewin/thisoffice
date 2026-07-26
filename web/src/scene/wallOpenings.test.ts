import { describe, expect, it } from 'vitest';
import { wallStrips, type Rect } from './wallOpenings.ts';

/** Total area, and a check that no two strips overlap. */
function area(strips: Rect[]): number {
  for (let i = 0; i < strips.length; i++) {
    for (let j = i + 1; j < strips.length; j++) {
      const a = strips[i];
      const b = strips[j];
      const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-9;
      const overlapY = Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-9;
      expect(overlapX && overlapY, `strips ${i} and ${j} overlap`).toBe(false);
    }
  }
  return strips.reduce((acc, r) => acc + r.w * r.h, 0);
}

function covers(strips: Rect[], x: number, y: number): boolean {
  return strips.some((r) => Math.abs(x - r.x) < r.w / 2 - 1e-9 && Math.abs(y - r.y) < r.h / 2 - 1e-9);
}

describe('wallStrips', () => {
  it('covers wall minus opening exactly, without overlap', () => {
    const strips = wallStrips(10, 7.5, [{ x: -2.5, y: -1.65, w: 3.6, h: 1.9 }]); // back-wall window
    expect(area(strips)).toBeCloseTo(10 * 7.5 - 3.6 * 1.9);
    for (const r of strips) {
      expect(r.x - r.w / 2).toBeGreaterThanOrEqual(-5 - 1e-9);
      expect(r.x + r.w / 2).toBeLessThanOrEqual(5 + 1e-9);
      expect(r.y - r.h / 2).toBeGreaterThanOrEqual(-3.75 - 1e-9);
      expect(r.y + r.h / 2).toBeLessThanOrEqual(3.75 + 1e-9);
    }
    expect(covers(strips, -2.5, -1.65)).toBe(false);
  });

  it('omits zero-width strips when the opening touches an edge', () => {
    const strips = wallStrips(4, 4, [{ x: -1, y: 0, w: 2, h: 4 }]); // full height at the left half
    expect(strips).toHaveLength(1); // only the right strip remains
  });

  it('is a solid wall with no openings at all', () => {
    expect(wallStrips(10, 7.5, [])).toEqual([{ x: 0, y: 0, w: 10, h: 7.5 }]);
  });

  it('cuts both windows out when they share a wall', () => {
    const a = { x: -3, y: 0, w: 2, h: 2 };
    const b = { x: 3, y: 1, w: 2, h: 2 };
    const strips = wallStrips(12, 8, [a, b]);
    expect(area(strips)).toBeCloseTo(12 * 8 - 2 * 2 - 2 * 2);
    expect(covers(strips, a.x, a.y)).toBe(false);
    expect(covers(strips, b.x, b.y)).toBe(false);
    // the wall between and around them is still solid
    expect(covers(strips, 0, 0)).toBe(true);
    expect(covers(strips, -3, 3)).toBe(true);
  });

  it('handles openings stacked in the same vertical band', () => {
    const lo = { x: 0, y: -2, w: 2, h: 2 };
    const hi = { x: 0, y: 2, w: 2, h: 2 };
    const strips = wallStrips(8, 8, [lo, hi]);
    expect(area(strips)).toBeCloseTo(8 * 8 - 2 * 2 - 2 * 2);
    expect(covers(strips, 0, -2)).toBe(false);
    expect(covers(strips, 0, 2)).toBe(false);
    expect(covers(strips, 0, 0)).toBe(true); // the band between them
  });

  it('clips an opening hanging off the end instead of emitting a negative strip', () => {
    const strips = wallStrips(10, 6, [{ x: 4.5, y: 0, w: 3, h: 2 }]); // spans x 3..6, wall ends at 5
    expect(area(strips)).toBeCloseTo(10 * 6 - 2 * 2);
    for (const r of strips) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });

  it('leaves nothing behind when an opening swallows the wall', () => {
    expect(wallStrips(4, 4, [{ x: 0, y: 0, w: 10, h: 10 }])).toEqual([]);
  });
});
