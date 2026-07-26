import { describe, it, expect } from 'vitest';
import { haikuArgs, HAIKU_MODEL } from './haiku.ts';

describe('haikuArgs', () => {
  it('pins the cheapest Haiku model', () => {
    expect(HAIKU_MODEL).toBe('claude-haiku-4-5');
    expect(haikuArgs()).toContain('claude-haiku-4-5');
  });

  it('passes --no-session-persistence so our own calls are not tailed and visualized', () => {
    expect(haikuArgs()).toContain('--no-session-persistence');
  });

  it('runs in print mode', () => {
    expect(haikuArgs()).toContain('-p');
  });
});
