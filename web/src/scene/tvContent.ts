import type { UsageStats } from '../../../shared/types.ts';
import { estCostUSD } from '../../../shared/pricing.ts';

/** Wall-mounted TV page-cycle interval — see WallTV.tsx's useFrame page index. */
export const TV_PAGE_MS = 5000;

export interface TvPage {
  title: string;
  value: string;
  sub?: string;
  /** when set, WallTV draws this chart in place of the big centered `value` */
  chart?: DowHourChart;
}

/** Token usage as [weekday 0=Mon … 6=Sun][hour 0-23], in the viewer's local zone. */
export interface DowHourChart {
  kind: 'dowHours';
  grid: number[][];
}

/** Monday-first, matching the chart's row order and legend. */
export const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** `999`, `12.4k`, `1.2M`, `3.4B` — count/token formatting shared by every page. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + 'k';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  return (n / 1_000_000_000).toFixed(1) + 'B';
}

/** `$0.42`, `$12.34` below $1,000; `$1,234` (no decimals) at/above it. */
export function formatUSD(n: number): string {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}

/** `42s`, `3m 12s`, `1h 4m`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

/** Strips the `claude-` prefix and a trailing `-YYYYMMDD` date suffix, e.g.
 *  `claude-sonnet-4-5-20250929` → `sonnet-4-5`. */
function shortModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function totalTokens(t: { input: number; output: number; cacheRead: number; cacheCreation: number }): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

/** hourCounts is bucketed in UTC (see shared/types.ts); shift into the viewer's zone,
 *  using today's offset so DST is applied as the viewer currently experiences it. */
function toLocalHour(utcHour: number): number {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.getHours();
}

