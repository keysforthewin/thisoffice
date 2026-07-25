import { describe, expect, it } from 'vitest';
import { wallStrips } from './wallOpenings.ts';

describe('wallStrips', () => {
  it('covers wall minus opening exactly, without overlap', () => {
    const strips = wallStrips(10, 7.5, -2.5, -1.65, 3.6, 1.9); // back-wall window
    const area = strips.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(10 * 7.5 - 3.6 * 1.9);
    // strips stay within the wall
    for (const r of strips) {
      expect(r.x - r.w / 2).toBeGreaterThanOrEqual(-5 - 1e-9);
      expect(r.x + r.w / 2).toBeLessThanOrEqual(5 + 1e-9);
      expect(r.y - r.h / 2).toBeGreaterThanOrEqual(-3.75 - 1e-9);
      expect(r.y + r.h / 2).toBeLessThanOrEqual(3.75 + 1e-9);
    }
    // nothing covers the opening's center
    for (const r of strips) {
      const inX = Math.abs(-2.5 - r.x) < r.w / 2;
      const inY = Math.abs(-1.65 - r.y) < r.h / 2;
      expect(inX && inY).toBe(false);
    }
  });

  it('omits zero-width strips when the opening touches an edge', () => {
    const strips = wallStrips(4, 4, -1, 0, 2, 4); // opening spans full height at left half
    expect(strips).toHaveLength(1); // only the right strip remains
  });
});
