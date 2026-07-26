import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatsAggregator } from './stats.ts';
import { estCostUSD } from '../../shared/pricing.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-'));
  file = path.join(dir, 'usage.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('StatsAggregator.recordUsage cumulative dedupe', () => {
  it('folds three cumulative snapshots of the same msgId into one total', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', 'claude-sonnet-4', { output_tokens: 10 });
    s.recordUsage('m1', 'claude-sonnet-4', { output_tokens: 50 });
    s.recordUsage('m1', 'claude-sonnet-4', { output_tokens: 80 });
    expect(s.snapshot().tokensByModel['claude-sonnet-4'].output).toBe(80);
  });

  it('sums two distinct msgIds normally', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', 'claude-sonnet-4', { output_tokens: 30 });
    s.recordUsage('m2', 'claude-sonnet-4', { output_tokens: 20 });
    expect(s.snapshot().tokensByModel['claude-sonnet-4'].output).toBe(50);
  });

  it('replayed identical usage adds 0', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', 'claude-sonnet-4', { output_tokens: 40 });
    s.recordUsage('m1', 'claude-sonnet-4', { output_tokens: 40 });
    expect(s.snapshot().tokensByModel['claude-sonnet-4'].output).toBe(40);
  });

  it('no-ops on missing usage or msgId', () => {
    const s = new StatsAggregator(file);
    s.recordUsage(undefined, 'claude-sonnet-4', { output_tokens: 40 });
    s.recordUsage('m1', 'claude-sonnet-4', undefined);
    expect(Object.keys(s.snapshot().tokensByModel)).toHaveLength(0);
  });
});

describe('StatsAggregator model bucketing', () => {
  it('accumulates two models separately', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', 'claude-opus-4', { input_tokens: 100 });
    s.recordUsage('m2', 'claude-haiku-4', { input_tokens: 5 });
    const snap = s.snapshot();
    expect(snap.tokensByModel['claude-opus-4'].input).toBe(100);
    expect(snap.tokensByModel['claude-haiku-4'].input).toBe(5);
  });

  it('skips model <synthetic>', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', '<synthetic>', { input_tokens: 100 });
    expect(Object.keys(s.snapshot().tokensByModel)).toHaveLength(0);
  });

  it('buckets undefined model as unknown', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', undefined, { input_tokens: 7 });
    expect(s.snapshot().tokensByModel['unknown'].input).toBe(7);
  });
});

describe('StatsAggregator server_tool_use deltas', () => {
  it('folds web search/fetch deltas cumulatively', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', 'claude-sonnet-4', { server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 } });
    s.recordUsage('m1', 'claude-sonnet-4', { server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 } });
    const snap = s.snapshot();
    expect(snap.webSearches).toBe(3);
    expect(snap.webFetches).toBe(2);
  });
});

describe('StatsAggregator subagent counting', () => {
  it('counts Task tool calls as subagents', () => {
    const s = new StatsAggregator(file);
    s.recordTool('Task');
    expect(s.snapshot().subagents).toBe(1);
  });

  it('counts Agent tool calls as subagents too (mirrors transcript.ts isTask)', () => {
    const s = new StatsAggregator(file);
    s.recordTool('Agent');
    s.recordTool('Agent');
    expect(s.snapshot().subagents).toBe(2);
  });

  it('does not count unrelated tool names as subagents', () => {
    const s = new StatsAggregator(file);
    s.recordTool('Bash');
    s.recordTool('Read');
    expect(s.snapshot().subagents).toBe(0);
  });
});

