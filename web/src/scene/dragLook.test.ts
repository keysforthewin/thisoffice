import { describe, expect, it } from 'vitest';
import { applyLook, LOOK_SENSITIVITY, MAX_PITCH, modeForDragLook } from './dragLook.ts';

describe('applyLook', () => {
  it('turns mouse motion into yaw/pitch, inverted on both axes', () => {
    const next = applyLook({ yaw: 0, pitch: 0 }, 100, 50);
    expect(next.yaw).toBeCloseTo(-100 * LOOK_SENSITIVITY);
    expect(next.pitch).toBeCloseTo(-50 * LOOK_SENSITIVITY);
  });

  it('clamps pitch short of straight up/down, where yaw would snap', () => {
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, -100_000).pitch).toBe(MAX_PITCH);
    expect(applyLook({ yaw: 0, pitch: 0 }, 0, 100_000).pitch).toBe(-MAX_PITCH);
  });

  it('leaves yaw unwrapped, so repeated drags keep accumulating', () => {
    let look = { yaw: 0, pitch: 0 };
    for (let i = 0; i < 10; i++) look = applyLook(look, 1000, 0);
    expect(look.yaw).toBeCloseTo(-10_000 * LOOK_SENSITIVITY);
  });

  it('does not mutate the look it was given', () => {
    const look = { yaw: 1, pitch: 0.5 };
    applyLook(look, 100, 100);
    expect(look).toEqual({ yaw: 1, pitch: 0.5 });
  });
});

describe('modeForDragLook', () => {
  it('yields every mode that drives the camera to a computed pose', () => {
    expect(modeForDragLook({ kind: 'pov', index: 2 })).toEqual({ kind: 'free' });
    expect(modeForDragLook({ kind: 'movie' })).toEqual({ kind: 'free' });
    expect(modeForDragLook({ kind: 'focus', target: 'e1', from: { kind: 'free' } })).toEqual({ kind: 'free' });
  });

  it('leaves the free camera alone — nothing to yield', () => {
    expect(modeForDragLook({ kind: 'free' })).toBeNull();
  });
});
