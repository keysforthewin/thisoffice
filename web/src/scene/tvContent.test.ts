import { describe, expect, it, vi } from 'vitest';
import type { UsageStats } from '../../../shared/types.ts';
import {
  formatDuration,
  formatTokens,
  formatUSD,
  localDowHourGrid,
  tvContent,
  tvPageIndex,
  tvPages,
  topEmployees,
  type DowHourChart,
} from './tvContent.ts';

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
    headcount: 0,
    byDay: {},
    hourCounts: {},
    tokensByDowHour: {},
    gameWins: {},
    charsByEmployee: {},
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
    expect(titles).not.toContain('Head count');
    expect(titles).not.toContain('Busiest hours');
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

  it('reports the busiest hour in 12-hour format, converted to the local zone', () => {
    // buckets are UTC; the expected label follows whatever zone the test host is in
    const local = new Date();
    local.setUTCHours(15, 0, 0, 0);
    const h = local.getHours();
    const expected = `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'} is peak hour`;

    const stats = baseStats({ prompts: 5, hourCounts: { '15': 3, '9': 2 } });
    const page = tvPages(stats).find((p) => p.title === 'Prompts')!;
    expect(page.sub).toBe(expected);
  });

  it('shifts the UTC bucket into the local zone', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Toronto';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T02:00:00Z')); // EDT, UTC-4
    try {
      const stats = baseStats({ prompts: 5, hourCounts: { '1': 3 } });
      const page = tvPages(stats).find((p) => p.title === 'Prompts')!;
      expect(page.sub).toBe('9 PM is peak hour');
    } finally {
      vi.useRealTimers();
      process.env.TZ = tz;
    }
  });

  it('skips the prompts sub when hourCounts is empty', () => {
    const stats = baseStats({ prompts: 5, hourCounts: {} });
    const page = tvPages(stats).find((p) => p.title === 'Prompts')!;
    expect(page.sub).toBeUndefined();
  });

  it('shows the live head count, not lifetime hires', () => {
    const stats = baseStats({ headcount: 4, peakHeadcount: 9 });
    const page = tvPages(stats).find((p) => p.title === 'Head count')!;
    expect(page.value).toBe('4');
    expect(page.sub).toBe('peak 9');
  });

  it('still shows the head-count page for an empty office that once had staff', () => {
    const titles = tvPages(baseStats({ headcount: 0, peakHeadcount: 3 })).map((p) => p.title);
    expect(titles).toContain('Head count');
  });

  it('builds the busiest-hours chart page from the dow/hour grid', () => {
    const stats = baseStats({ tokensByDowHour: { '2-9': 4_200_000 } }); // Tue 09:00 UTC
    const page = tvPages(stats).find((p) => p.title === 'Busiest hours')!;
    expect(page.chart?.kind).toBe('dowHours');
    const chart = page.chart as DowHourChart;
    expect(chart.grid).toHaveLength(7);
    expect(chart.grid[0]).toHaveLength(24);
    expect(page.sub).toMatch(/^peak \w{3} \d\d:00 · 4\.2M$/);
  });

  it('always includes tracking-since when stats exist', () => {
    const stats = baseStats();
    const page = tvPages(stats).find((p) => p.title === 'Tracking since')!;
    expect(page.value).toBe('3 days');
  });

  it('shows a quiz champion page once someone has won', () => {
    const pages = tvPages(baseStats({ gameWins: { Dana: 3, Rey: 1 } }));
    const page = pages.find((p) => p.title === 'Quiz champion');
    expect(page).toBeDefined();
    expect(page!.value).toBe('Dana');
    expect(page!.sub).toBe('3 wins · 4 rounds won');
  });

  it('omits the champion page when nobody has won', () => {
    expect(tvPages(baseStats({ gameWins: {} })).some((p) => p.title === 'Quiz champion')).toBe(false);
  });

  it('pluralises a single win', () => {
    const page = tvPages(baseStats({ gameWins: { Rey: 1 } })).find((p) => p.title === 'Quiz champion');
    expect(page!.sub).toBe('1 win · 1 round won');
  });

  it('tolerates stats from a server without gameWins', () => {
    const stats = baseStats({});
    delete (stats as { gameWins?: unknown }).gameWins;
    expect(() => tvPages(stats)).not.toThrow();
  });

  it('tolerates stats from a server without charsByEmployee', () => {
    const stats = baseStats({});
    delete (stats as { charsByEmployee?: unknown }).charsByEmployee;
    expect(() => tvPages(stats)).not.toThrow();
    expect(tvPages(stats).some((p) => p.title === 'Busiest desks')).toBe(false);
  });
});

describe('topEmployees', () => {
  it('ranks by characters, largest first, and breaks ties by name', () => {
    expect(topEmployees({ Rey: 10, Dana: 50, Ash: 10 })).toEqual([
      { label: 'Dana', value: 50 },
      { label: 'Ash', value: 10 },
      { label: 'Rey', value: 10 },
    ]);
  });

  it('keeps only the top 5 and drops blank names and zero counts', () => {
    const many = { A: 9, B: 8, C: 7, D: 6, E: 5, F: 4, '': 100, Z: 0 };
    expect(topEmployees(many).map((s) => s.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('is empty for an office that has streamed nothing', () => {
    expect(topEmployees({})).toEqual([]);
  });
});

describe('the busiest-desks page', () => {
  it('carries the top-5 pie and the office-wide character total', () => {
    const pages = tvPages(baseStats({ charsByEmployee: { Dana: 300, Rey: 100 } }));
    const page = pages.find((p) => p.title === 'Busiest desks')!;
    expect(page.chart).toEqual({ kind: 'pie', slices: [{ label: 'Dana', value: 300 }, { label: 'Rey', value: 100 }] });
    expect(page.sub).toBe('400 chars');
  });

  it('shows what share the visible five cover once the tail is truncated', () => {
    const stats = baseStats({ charsByEmployee: { A: 100, B: 100, C: 100, D: 100, E: 100, F: 500 } });
    const page = tvPages(stats).find((p) => p.title === 'Busiest desks')!;
    // F is the largest, so the shown five are F + four 100s = 900 of 1000
    expect(page.sub).toBe('1.0k chars · top 5 = 90%');
  });

  it('is absent until something has actually streamed', () => {
    expect(tvPages(baseStats()).some((p) => p.title === 'Busiest desks')).toBe(false);
  });
});

describe('localDowHourGrid', () => {
  it('puts a UTC bucket on the matching Monday-first row when the zone is UTC', () => {
    const grid = localDowHourGrid({ '2-9': 100 }, 0); // Tuesday 09:00
    expect(grid[1][9]).toBe(100); // row 1 = Tue
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('rolls back a day when the local shift crosses midnight backwards', () => {
    // Tue 01:00 UTC in UTC-4 is Mon 21:00
    const grid = localDowHourGrid({ '2-1': 50 }, -240);
    expect(grid[0][21]).toBe(50);
  });

  it('rolls forward a day when the local shift crosses midnight forwards', () => {
    // Sun 23:00 UTC in UTC+2 is Mon 01:00 — and Sunday is the last row, so it wraps
    const grid = localDowHourGrid({ '0-23': 7 }, 120);
    expect(grid[0][1]).toBe(7);
  });

  it('sums collisions and ignores malformed keys', () => {
    const grid = localDowHourGrid({ '2-9': 3, '9-9': 100, 'x-1': 5, '2-99': 7 }, 0);
    expect(grid[1][9]).toBe(3);
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(3);
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
