import { describe, expect, it } from 'vitest';
import { clampPan, clampZoom, wallArtTransform } from './wallArtTexture.ts';

const PLANE = 1.84 / 1.38; // the painting's canvas aspect

describe('wallArtTransform', () => {
  it('samples the whole image when it already matches the frame', () => {
    const { repeat, offset } = wallArtTransform(PLANE, PLANE, 1, 0);
    expect(repeat[0]).toBeCloseTo(1);
    expect(repeat[1]).toBeCloseTo(1);
    expect(offset).toEqual([0, 0]);
  });

  it('crops the sides of a wide image rather than letterboxing it', () => {
    const { repeat, offset } = wallArtTransform(PLANE * 2, PLANE, 1, 0);
    expect(repeat[0]).toBeCloseTo(0.5); // half the width sampled
    expect(repeat[1]).toBeCloseTo(1); // full height
    expect(offset[0]).toBeCloseTo(0.25); // centred crop
    expect(offset[1]).toBeCloseTo(0);
  });

  it('crops the top and bottom of a tall image', () => {
    const { repeat, offset } = wallArtTransform(PLANE / 2, PLANE, 1, 0);
    expect(repeat[0]).toBeCloseTo(1);
    expect(repeat[1]).toBeCloseTo(0.5);
    expect(offset[1]).toBeCloseTo(0.25);
  });

  it('zooming in samples less of the image, still centred', () => {
    const { repeat, offset } = wallArtTransform(PLANE, PLANE, 2, 0);
    expect(repeat[0]).toBeCloseTo(0.5);
    expect(repeat[1]).toBeCloseTo(0.5);
    expect(offset[0]).toBeCloseTo(0.25);
    expect(offset[1]).toBeCloseTo(0.25);
  });

  it('pans across the overflow without sampling outside the image', () => {
    const full = wallArtTransform(PLANE * 2, PLANE, 1, 1);
    expect(full.offset[0]).toBeCloseTo(0.5); // flush with the right edge
    expect(full.offset[0] + full.repeat[0]).toBeCloseTo(1);

    const none = wallArtTransform(PLANE * 2, PLANE, 1, -1);
    expect(none.offset[0]).toBeCloseTo(0); // flush with the left edge
  });

  it('ignores pan when there is nothing to pan across', () => {
    const { offset } = wallArtTransform(PLANE, PLANE, 1, 1);
    expect(offset[0]).toBeCloseTo(0);
  });

  it('clamps out-of-range and non-finite inputs', () => {
    expect(clampZoom(0.1)).toBe(1);
    expect(clampZoom(99)).toBe(6);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampPan(5)).toBe(1);
    expect(clampPan(-5)).toBe(-1);
    expect(clampPan(Number.NaN)).toBe(0);
    const { repeat } = wallArtTransform(PLANE, PLANE, Number.POSITIVE_INFINITY, 0);
    expect(repeat[0]).toBeCloseTo(1); // non-finite zoom falls back to 1
  });
});