describe('StatsAggregator replay dedupe (resume/fork copies prior history into a new file)', () => {
  it('counts a tool_use id once even if recordTool is called twice with the same id', () => {
    const s = new StatsAggregator(file);
    s.recordTool('Bash', 'toolu_1');
    s.recordTool('Bash', 'toolu_1');
    expect(s.snapshot().toolCalls['Bash']).toBe(1);
  });

  it('dedupes a replayed tool_use id across a persistence round-trip', () => {
    const s1 = new StatsAggregator(file);
    s1.recordTool('Task', 'toolu_replay');
    s1.flush();

    const s2 = new StatsAggregator(file);
    s2.recordTool('Task', 'toolu_replay');
    expect(s2.snapshot().toolCalls['Task']).toBe(1);
    expect(s2.snapshot().subagents).toBe(1);
  });

  it('still counts distinct tool_use ids for the same tool name', () => {
    const s = new StatsAggregator(file);
    s.recordTool('Bash', 'toolu_a');
    s.recordTool('Bash', 'toolu_b');
    expect(s.snapshot().toolCalls['Bash']).toBe(2);
  });

  it('counts a tool call without an id (no dedupe possible)', () => {
    const s = new StatsAggregator(file);
    s.recordTool('Bash');
    s.recordTool('Bash');
    expect(s.snapshot().toolCalls['Bash']).toBe(2);
  });

  it('counts a prompt uuid once even when replayed', () => {
    const s = new StatsAggregator(file);
    s.recordPrompt('prompt-uuid-1');
    s.recordPrompt('prompt-uuid-1');
    expect(s.snapshot().prompts).toBe(1);
  });

  it('dedupes a replayed prompt uuid across a persistence round-trip', () => {
    const s1 = new StatsAggregator(file);
    s1.recordPrompt('prompt-uuid-2');
    s1.flush();

    const s2 = new StatsAggregator(file);
    s2.recordPrompt('prompt-uuid-2');
    expect(s2.snapshot().prompts).toBe(1);
  });

  it('counts a turn uuid once even when replayed', () => {
    const s = new StatsAggregator(file);
    s.recordTurn(1000, 'turn-uuid-1');
    s.recordTurn(1000, 'turn-uuid-1');
    expect(s.snapshot().turns).toBe(1);
    expect(s.snapshot().turnMsTotal).toBe(1000);
  });

  it('dedupes a replayed turn uuid across a persistence round-trip', () => {
    const s1 = new StatsAggregator(file);
    s1.recordTurn(2000, 'turn-uuid-2');
    s1.flush();

    const s2 = new StatsAggregator(file);
    s2.recordTurn(2000, 'turn-uuid-2');
    expect(s2.snapshot().turns).toBe(1);
  });
});

describe('StatsAggregator.recordHeadcount dirty tracking', () => {
  it('marks dirty when headcount rises above the current peak', () => {
    const s = new StatsAggregator(file);
    s.flush();
    expect(s.isDirty()).toBe(false);
    s.recordHeadcount(3);
    expect(s.isDirty()).toBe(true);
    expect(s.snapshot().peakHeadcount).toBe(3);
  });

  it('does not mark dirty when the headcount repeats', () => {
    const s = new StatsAggregator(file);
    s.recordHeadcount(5);
    s.flush();
    expect(s.isDirty()).toBe(false);

    s.recordHeadcount(5); // same value
    expect(s.isDirty()).toBe(false);
  });

  it('tracks the live headcount downward while the peak only rises', () => {
    const s = new StatsAggregator(file);
    s.recordHeadcount(5);
    s.flush();
    s.recordHeadcount(2); // below peak, but the live count moved
    expect(s.isDirty()).toBe(true);
    expect(s.snapshot().headcount).toBe(2);
    expect(s.snapshot().peakHeadcount).toBe(5);
  });
});

describe('StatsAggregator byDay', () => {
  it('records tokens/toolCalls/prompts for today', () => {
    const s = new StatsAggregator(file);
    s.recordUsage('m1', 'claude-sonnet-4', { input_tokens: 10, output_tokens: 5 });
    s.recordTool('Bash');
    s.recordPrompt();
    const today = new Date().toISOString().slice(0, 10);
    const bucket = s.snapshot().byDay[today];
    expect(bucket.tokens).toBe(15);
    expect(bucket.toolCalls).toBe(1);
    expect(bucket.prompts).toBe(1);
  });

  it('prunes byDay keys older than 30 days on write', () => {
    const s = new StatsAggregator(file);
    s.recordPrompt();
    // inject a stale key directly via flush/load round trip
    const stale = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    (s as any).stats.byDay[stale] = { tokens: 1, toolCalls: 1, prompts: 1 };
    s.recordPrompt(); // triggers pruneByDay
    expect(s.snapshot().byDay[stale]).toBeUndefined();
  });
});

