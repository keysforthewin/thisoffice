import { describe, expect, it } from 'vitest';
import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';
import { countVisibleChars } from './watcher.ts';

describe('countVisibleChars', () => {
  it('counts the text of every line, excluding the newlines themselves', () => {
    expect(countVisibleChars('abc')).toBe(3);
    expect(countVisibleChars('abc\nde')).toBe(5);
    expect(countVisibleChars('')).toBe(0);
  });

  it('ignores screenshot lines, whose data URL would swamp every real desk', () => {
    const png = MONITOR_IMAGE_MARKER + 'data:image/png;base64,' + 'A'.repeat(50_000);
    expect(countVisibleChars(png)).toBe(0);
    expect(countVisibleChars(`reading a file\n${png}\ndone`)).toBe('reading a file'.length + 'done'.length);
  });
});
