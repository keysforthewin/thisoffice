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
    const { offset } = wallArtTransform(PLANE, PLANE, 1, 1, 1);
    expect(offset[0]).toBeCloseTo(0);
    expect(offset[1]).toBeCloseTo(0);
  });

  it('pans vertically across a tall image without sampling outside it', () => {
    const top = wallArtTransform(PLANE / 2, PLANE, 1, 0, 1);
    expect(top.offset[1]).toBeCloseTo(0.5); // flush with the top edge
    expect(top.offset[1] + top.repeat[1]).toBeCloseTo(1);

    const bottom = wallArtTransform(PLANE / 2, PLANE, 1, 0, -1);
    expect(bottom.offset[1]).toBeCloseTo(0); // flush with the bottom edge
  });

  it('pans vertically once zoom creates overflow on an exact-fit image', () => {
    // no vertical overflow at zoom 1, so panY only bites after zooming in
    expect(wallArtTransform(PLANE, PLANE, 1, 0, 1).offset[1]).toBeCloseTo(0);
    const zoomed = wallArtTransform(PLANE, PLANE, 2, 0, 1);
    expect(zoomed.offset[1]).toBeCloseTo(0.5);
    expect(zoomed.offset[1] + zoomed.repeat[1]).toBeCloseTo(1);
  });

  it('pans both axes at once', () => {
    const { offset, repeat } = wallArtTransform(PLANE, PLANE, 2, 1, -1);
    expect(offset[0]).toBeCloseTo(0.5); // flush right
    expect(offset[0] + repeat[0]).toBeCloseTo(1);
    expect(offset[1]).toBeCloseTo(0); // flush bottom
  });

  it('defaults panY to centred when omitted, so old callers are unaffected', () => {
    const withArg = wallArtTransform(PLANE / 2, PLANE, 1, 0, 0);
    const without = wallArtTransform(PLANE / 2, PLANE, 1, 0);
    expect(without.offset).toEqual(withArg.offset);
    expect(without.offset[1]).toBeCloseTo(0.25); // centred crop
  });

  it('clamps an out-of-range or non-finite panY like panX', () => {
    expect(wallArtTransform(PLANE / 2, PLANE, 1, 0, 9).offset[1]).toBeCloseTo(0.5);
    expect(wallArtTransform(PLANE / 2, PLANE, 1, 0, Number.NaN).offset[1]).toBeCloseTo(0.25);
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