function topHour(hourCounts: Record<string, number>): string | undefined {
  const entries = Object.entries(hourCounts);
  if (entries.length === 0) return undefined;
  const [hourStr] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  const hour = toLocalHour(Number(hourStr));
  const period = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${period} is peak hour`;
}

/**
 * `tokensByDowHour` is bucketed in UTC (see shared/types.ts). Shift it into the
 * viewer's zone — which, unlike the 1-D hourCounts, can also move a bucket to
 * the neighbouring weekday when the hour wraps past midnight.
 *
 * `offsetMinutes` is minutes *east* of UTC (the negation of
 * `Date.prototype.getTimezoneOffset`), defaulting to the viewer's current
 * offset so DST is applied as they experience it today. Zones on a half-hour
 * offset land between buckets; the earlier hour wins.
 *
 * Rows are Monday-first (DOW_LABELS); the incoming keys are Sunday-first.
 */
export function localDowHourGrid(
  tokensByDowHour: Record<string, number>,
  offsetMinutes = -new Date().getTimezoneOffset(),
): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const WEEK_MINUTES = 7 * 24 * 60;
  for (const [key, tokens] of Object.entries(tokensByDowHour)) {
    const [dowStr, hourStr] = key.split('-');
    const dow = Number(dowStr);
    const hour = Number(hourStr);
    if (!Number.isInteger(dow) || !Number.isInteger(hour) || dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    const minutes = (((dow * 24 + hour) * 60 + offsetMinutes) % WEEK_MINUTES + WEEK_MINUTES) % WEEK_MINUTES;
    const localDow = Math.floor(minutes / 1440); // still Sunday-first
    const localHour = Math.floor((minutes % 1440) / 60);
    grid[(localDow + 6) % 7][localHour] += tokens; // → Monday-first
  }
  return grid;
}

/** `peak Tue 09:00 · 4.2M`, or undefined when the grid is empty. */
function peakCell(grid: number[][]): string | undefined {
  let best = 0;
  let at: [number, number] | null = null;
  grid.forEach((row, d) =>
    row.forEach((v, h) => {
      if (v > best) {
        best = v;
        at = [d, h];
      }
    }),
  );
  if (!at) return undefined;
  const [d, h] = at as [number, number];
  return `peak ${DOW_LABELS[d]} ${String(h).padStart(2, '0')}:00 · ${formatTokens(best)}`;
}

/** Builds the page list: only pages whose backing stat is non-zero/non-empty are included. */
export function tvPages(stats: UsageStats | null): TvPage[] {
  if (!stats) return [];
  const pages: TvPage[] = [];

  const models = Object.entries(stats.tokensByModel);
  const totalInput = models.reduce((a, [, t]) => a + t.input, 0);
  const totalOutput = models.reduce((a, [, t]) => a + t.output, 0);
  const totalCacheRead = models.reduce((a, [, t]) => a + t.cacheRead, 0);
  const totalCacheCreation = models.reduce((a, [, t]) => a + t.cacheCreation, 0);

  // 1. Total tokens
  if (totalInput + totalOutput > 0) {
    pages.push({
      title: 'Total tokens',
      value: formatTokens(totalInput + totalOutput),
      sub: `${formatTokens(totalInput)} in · ${formatTokens(totalOutput)} out`,
    });
  }

  // 2. Tokens today
  const today = new Date().toISOString().slice(0, 10);
  const todayTokens = stats.byDay[today]?.tokens ?? 0;
  if (todayTokens > 0) {
    pages.push({ title: 'Tokens today', value: formatTokens(todayTokens) });
  }

  // 3. Top models
  if (models.length > 0) {
    const ranked = [...models].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
    const top3 = ranked.slice(0, 3).map(([model]) => shortModelName(model));
    pages.push({
      title: 'Top models',
      value: top3[0],
      sub: top3.slice(1).join(', ') || undefined,
    });
  }

  // 4. Cache reads
  if (totalCacheRead > 0) {
    const rateDenom = totalInput + totalCacheRead + totalCacheCreation;
    const rate = rateDenom > 0 ? Math.round((totalCacheRead / rateDenom) * 100) : 0;
    pages.push({ title: 'Cache reads', value: formatTokens(totalCacheRead), sub: `${rate}% cache hit rate` });
  }

  // 5. Cache writes
  if (totalCacheCreation > 0) {
    pages.push({ title: 'Cache writes', value: formatTokens(totalCacheCreation) });
  }

  // 6. Est. cost (all time)
  const cost = estCostUSD(stats.tokensByModel);
  if (cost !== null) {
    pages.push({ title: 'Est. cost (all time)', value: formatUSD(cost), sub: 'estimated from token prices' });
  }

  // 7. Tool calls
  const totalToolCalls = sum(stats.toolCalls);
  if (totalToolCalls > 0) {
    const [topTool, topCount] = Object.entries(stats.toolCalls).reduce((best, cur) =>
      cur[1] > best[1] ? cur : best,
    );
    pages.push({ title: 'Tool calls', value: String(totalToolCalls), sub: `${topTool} × ${topCount}` });
  }

  // 8. Edits & writes
  const edits = (stats.toolCalls['Edit'] ?? 0) + (stats.toolCalls['Write'] ?? 0) + (stats.toolCalls['NotebookEdit'] ?? 0);
  if (edits > 0) {
    pages.push({ title: 'Edits & writes', value: String(edits) });
  }

  // 9. Subagents launched
  if (stats.subagents > 0) {
    pages.push({ title: 'Subagents launched', value: String(stats.subagents) });
  }

  // 10. Sessions
  if (stats.sessions > 0) {
    pages.push({ title: 'Sessions', value: String(stats.sessions) });
  }

  // 11. Prompts
  if (stats.prompts > 0) {
    pages.push({ title: 'Prompts', value: String(stats.prompts), sub: topHour(stats.hourCounts) });
  }

  // 12. Avg turn
  if (stats.turns > 0) {
    pages.push({
      title: 'Avg turn',
      value: formatDuration(stats.turnMsTotal / stats.turns),
      sub: `longest ${formatDuration(stats.longestTurnMs)}`,
    });
  }

  // 13. Web searches
  const webTotal = stats.webSearches + stats.webFetches;
  if (webTotal > 0) {
    pages.push({
      title: 'Web searches',
      value: String(webTotal),
      sub: `${stats.webSearches} search · ${stats.webFetches} fetch`,
    });
  }

  // 14. Head count
  if (stats.headcount > 0 || stats.peakHeadcount > 0) {
    pages.push({
      title: 'Head count',
      value: String(stats.headcount),
      sub: `peak ${stats.peakHeadcount}`,
    });
  }

  // 15. Busiest hours — token usage by hour, stacked by weekday
  const grid = localDowHourGrid(stats.tokensByDowHour ?? {});
  const peak = peakCell(grid);
  if (peak) {
    pages.push({ title: 'Busiest hours', value: '', sub: peak, chart: { kind: 'dowHours', grid } });
  }

  // 16. Quiz champion — only once someone has actually won a round
  const wins = Object.entries(stats.gameWins ?? {});
  if (wins.length > 0) {
    const [topName, topWins] = wins.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    const total = wins.reduce((a, [, n]) => a + n, 0);
    pages.push({
      title: 'Quiz champion',
      value: topName,
      sub: `${topWins} win${topWins === 1 ? '' : 's'} · ${total} round${total === 1 ? '' : 's'} won`,
    });
  }

  // 17. Tracking since — always present when stats exist
  const days = Math.max(0, Math.round((Date.now() - Date.parse(stats.trackingSince)) / 86_400_000));
  pages.push({
    title: 'Tracking since',
    value: `${days} day${days === 1 ? '' : 's'}`,
    sub: new Date(stats.trackingSince).toLocaleDateString(),
  });

  return pages;
}

/** Wraps `pageIndex` into the page list; null/empty stats show a single "warming up" page. */
export function tvContent(stats: UsageStats | null, pageIndex: number): { page: TvPage; pageNum: number; pageCount: number } {
  const pages = tvPages(stats);
  if (pages.length === 0) {
    return { page: { title: 'CLAUDE STATS', value: '…', sub: 'warming up' }, pageNum: 1, pageCount: 1 };
  }
  const idx = ((pageIndex % pages.length) + pages.length) % pages.length;
  return { page: pages[idx], pageNum: idx + 1, pageCount: pages.length };
}

/** Displayed page index: while the TV is camera-focused (`focusedBase` set at
 *  focus entry) the clock is ignored and the wheel offset applies; result may
 *  be negative — `tvContent` wraps it modulo the page list. */
export function tvPageIndex(autoPage: number, focusedBase: number | null, focusScroll: number): number {
  return focusedBase === null ? autoPage : focusedBase + focusScroll;
}
