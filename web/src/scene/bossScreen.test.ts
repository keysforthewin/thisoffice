import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/types.ts';
import { bossScreenLines, formatInboxTime } from './bossScreen.ts';

/** Fixed zone so assertions are exact wherever the suite runs. UTC-4 in July. */
const NY = 'America/New_York';

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'inbox-1',
    project: 'thisoffice',
    text: 'summary',
    at: '2026-07-25T14:03:22.000Z',
    ...overrides,
  };
}

describe('formatInboxTime', () => {
  it('renders the viewer wall clock, not the UTC stamp', () => {
    // the reported bug: 1 AM in New York showed as "5:00" because the hour was
    // sliced straight out of the UTC ISO string
    expect(formatInboxTime('2026-07-25T05:00:00.000Z', NY)).toBe('1:00 AM');
  });

  it('marks AM and PM', () => {
    expect(formatInboxTime('2026-07-25T14:03:22.000Z', NY)).toBe('10:03 AM');
    expect(formatInboxTime('2026-07-25T23:30:00.000Z', NY)).toBe('7:30 PM');
  });

  it('renders midnight and noon as 12, not 0', () => {
    expect(formatInboxTime('2026-07-25T04:00:00.000Z', NY)).toBe('12:00 AM');
    expect(formatInboxTime('2026-07-25T16:00:00.000Z', NY)).toBe('12:00 PM');
  });

  it('zero-pads minutes but not the hour', () => {
    expect(formatInboxTime('2026-07-25T13:05:00.000Z', NY)).toBe('9:05 AM');
  });

  it('rolls the date backwards when the local day differs from UTC', () => {
    // 02:30 UTC on the 25th is still 22:30 on the 24th in New York
    expect(formatInboxTime('2026-07-25T02:30:00.000Z', NY)).toBe('10:30 PM');
  });

  it('honours a zone east of UTC', () => {
    expect(formatInboxTime('2026-07-25T05:00:00.000Z', 'Europe/Berlin')).toBe('7:00 AM');
  });

  it('returns an empty string for an unparseable stamp rather than "Invalid Date"', () => {
    expect(formatInboxTime('', NY)).toBe('');
    expect(formatInboxTime('not a date', NY)).toBe('');
  });
});

describe('bossScreenLines', () => {
  it('renders oldest to newest with a project/time header and a blank separator per item', () => {
    const lines = bossScreenLines(
      [
        item({ id: 'inbox-1', text: 'first', at: '2026-07-25T09:01:00.000Z' }),
        item({ id: 'inbox-2', text: 'second', at: '2026-07-25T09:05:00.000Z' }),
      ],
      NY,
    );
    expect(lines).toEqual([
      '▸ [thisoffice] 5:01 AM',
      'first',
      '',
      '▸ [thisoffice] 5:05 AM',
      'second',
      '',
    ]);
  });

  it('prefers fullText over the summary text and splits its newlines', () => {
    const lines = bossScreenLines(
      [item({ text: 'short summary', fullText: 'full raw prompt\nsecond line' })],
      NY,
    );
    expect(lines).toEqual(['▸ [thisoffice] 10:03 AM', 'full raw prompt', 'second line', '']);
  });

  it('falls back to text for legacy items without fullText', () => {
    expect(bossScreenLines([item({ text: 'only summary' })], NY)).toEqual([
      '▸ [thisoffice] 10:03 AM',
      'only summary',
      '',
    ]);
  });

  it('returns no lines for an empty inbox', () => {
    expect(bossScreenLines([])).toEqual([]);
  });
});
