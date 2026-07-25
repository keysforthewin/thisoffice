/**
 * Paces screen content so monitors "type" instead of dumping.
 *
 * Per-employee FIFO of lines; a shared ticker emits well under a line per
 * second at base, scaling with backlog/pressure/boost but hard-capped at
 * MAX_LINES_PER_TICK so a screen always types one line at a time and never
 * dumps. Oversized bursts are truncated to MAX_QUEUE_LINES (oldest dropped
 * behind a '…'). The server owns pacing so it authoritatively knows when a
 * screen is still busy streaming — that drives employee assignment. After a
 * queue empties the screen stays "occupied" for DRAIN_HOLD_MS so back-to-back
 * tasks fan out to other employees instead of piling onto the first chair.
 */

import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';

export const BASE_LINES_PER_TICK = 0.1; // ~0.67 lines/sec at 150ms ticks
export const RATCHET_TICKS = 600; // backlog ratchet target (capped below)
export const BOOST_FACTOR = 4; // at max staffing (still subject to the cap)
/** Hard ceiling after all multipliers: ~3 lines/sec, one line per tick — never a dump. */
export const MAX_LINES_PER_TICK = 0.45;
/** Bound per-screen backlog so a capped rate can't occupy an employee for many minutes. */
export const MAX_QUEUE_LINES = 600;

/** A screenshot stays on screen this long — the employee "examines" it. */
export const IMAGE_HOLD_MS = 5000;
/** After a screen drains it stays occupied this long, so the next task lands on someone else. */
export const DRAIN_HOLD_MS = 2000;

export interface StreamerHooks {
  emit(employeeId: string, text: string): void;
  drained(employeeId: string): void;
}

interface Queue {
  lines: string[];
  /** fractional lines accrued but not yet emitted */
  acc: number;
  /** lines per tick; ratcheted up at enqueue time so a burst drains in ≤ ~90s */
  rate: number;
  /** if set, emissions pause until this time (image dwell or post-drain cooldown) */
  holdUntil?: number;
  /** an image hold must run its course; a drain cooldown is cancelled by new content */
  imageHold?: boolean;
}

export class ScreenStreamer {
  private queues = new Map<string, Queue>();
  private timer: NodeJS.Timeout | null = null;
  private pressure = 0;
  private boost = false;

  constructor(
    private hooks: StreamerHooks,
    private tickMs = 150,
  ) {}

  enqueue(employeeId: string, text: string) {
    if (!text) return;
    const q = this.queues.get(employeeId) ?? { lines: [], acc: 0, rate: 0 };
    q.lines.push(...text.split('\n'));
    if (q.lines.length > MAX_QUEUE_LINES) q.lines.splice(0, q.lines.length - MAX_QUEUE_LINES, '…');
    q.rate = Math.max(q.rate, q.lines.length / RATCHET_TICKS);
    if (q.holdUntil !== undefined && !q.imageHold) q.holdUntil = undefined; // task continued: cancel the drain cooldown
    this.queues.set(employeeId, q);
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  isDraining(employeeId: string): boolean {
    return this.queues.has(employeeId);
  }

  /** Backlog pressure from the office work queue: N waiting jobs → screens drain (1+N)× faster. */
  setPressure(n: number) {
    this.pressure = Math.max(0, n);
  }

  /** Office hit max staffing: every screen kicks into high gear (multiplies on top of pressure). */
  setBoost(on: boolean) {
    this.boost = on;
  }

  /** Drop an employee's queue without a drained() callback (employee removed). */
  clear(employeeId: string) {
    this.queues.delete(employeeId);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const now = Date.now();
    for (const [id, q] of this.queues) {
      if (q.holdUntil !== undefined) {
        if (now < q.holdUntil) continue;          // dwell (screenshot or drain cooldown)
        q.holdUntil = undefined;
        q.imageHold = false;
        if (q.lines.length === 0) {
          this.queues.delete(id);
          this.hooks.drained(id);
          continue;
        }
      }
      q.acc += Math.min(
        MAX_LINES_PER_TICK,
        Math.max(BASE_LINES_PER_TICK, q.rate) * (1 + this.pressure) * (this.boost ? BOOST_FACTOR : 1),
      );
      let n = Math.min(q.lines.length, Math.floor(q.acc + 1e-9)); // epsilon: 10 × 0.1 sums below 1.0
      // an image line ends its chunk: emit up to and including it, then hold
      const imgIdx = q.lines.slice(0, n).findIndex((l) => l.startsWith(MONITOR_IMAGE_MARKER));
      if (imgIdx !== -1) n = imgIdx + 1;
      if (n > 0) {
        q.acc -= n;
        const chunk = q.lines.splice(0, n);
        this.hooks.emit(id, chunk.join('\n'));
        if (chunk[chunk.length - 1].startsWith(MONITOR_IMAGE_MARKER)) {
          q.holdUntil = now + IMAGE_HOLD_MS;
          q.imageHold = true;
          continue;                                // drained() waits out the hold
        }
      }
      // drained, but keep the screen occupied briefly so the next task spreads out
      if (q.lines.length === 0) q.holdUntil = now + DRAIN_HOLD_MS;
    }
    if (this.queues.size === 0) this.stop();
  }
}
