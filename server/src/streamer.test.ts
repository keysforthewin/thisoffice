import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreenStreamer, type StreamerHooks } from './streamer.ts';

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

  it('streams small content at ~1 line every other tick', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a\nb\nc');
    vi.advanceTimersByTime(150); // acc 0.5 -> 0 lines
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(150); // acc 1.0 -> 1 line
    expect(emitted).toEqual([{ id: 'emp-1', text: 'a' }]);
    vi.advanceTimersByTime(600); // 4 more ticks -> 2 more lines, queue empties
    expect(emitted.map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(drained).toEqual(['emp-1']);
    expect(s.isDraining('emp-1')).toBe(false);
  });

  it('scales rate with backlog so large queues drain in ~45s', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
    vi.advanceTimersByTime(150); // 3000/300 = 10 lines this tick
    expect(emitted[0].text.split('\n')).toHaveLength(10);
    vi.advanceTimersByTime(46_000);
    expect(s.isDraining('emp-1')).toBe(false);
    const total = emitted.flatMap((e) => e.text.split('\n'));
    expect(total).toHaveLength(3000);
    expect(total[0]).toBe('line 0');
    expect(total[2999]).toBe('line 2999');
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
    vi.advanceTimersByTime(1200);
    expect(emitted.flatMap((e) => e.text.split('\n'))).toEqual(['a', 'b']);
    expect(drained).toEqual(['emp-1']); // one drain, at the true end
  });

  it('stops its interval when all queues are empty and restarts on enqueue', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a');
    vi.advanceTimersByTime(600);
    expect(vi.getTimerCount()).toBe(0); // ticker idle
    s.enqueue('emp-2', 'x');
    vi.advanceTimersByTime(600);
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
    s.setPressure(2); // 3× speed: accrual 0.5 * 3 = 1.5 lines/tick
    vi.advanceTimersByTime(150);
    expect(emitted[0].text.split('\n')).toHaveLength(1); // floor(1.5)
    vi.advanceTimersByTime(150);
    expect(emitted[1].text.split('\n')).toHaveLength(2); // acc 0.5+1.5 → 2 more
    vi.advanceTimersByTime(150 * 18);
    expect(s.isDraining('emp-1')).toBe(false); // 30 lines at ~1.5/tick ≈ 20 ticks
  });

  it('negative pressure clamps to zero (baseline pace)', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.setPressure(-5);
    s.enqueue('emp-1', 'a\nb');
    vi.advanceTimersByTime(300); // 2 ticks at baseline 0.5/tick → 1 line
    expect(emitted).toHaveLength(1);
  });
});
