import { describe, it, expect } from 'vitest';
import { captionLines } from './eotmTexture.ts';

describe('captionLines', () => {
  it('always leads with the title', () => {
    expect(captionLines('Dana')[0]).toBe('EMPLOYEE OF THE MONTH');
  });

  it('names the winner on the second line', () => {
    expect(captionLines('Dana')[1]).toBe('Dana');
  });

  it('truncates an absurd name rather than overflowing the plaque', () => {
    const line = captionLines('x'.repeat(200))[1];
    expect(line.length).toBeLessThanOrEqual(24);
  });

  it('falls back to a placeholder for an empty name', () => {
    expect(captionLines('   ')[1]).toBe('—');
  });
});