describe('StatsAggregator persistence', () => {
  it('round-trips via flush + reload, preserving trackingSince', () => {
    const s1 = new StatsAggregator(file);
    const trackingSince = s1.snapshot().trackingSince;
    s1.recordUsage('m1', 'claude-sonnet-4', { input_tokens: 10, output_tokens: 5 });
    s1.recordTool('Bash');
    s1.recordPrompt();
    s1.recordSession('sess-1');
    s1.recordTurn(1234);
    s1.recordHeadcount(4);
    expect(s1.isDirty()).toBe(true);
    s1.flush();
    expect(s1.isDirty()).toBe(false);

    const s2 = new StatsAggregator(file);
    expect(s2.snapshot()).toEqual(s1.snapshot());
    expect(s2.snapshot().trackingSince).toBe(trackingSince);
  });

  it('handles restart mid-message without double counting', () => {
    const s1 = new StatsAggregator(file);
    s1.recordUsage('mA', 'claude-sonnet-4', { output_tokens: 50 });
    s1.flush();

    const s2 = new StatsAggregator(file);
    s2.recordUsage('mA', 'claude-sonnet-4', { output_tokens: 80 });
    expect(s2.snapshot().tokensByModel['claude-sonnet-4'].output).toBe(80);
  });

  it('dedupes sessions across restart', () => {
    const s1 = new StatsAggregator(file);
    s1.recordSession('s1');
    s1.recordSession('s1');
    s1.flush();

    const s2 = new StatsAggregator(file);
    s2.recordSession('s1');
    expect(s2.snapshot().sessions).toBe(1);
  });

  it('starts fresh without throwing on a corrupt file', () => {
    fs.writeFileSync(file, '{not valid json!!');
    expect(() => new StatsAggregator(file)).not.toThrow();
    const s = new StatsAggregator(file);
    expect(s.snapshot().prompts).toBe(0);
  });
});

describe('StatsAggregator.recordGameWin', () => {
  it('counts game wins per name and persists them', () => {
    const s1 = new StatsAggregator(file);
    s1.recordGameWin('Dana');
    s1.recordGameWin('Dana');
    s1.recordGameWin('Rey');
    expect(s1.snapshot().gameWins).toEqual({ Dana: 2, Rey: 1 });
    expect(s1.isDirty()).toBe(true);
    s1.flush();

    const s2 = new StatsAggregator(file);
    expect(s2.snapshot().gameWins).toEqual({ Dana: 2, Rey: 1 });
  });

  it('ignores a blank winner name', () => {
    const s = new StatsAggregator(file);
    s.recordGameWin('   ');
    expect(s.snapshot().gameWins).toEqual({});
  });
});

describe('StatsAggregator.recordChars', () => {
  it('accumulates characters per employee name and persists them', () => {
    const s1 = new StatsAggregator(file);
    s1.recordChars('Dana', 120);
    s1.recordChars('Dana', 30);
    s1.recordChars('Rey', 5);
    expect(s1.snapshot().charsByEmployee).toEqual({ Dana: 150, Rey: 5 });
    s1.flush();

    const s2 = new StatsAggregator(file);
    expect(s2.snapshot().charsByEmployee).toEqual({ Dana: 150, Rey: 5 });
  });

  it('ignores a blank name, a zero count, and a non-finite count without dirtying', () => {
    const s = new StatsAggregator(file);
    s.recordChars('  ', 10);
    s.recordChars('Dana', 0);
    s.recordChars('Dana', Number.NaN);
    expect(s.snapshot().charsByEmployee).toEqual({});
    expect(s.isDirty()).toBe(false);
  });
});

describe('pricing.estCostUSD', () => {
  it('computes opus/sonnet family math', () => {
    const cost = estCostUSD({
      'claude-opus-4': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      'claude-sonnet-4': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
    });
    // opus: 15 + 75 = 90; sonnet: 3 + 15 = 18
    expect(cost).toBeCloseTo(108, 5);
  });

  it('includes cache read (10% of input rate) and cache creation (125% of input rate)', () => {
    const cost = estCostUSD({
      'claude-sonnet-4': { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 1_000_000 },
    });
    // cacheRead: 3 * 0.10 = 0.30; cacheCreation: 3 * 1.25 = 3.75
    expect(cost).toBeCloseTo(4.05, 5);
  });

  it('returns null when no model matched', () => {
    const cost = estCostUSD({
      unknown: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
    });
    expect(cost).toBeNull();
  });

  it('skips unknown models but sums known ones in a mixed set', () => {
    const cost = estCostUSD({
      unknown: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      'claude-haiku-4': { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(cost).toBeCloseTo(1, 5);
  });
});
