import { describe, expect, it } from 'vitest';
import { activePovIndices, nextPovIndex, shouldCutEarly } from './povAuto.ts';

// [boss, e1, e2, e3, whiteboard, tv] — the shape buildPovList produces
const POVS = [
  { key: 'boss' },
  { key: 'e1' },
  { key: 'e2' },
  { key: 'e3' },
  { key: 'whiteboard' },
  { key: 'tv' },
];
const DESKS = new Set(['boss', 'e1', 'e2', 'e3']);
const NOW = 100_000;

describe('activePovIndices', () => {
  it('finds the desks whose screens are streaming', () => {
    expect(activePovIndices(POVS, { e1: NOW, e3: NOW }, NOW, DESKS)).toEqual([1, 3]);
  });

  it('drops activity that has aged out of the window', () => {
    expect(activePovIndices(POVS, { e1: NOW - 60_000 }, NOW, DESKS)).toEqual([]);
  });

  it('never counts a wall board: this mode is over-the-shoulder at a monitor', () => {
    // the TV and the boards carry activity windows of their own (minutes long) —
    // following them here would park the tour behind an empty chair
    expect(activePovIndices(POVS, { tv: NOW, whiteboard: NOW }, NOW, DESKS)).toEqual([]);
  });

  it('ignores activity for a desk that is not in the tour (an evicted employee)', () => {
    expect(activePovIndices(POVS, { 'emp-gone': NOW }, NOW, DESKS)).toEqual([]);
  });
});

describe('nextPovIndex', () => {
  it('cycles through the active desks in order', () => {
    expect(nextPovIndex(1, [1, 3, 5], 6)).toBe(3);
    expect(nextPovIndex(3, [1, 3, 5], 6)).toBe(5);
  });

  it('wraps back to the first active desk past the end', () => {
    expect(nextPovIndex(5, [1, 3, 5], 6)).toBe(1);
  });

  it('stays put when exactly one desk is working', () => {
    expect(nextPovIndex(2, [2], 6)).toBe(2);
    // and goes there from anywhere else, rather than waiting for a cycle to come round
    expect(nextPovIndex(5, [2], 6)).toBe(2);
  });

  it('walks the whole list — boards included — when nothing is active', () => {
    expect(nextPovIndex(0, [], 6)).toBe(1);
    expect(nextPovIndex(5, [], 6)).toBe(0);
  });

  it('jumps to live work from a spot that is not in the active set', () => {
    expect(nextPovIndex(0, [2, 4], 6)).toBe(2);
    expect(nextPovIndex(4, [1, 2], 6)).toBe(1);
  });

  it('survives an empty POV list rather than dividing by zero', () => {
    expect(nextPovIndex(0, [], 0)).toBe(0);
  });
});

describe('shouldCutEarly', () => {
  it('cuts away from a dead screen while other desks are streaming', () => {
    expect(shouldCutEarly(0, [1, 2])).toBe(true);
  });

  it('lets a working desk hold its full dwell', () => {
    expect(shouldCutEarly(1, [1, 2])).toBe(false);
  });

  it('never rushes the idle walk — there is nothing better to cut to', () => {
    expect(shouldCutEarly(0, [])).toBe(false);
  });
});
