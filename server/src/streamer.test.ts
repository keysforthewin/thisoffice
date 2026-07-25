import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreenStreamer, BASE_LINES_PER_TICK, MAX_LINES_PER_TICK, MAX_QUEUE_LINES, BOOST_FACTOR, IMAGE_HOLD_MS, DRAIN_HOLD_MS, type StreamerHooks } from './streamer.ts';
import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';

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
    expect(drained).toEqual([]); // cooldown: the screen stays occupied briefly
    expect(s.isDraining('emp-1')).toBe(true);
    vi.advanceTimersByTime(DRAIN_HOLD_MS + 150);
    expect(drained).toEqual(['emp-1']);
    expect(s.isDraining('emp-1')).toBe(false);
  });

  it('caps the ratcheted rate so big backlogs still emit one line at a time', () => {
    const s = new ScreenStreamer(hooks, 150);
    const total = 500;
    s.enqueue('emp-1', Array.from({ length: total }, (_, i) => `line ${i}`).join('\n'));
    // 500 lines would ratchet to 0.83 lines/tick; the cap holds it at MAX_LINES_PER_TICK
    vi.advanceTimersByTime(150 * 100);
    const chunks = emitted.map((e) => e.text.split('\n').length);
    expect(Math.max(...chunks)).toBe(1); // never more than one line per tick
    const perSec = emitted.flatMap((e) => e.text.split('\n')).length / 15;
    expect(perSec).toBeLessThanOrEqual(MAX_LINES_PER_TICK / 0.15 + 0.1); // ≈3 lines/s
  });

  it('bounds the queue: a giant dump drops its oldest lines past MAX_QUEUE_LINES', () => {
    const s = new ScreenStreamer(hooks, 150);
    const total = 3000;
    s.enqueue('emp-1', Array.from({ length: total }, (_, i) => `line ${i}`).join('\n'));
    vi.advanceTimersByTime(150 * Math.ceil(1 / MAX_LINES_PER_TICK));
    expect(emitted[0].text).toBe('…'); // truncation marker streams first
    // drains in a bounded time even though 3000 lines were enqueued
    vi.advanceTimersByTime((MAX_QUEUE_LINES / (MAX_LINES_PER_TICK / 0.15)) * 1000 + DRAIN_HOLD_MS + 2000);
    expect(s.isDraining('emp-1')).toBe(false);
    const lines = emitted.flatMap((e) => e.text.split('\n'));
    expect(lines[lines.length - 1]).toBe(`line ${total - 1}`); // tail preserved
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
    vi.advanceTimersByTime(DRAIN_HOLD_MS + 150);
    expect(drained).toEqual(['emp-1']); // one drain, at the true end
  });

  it('new content during the drain cooldown cancels it and resumes streaming', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a');
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK)); // 'a' out, cooldown starts
    expect(drained).toEqual([]);
    s.enqueue('emp-1', 'b'); // task continues on the same screen
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    expect(emitted.flatMap((e) => e.text.split('\n'))).toEqual(['a', 'b']);
    vi.advanceTimersByTime(DRAIN_HOLD_MS + 150);
    expect(drained).toEqual(['emp-1']); // still exactly one drain
  });

  it('stops its interval when all queues are empty and restarts on enqueue', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', 'a');
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK) + DRAIN_HOLD_MS + 150);
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
    s.setPressure(2); // 3× speed: accrual 0.1 * 3 = 0.3 lines/tick
    vi.advanceTimersByTime(150 * 4);
    const emittedSoFar = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(emittedSoFar).toBe(1); // floor(0.3*4) = 1
    vi.advanceTimersByTime(150 * 110 + DRAIN_HOLD_MS); // 30 lines at 0.3/tick = 100 ticks + cooldown
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
    s.setBoost(true); // 0.1 * BOOST_FACTOR = 0.4 lines/tick (under the cap)
    const boostedRate = Math.min(BASE_LINES_PER_TICK * BOOST_FACTOR, MAX_LINES_PER_TICK);
    vi.advanceTimersByTime(150 * Math.ceil(1 / boostedRate));
    const boostedCount = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(boostedCount).toBe(1); // 0.6 lines/tick over 2 ticks -> floor(1.2) = 1
    s.setBoost(false);
    const beforeUnboost = emitted.flatMap((e) => e.text.split('\n')).length;
    vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
    const afterUnboost = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(afterUnboost).toBeGreaterThan(beforeUnboost); // still moving, but at the slower base rate
  });

  it('boost stacked with pressure is clamped to the rate cap', () => {
    const s = new ScreenStreamer(hooks, 150);
    s.enqueue('emp-1', Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'));
    s.setPressure(1); // ×2
    s.setBoost(true); // ×BOOST_FACTOR on top: 0.1 * 2 * 4 = 0.8 → capped at MAX_LINES_PER_TICK
    vi.advanceTimersByTime(150 * 10);
    const total = emitted.flatMap((e) => e.text.split('\n')).length;
    expect(total).toBe(Math.floor(MAX_LINES_PER_TICK * 10)); // 4, not 8
    expect(Math.max(...emitted.map((e) => e.text.split('\n').length))).toBe(1);
  });

  describe('image dwell', () => {
    const IMG = `${MONITOR_IMAGE_MARKER}data:image/png;base64,AAAA`;

    it('holds 5s at the image line before resuming', () => {
      const s = new ScreenStreamer(hooks, 150);
      s.enqueue('emp-1', ['a', IMG, 'b', 'c'].join('\n'));
      const ticksPerLine = Math.ceil(1 / BASE_LINES_PER_TICK);
      vi.advanceTimersByTime(150 * ticksPerLine * 2); // 'a' then IMG
      expect(emitted.map((e) => e.text)).toEqual(['a', IMG]);
      // held: nothing more for 5s
      vi.advanceTimersByTime(IMAGE_HOLD_MS - 300);
      expect(emitted).toHaveLength(2);
      expect(s.isDraining('emp-1')).toBe(true);
      // resumes after the hold
      vi.advanceTimersByTime(300 + 150 * (ticksPerLine + 1));
      expect(emitted.length).toBeGreaterThan(2);
    });

    it('defers drained() until the hold expires when the image is last', () => {
      const s = new ScreenStreamer(hooks, 150);
      s.enqueue('emp-1', IMG);
      vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK));
      expect(emitted.map((e) => e.text)).toEqual([IMG]);
      expect(drained).toEqual([]);                    // not yet
      expect(s.isDraining('emp-1')).toBe(true);       // employee stays working
      vi.advanceTimersByTime(IMAGE_HOLD_MS + 300);
      expect(drained).toEqual(['emp-1']);
      expect(s.isDraining('emp-1')).toBe(false);
    });

    it('a non-image line only waits out the normal drain cooldown', () => {
      const s = new ScreenStreamer(hooks, 150);
      s.enqueue('emp-1', 'plain');
      vi.advanceTimersByTime(150 * Math.ceil(1 / BASE_LINES_PER_TICK) + DRAIN_HOLD_MS + 150);
      expect(drained).toEqual(['emp-1']);
    });
  });
});
