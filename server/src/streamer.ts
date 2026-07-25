/**
 * Paces screen content so monitors "type" instead of dumping.
 *
 * Per-employee FIFO of lines; a shared ticker emits a few lines per second,
 * scaling with backlog so any queue drains in ≤ ~45s (backlog/300 lines per
 * tick). The server owns pacing so it authoritatively knows when a screen is
 * still busy streaming — that drives employee assignment.
 */

export interface StreamerHooks {
  emit(employeeId: string, text: string): void;
  drained(employeeId: string): void;
}

interface Queue {
  lines: string[];
  /** fractional lines accrued but not yet emitted */
  acc: number;
  /** lines per tick; ratcheted up at enqueue time so a burst drains in ≤ ~45s */
  rate: number;
}

export class ScreenStreamer {
  private queues = new Map<string, Queue>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private hooks: StreamerHooks,
    private tickMs = 150,
  ) {}

  enqueue(employeeId: string, text: string) {
    if (!text) return;
    const q = this.queues.get(employeeId) ?? { lines: [], acc: 0, rate: 0 };
    q.lines.push(...text.split('\n'));
    q.rate = Math.max(q.rate, q.lines.length / 300);
    this.queues.set(employeeId, q);
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  isDraining(employeeId: string): boolean {
    return this.queues.has(employeeId);
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
    for (const [id, q] of this.queues) {
      q.acc += Math.max(0.5, q.rate);
      const n = Math.min(q.lines.length, Math.floor(q.acc));
      if (n > 0) {
        q.acc -= n;
        this.hooks.emit(id, q.lines.splice(0, n).join('\n'));
      }
      if (q.lines.length === 0) {
        this.queues.delete(id);
        this.hooks.drained(id);
      }
    }
    if (this.queues.size === 0) this.stop();
  }
}
