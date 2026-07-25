import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreenStreamer, BASE_LINES_PER_TICK, RATCHET_TICKS, BOOST_FACTOR, type StreamerHooks } from './streamer.ts';

describe('ScreenStreamer', () => {
  let emitted: Array<{ id: string; text: string }>;
  let drained: string[];
  let hooks: StreamerHooks;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    drained = [];
    hooks = {
      emit: (id, text) => emitted.push({ id, text }),
      drained: (id) => drained.push(id),
    };
  });

  afterEach(() => vi.useRealTimers());

  it(`streams small content at ~1 line every ${Math.ceil(1 / BASE_LINES_PER_TICK)} ticks`, () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a\nb\nc');
    const ticksPerLine = Math.ceil(1 / BASE_LINES_PER_TICK); // 0.15/tick -> first line at tick 7
    vi.advanceTimersByTime(150 * (ticksPerLine - 1));
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(150); // acc hits 1.0 -> 1 line
    expect(emitted).toEqual([{ id: 'emp-1', text: 'a' }]);
    vi.advanceTimersByTime(150 * ticksPerLine * 2); // plenty of ticks for the rest
    expect(emitted.map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(drained).toEqual(['emp-1']);
    expect(s.isDraining('emp-1')).toBe(false);
  });

  it('scales rate with backlog so large queues drain in ~90s', () => {
    const s = new ScreenStreamer(hooks, 150);
    const total = 3000;
    s.enqueue('emp-1', Array.from({ length: total }, (_, i) => `line ${i}`).join('\n'));
    const expectedRate = total / RATCHET_TICKS; // 3000/600 = 5 lines/tick
    vi.advanceTimersByTime(150);
    expect(emitted[0].text.split('\n')).toHaveLength(expectedRate);
    vi.advanceTimersByTime(91_000); // ≤ ~91s
    expect(s.isDraining('emp-1')).toBe(false);
    const lines = emitted.flatMap((e) => e.text.split('\n'));
    expect(lines).toHaveLength(total);
    expect(lines[0]).toBe('line 0');
    expect(lines[total - 1]).toBe(`line ${total - 1}`);
  });

  it('isDraining reflects queue state and clear() drops the queue silently', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a\nb');
    expect(s.isDraining('emp-1')).toBe(true);
    s.clear('emp-1');
    expect(s.isDraining('emp-1')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
    expect(drained).toEqual([]); // clear() is not a drain
  });

  it('appending while draining extends the same queue', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a');
    s.enqueue('emp-1', 'b');
    vi.advanceTimersByTime(150 * Math.ceil(2 / BASE_LINES_PER_TICK));
    expect(emitted.flatMap((e) => e.text.split('\n'))).toEqual(['a', 'b']);
    expect(drained).toEqual(['emp-1']); // one drain, at the true end
  });

  it('stops its interval when all queues are empty and restarts on enqueue', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a');
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    expect(vi.getTimerCount()).toBe(0); // ticker idle
    s.enqueue('emp-2', 'x');
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    expect(emitted.at(-1)).toEqual({ id: 'emp-2', text: 'x' });
  });

  it('ignores empty text', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', '');
    expect(s.isDraining('emp-1')).toBe(false);
  });

  it('pressure multiplies the drain rate', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'));
    s.setPressure(2); // 3× speed: accrual 0.15 * 3 = 0.45 lines/tick
    vi.advanceTimersByTime(150 * 3);
    const emittedSoFar = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(emittedSoFar).toBe(1); // floor(0.45*3) = 1
    vi.advanceTimersByTime(150 * 70); // 30 lines at ~0.45/tick ≈ 67 ticks total
    expect(s.isDraining('emp-1')).toBe(false);
  });

  it('negative pressure clamps to zero (baseline pace)', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.setPressure(-5);
    s.enqueue('emp-1', 'a\nb');
    vi.advanceTimersByTime(150 * Math.ceil(2 / BASE_LINES_PER_TICK)); // baseline BASE_LINES_PER_TICK/tick → both lines out
    expect(emitted.flatMap((e) => e.text.split('\n'))).toEqual(['a', 'b']);
  });

  it('setBoost multiplies the drain rate; turning it off returns to base', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'));
    s.setBoost(true); // 0.15 * BOOST_FACTOR = 0.6 lines/tick
    const boostedRate = BASE_LINES_PER_TICK * BOOST_FACTOR;
    vi.advanceTimersByTime(150 * Math.ceil(1 / boostedRate));
    const boostedCount = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(boostedCount).toBe(1); // 0.6 lines/tick over 2 ticks -> floor(1.2) = 1
    s.setBoost(false);
    const beforeUnboost = emitted.flatMap((e) => e.text.split('\n')).length;
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    const afterUnboost = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(afterUnboost).toBeGreaterThan(beforeUnboost); // still moving, but at the slower base rate
  });

  it('boost stacks with pressure', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'));
    s.setPressure(1); // ×2
    s.setBoost(true); // ×BOOST_FACTOR on top: 0.15 * 2 * 4 = 1.2 lines/tick
    vi.advanceTimersByTime(150);
    expect(emitted[0].text.split('\n')).toHaveLength(1); // floor(1.2)
    vi.advanceTimersByTime(150);
    const total = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(total).toBe(2); // acc 0.2+1.2=1.4 -> 2 more emitted... floor cumulative
  });
});
