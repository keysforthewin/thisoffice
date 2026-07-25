import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/types.ts';
import { bossScreenLines } from './bossScreen.ts';

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'inbox-1',
    project: 'thisoffice',
    text: 'summary',
    at: '2026-07-25T14:03:22.000Z',
    ...overrides,
  };
}

describe('bossScreenLines', () => {
  it('renders oldest to newest with a project/time header and a blank separator per item', () => {
    const lines = bossScreenLines([
      item({ id: 'inbox-1', text: 'first', at: '2026-07-25T09:01:00.000Z' }),
      item({ id: 'inbox-2', text: 'second', at: '2026-07-25T09:05:00.000Z' }),
    ]);
    expect(lines).toEqual([
      '▸ [thisoffice] 09:01',
      'first',
      '',
      '▸ [thisoffice] 09:05',
      'second',
      '',
    ]);
  });

  it('prefers fullText over the summary text and splits its newlines', () => {
    const lines = bossScreenLines([
      item({ text: 'short summary', fullText: 'full raw prompt\nsecond line' }),
    ]);
    expect(lines).toEqual(['▸ [thisoffice] 14:03', 'full raw prompt', 'second line', '']);
  });

  it('falls back to text for legacy items without fullText', () => {
    const lines = bossScreenLines([item({ text: 'only summary' })]);
    expect(lines).toEqual(['▸ [thisoffice] 14:03', 'only summary', '']);
  });

  it('returns no lines for an empty inbox', () => {
    expect(bossScreenLines([])).toEqual([]);
  });
});
