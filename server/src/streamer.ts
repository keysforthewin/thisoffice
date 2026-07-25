/**
 * Paces screen content so monitors "type" instead of dumping.
 *
 * Per-employee FIFO of lines; a shared ticker emits about a line per second,
 * scaling with backlog so any queue drains in ≤ ~90s (backlog/RATCHET_TICKS
 * lines per tick). The server owns pacing so it authoritatively knows when a
 * screen is still busy streaming — that drives employee assignment. A
 * separate `boost` flag (set by the office when staffing hits max) multiplies
 * everything on top of the backlog ratchet, so a boosted office under
 * pressure is even faster.
 */

import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';

export const BASE_LINES_PER_TICK = 0.15; // 1 line/sec at 150ms ticks (was 0.5 ≈ 3.3/s)
export const RATCHET_TICKS = 600; // bursts drain in ≤ ~90s (was 300 → 45s)
export const BOOST_FACTOR = 4; // at max staffing: 0.6 lines/tick ≈ 4 lines/s

/** A screenshot stays on screen this long — the employee "examines" it. */
export const IMAGE_HOLD_MS = 5000;

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
  /** if set, the employee is viewing an image and we hold emissions until this time */
  holdUntil?: number;
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
    q.rate = Math.max(q.rate, q.lines.length / RATCHET_TICKS);
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
        if (now < q.holdUntil) continue;          // dwell on the screenshot
        q.holdUntil = undefined;
        if (q.lines.length === 0) {
          this.queues.delete(id);
          this.hooks.drained(id);
          continue;
        }
      }
      q.acc += Math.max(BASE_LINES_PER_TICK, q.rate) * (1 + this.pressure) * (this.boost ? BOOST_FACTOR : 1);
      let n = Math.min(q.lines.length, Math.floor(q.acc));
      // an image line ends its chunk: emit up to and including it, then hold
      const imgIdx = q.lines.slice(0, n).findIndex((l) => l.startsWith(MONITOR_IMAGE_MARKER));
      if (imgIdx !== -1) n = imgIdx + 1;
      if (n > 0) {
        q.acc -= n;
        const chunk = q.lines.splice(0, n);
        this.hooks.emit(id, chunk.join('\n'));
        if (chunk[chunk.length - 1].startsWith(MONITOR_IMAGE_MARKER)) {
          q.holdUntil = now + IMAGE_HOLD_MS;
          continue;                                // drained() waits out the hold
        }
      }
      if (q.lines.length === 0) {
        this.queues.delete(id);
        this.hooks.drained(id);
      }
    }
    if (this.queues.size === 0) this.stop();
  }
}
