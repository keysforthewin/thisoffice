import { describe, expect, it } from 'vitest';
import { qualityLadder } from './AdaptiveQuality.tsx';

describe('qualityLadder', () => {
  it('never offers a rung above the display native ratio', () => {
    // the bug this guards: 1.25 on a 1x display renders 56% MORE pixels while
    // "reducing quality", making a struggling machine worse
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const step of qualityLadder(dpr)) expect(step).toBeLessThanOrEqual(dpr);
    }
  });

  it('collapses to a single rung on a plain 1x display', () => {
    expect(qualityLadder(1)).toEqual([1]);
  });

  it('offers the full ladder on a retina display', () => {
    expect(qualityLadder(2)).toEqual([1.5, 1.25, 1]);
  });

  it('caps the top rung on an in-between ratio and drops the duplicate', () => {
    expect(qualityLadder(1.25)).toEqual([1.25, 1]);
  });

  it('is strictly descending, so stepping down always reduces work', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const ladder = qualityLadder(dpr);
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeLessThan(ladder[i - 1]);
    }
  });

  it('never exceeds the base ceiling even on a very high-DPI display', () => {
    expect(qualityLadder(4)[0]).toBe(1.5);
  });
});
