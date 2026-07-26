import { describe, expect, it } from 'vitest';
import { BOARD_POLL_MS, shouldRecheck } from './redrawGate.ts';

describe('shouldRecheck', () => {
  const a = { office: 1 };
  const b = { office: 2 };

  it('is false when nothing changed and the interval has not elapsed', () => {
    expect(shouldRecheck(1000, 900, BOARD_POLL_MS, a, a)).toBe(false);
  });

  it('is true the moment the source identity changes, without waiting', () => {
    expect(shouldRecheck(901, 900, BOARD_POLL_MS, b, a)).toBe(true);
  });

  it('is true once the poll interval elapses even with an unchanged source', () => {
    // time-dependent content (todo staleness) has no message to trigger it
    expect(shouldRecheck(1900, 900, BOARD_POLL_MS, a, a)).toBe(true);
  });

  it('treats an exactly-elapsed interval as due', () => {
    expect(shouldRecheck(1900, 900, 1000, a, a)).toBe(true);
  });

  it('detects a change to and from null (no office yet / disconnected)', () => {
    expect(shouldRecheck(0, 0, BOARD_POLL_MS, a, null)).toBe(true);
    expect(shouldRecheck(0, 0, BOARD_POLL_MS, null, a)).toBe(true);
    expect(shouldRecheck(0, 0, BOARD_POLL_MS, null, null)).toBe(false);
  });

  it('compares by identity, not value — a re-parsed message always counts', () => {
    // ws.ts JSON.parses every frame's state, so equal-looking objects are new
    expect(shouldRecheck(0, 0, BOARD_POLL_MS, { office: 1 }, { office: 1 })).toBe(true);
  });
});
