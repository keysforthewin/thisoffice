import { describe, expect, it } from 'vitest';
import type { UsageStats } from '../../../shared/types.ts';
import { formatDuration, formatTokens, formatUSD, tvContent, tvPageIndex, tvPages } from './tvContent.ts';

function baseStats(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    trackingSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    tokensByModel: {},
    toolCalls: {},
    prompts: 0,
    sessions: 0,
    subagents: 0,
    webSearches: 0,
    webFetches: 0,
    turns: 0,
    turnMsTotal: 0,
    longestTurnMs: 0,
    peakHeadcount: 0,
    hires: 0,
    byDay: {},
    hourCounts: {},
    ...overrides,
  };
}

describe('formatTokens', () => {
  it('renders sub-1000 counts as plain integers', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(0)).toBe('0');
  });

  it('switches to k at the 1000 boundary', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(12_400)).toBe('12.4k');
  });

  it('switches to M and B at their boundaries', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(3_400_000_000)).toBe('3.4B');
  });
});

describe('formatUSD', () => {
  it('renders sub-$1000 amounts with cents', () => {
    expect(formatUSD(0.42)).toBe('$0.42');
    expect(formatUSD(12.34)).toBe('$12.34');
  });

  it('renders $1000+ amounts as comma-grouped whole dollars', () => {
    expect(formatUSD(1234)).toBe('$1,234');
  });
});

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(42_000)).toBe('42s');
  });

  it('renders sub-hour durations in minutes and seconds', () => {
    expect(formatDuration(3 * 60_000 + 12_000)).toBe('3m 12s');
  });

  it('renders hour-plus durations in hours and minutes', () => {
    expect(formatDuration(60 * 60_000 + 4 * 60_000)).toBe('1h 4m');
  });
});

describe('tvPages', () => {
  it('returns no pages for null stats', () => {
    expect(tvPages(null)).toEqual([]);
  });

  it('skips empty-stat pages: a tokens-only stats object produces no tool/office pages', () => {
    const stats = baseStats({
      tokensByModel: { 'claude-sonnet-4-5-20250929': { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 } },
    });
    const pages = tvPages(stats);
    const titles = pages.map((p) => p.title);
    expect(titles).toContain('Total tokens');
    expect(titles).toContain('Top models');
    expect(titles).not.toContain('Tool calls');
    expect(titles).not.toContain('Edits & writes');
    expect(titles).not.toContain('Subagents launched');
    expect(titles).not.toContain('Sessions');
    expect(titles).not.toContain('Prompts');
    expect(titles).not.toContain('Avg turn');
    expect(titles).not.toContain('Web searches');
    expect(titles).not.toContain('Office');
    expect(titles).not.toContain('Cache reads');
    expect(titles).not.toContain('Cache writes');
    // tracking-since is always present
    expect(titles).toContain('Tracking since');
  });

  it('shortens top-model names, stripping the claude- prefix and date suffix', () => {
    const stats = baseStats({
      tokensByModel: {
        'claude-sonnet-4-5-20250929': { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
        'claude-haiku-4-5-20251001': { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 },
      },
    });
    const top = tvPages(stats).find((p) => p.title === 'Top models')!;
    expect(top.value).toBe('sonnet-4-5');
    expect(top.sub).toBe('haiku-4-5');
  });

  it('computes cache hit rate as cacheRead / (input + cacheRead + cacheCreation)', () => {
    const stats = baseStats({
      tokensByModel: {
        m: { input: 100, output: 0, cacheRead: 300, cacheCreation: 100 },
      },
    });
    const page = tvPages(stats).find((p) => p.title === 'Cache reads')!;
    expect(page.value).toBe('300');
    // 300 / (100 + 300 + 100) = 60%
    expect(page.sub).toBe('60% cache hit rate');
  });

  it('skips the cost page when no model family matches', () => {
    const stats = baseStats({
      tokensByModel: { unknownmodel: { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 } },
    });
    expect(tvPages(stats).find((p) => p.title === 'Est. cost (all time)')).toBeUndefined();
  });

  it('includes the cost page when a model family matches', () => {
    const stats = baseStats({
      tokensByModel: { 'claude-sonnet-4-5': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 } },
    });
    const page = tvPages(stats).find((p) => p.title === 'Est. cost (all time)')!;
    expect(page.value).toBe('$18.00');
  });

  it('reports the busiest hour in 12-hour format', () => {
    const stats = baseStats({ prompts: 5, hourCounts: { '15': 3, '9': 2 } });
    const page = tvPages(stats).find((p) => p.title === 'Prompts')!;
    expect(page.sub).toBe('3 PM is peak hour');
  });

  it('skips the prompts sub when hourCounts is empty', () => {
    const stats = baseStats({ prompts: 5, hourCounts: {} });
    const page = tvPages(stats).find((p) => p.title === 'Prompts')!;
    expect(page.sub).toBeUndefined();
  });

  it('always includes tracking-since when stats exist', () => {
    const stats = baseStats();
    const page = tvPages(stats).find((p) => p.title === 'Tracking since')!;
    expect(page.value).toBe('3 days');
  });
});

describe('tvContent', () => {
  it('shows a warming-up placeholder for null stats', () => {
    const c = tvContent(null, 0);
    expect(c.page.title).toBe('CLAUDE STATS');
    expect(c.page.sub).toBe('warming up');
    expect(c.pageCount).toBe(1);
  });

  it('wraps pageIndex around the page count via modulo', () => {
    const stats = baseStats({ prompts: 1 }); // prompts + tracking-since => 2 pages
    const pages = tvPages(stats);
    expect(pages.length).toBe(2);
    const c0 = tvContent(stats, 0);
    const c2 = tvContent(stats, 2);
    expect(c2.page).toEqual(c0.page);
    expect(c2.pageNum).toBe(c0.pageNum);
  });
});

describe('tvPageIndex', () => {
  it('follows the clock page when not focused', () => {
    expect(tvPageIndex(7, null, 0)).toBe(7);
  });

  it('freezes at the focus-entry base page while focused', () => {
    expect(tvPageIndex(9, 7, 0)).toBe(7);
  });

  it('offsets from the base by focusScroll while focused', () => {
    expect(tvPageIndex(9, 7, 3)).toBe(10);
    expect(tvPageIndex(9, 7, -2)).toBe(5);
  });

  it('may go negative — tvContent wraps it modulo the page list', () => {
    expect(tvPageIndex(0, 0, -1)).toBe(-1);
    const stats = baseStats({ prompts: 1 }); // 2 pages
    expect(tvContent(stats, -1).pageNum).toBe(2);
  });
});
