import { describe, expect, it } from 'vitest';
import {
  HISTORY_MAX_LINES,
  appendHistory,
  clampOffset,
  visibleRows,
  wrapLines,
} from './monitorScrollback.ts';

describe('wrapLines', () => {
  it('passes short lines through and hard-wraps long ones', () => {
    expect(wrapLines(['abc', 'x'.repeat(10)], 4)).toEqual(['abc', 'xxxx', 'xxxx', 'xx']);
  });
});

describe('appendHistory', () => {
  it('appends lines to the existing history', () => {
    expect(appendHistory(['a'], ['b', 'c'], false, undefined)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a section divider that arrives as an ordinary appended line', () => {
    const out = appendHistory(['a'], ['── Bash · proj ──', 'b'], false, undefined);
    expect(out).toEqual(['a', '── Bash · proj ──', 'b']);
  });

  it('does not stack dividers on consecutive sections with nothing between', () => {
    const first = appendHistory(['a'], ['── Read ──'], false, undefined);
    const second = appendHistory(first, ['── Bash ──', 'b'], false, undefined);
    expect(second).toEqual(['a', '── Bash ──', 'b']);
  });

  it('restarts the buffer on a clear (the reconnect replay), so nothing doubles up', () => {
    expect(appendHistory(['a', 'b'], ['b'], true, 'Bash')).toEqual(['── Bash ──', 'b']);
  });

  it('caps history by dropping the oldest lines', () => {
    const prev = Array.from({ length: 5 }, (_, i) => `l${i}`);
    expect(appendHistory(prev, ['new'], false, undefined, 3)).toEqual(['l3', 'l4', 'new']);
  });

  it('defaults the cap to HISTORY_MAX_LINES', () => {
    const prev = Array.from({ length: HISTORY_MAX_LINES }, (_, i) => `l${i}`);
    const out = appendHistory(prev, ['new'], false, undefined);
    expect(out).toHaveLength(HISTORY_MAX_LINES);
    expect(out[out.length - 1]).toBe('new');
    expect(out[0]).toBe('l1');
  });
});

describe('clampOffset', () => {
  it('clamps below at zero', () => {
    expect(clampOffset(-5, 100, 16)).toBe(0);
  });

  it('clamps above at totalRows minus the view height', () => {
    expect(clampOffset(999, 100, 16)).toBe(84);
  });

  it('is always zero when history fits inside the view', () => {
    expect(clampOffset(10, 12, 16)).toBe(0);
  });

  it('passes in-range offsets through', () => {
    expect(clampOffset(20, 100, 16)).toBe(20);
  });
});

describe('visibleRows', () => {
  const rows = Array.from({ length: 20 }, (_, i) => `r${i}`);

  it('returns the tail at offset 0', () => {
    expect(visibleRows(rows, 0, 4)).toEqual(['r16', 'r17', 'r18', 'r19']);
  });

  it('shifts the window up by the offset', () => {
    expect(visibleRows(rows, 3, 4)).toEqual(['r13', 'r14', 'r15', 'r16']);
  });

  it('shows the head at max offset', () => {
    expect(visibleRows(rows, 16, 4)).toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it('returns everything when the view is larger than the history', () => {
    expect(visibleRows(['a', 'b'], 0, 4)).toEqual(['a', 'b']);
  });
});
