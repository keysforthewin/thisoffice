# Full-Fidelity Streaming Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream everything a Claude Code session produces (tool results, thinking, main-Claude replies) to employee screens with a typewriter effect, no truncation, and employees that stay busy until their screen drains.

**Architecture:** A new server-side `ScreenStreamer` holds a per-employee FIFO of lines and a ~150 ms ticker that emits `monitor` append chunks at an adaptive rate (baseline ~3 lines/sec, scaling so any backlog drains in ≤ ~45 s). `Transcripts` routes all screen content through it instead of calling `office.monitor({append})` directly; `Office` learns to treat a still-streaming employee as busy and to defer the idle transition until drain. Spec: `docs/superpowers/specs/2026-07-24-streaming-screens-design.md`.

**Tech Stack:** Node 22+ ESM TypeScript run with type-stripping (imports use explicit `.ts` extensions), vitest (root `vitest.config.mjs`, `globals: true`, tests colocated as `server/src/*.test.ts`), no new dependencies.

## Global Constraints

- No `truncate()` / char caps anywhere in the screen-content path. (Inbox preview truncation in `onUserPrompt` stays — it's a UI list, not a screen.)
- All screen content lines flow through `ScreenStreamer.enqueue`; only `clear`/`title` go directly via `office.monitor`.
- Streamer emits whole lines only (client splits `append` on `\n`); never emit a leading/trailing newline.
- Thinking blocks are prefixed `💭 ` (block-level, first line only).
- Adaptive pacing contract: tick 150 ms; each queue has a `rate` ratcheted up at enqueue time (`rate = max(rate, backlog/300)`, reset when the queue drains); per tick the queue accrues `max(0.5, rate)` lines to a fractional accumulator and emits `floor(acc)` lines. (Rate must NOT be recomputed from current backlog each tick — that decays exponentially and a 3,000-line queue would take minutes instead of ≤45 s.)
- Match existing code style: private class fields, small helpers at file bottom, comments only for non-obvious constraints.
- Run tests with `npx vitest run <file>` from the repo root.

---

### Task 1: ScreenStreamer

**Files:**
- Create: `server/src/streamer.ts`
- Test: `server/src/streamer.test.ts`

**Interfaces:**
- Consumes: nothing (pure; callbacks injected).
- Produces (later tasks rely on these exact signatures):
  - `interface StreamerHooks { emit(employeeId: string, text: string): void; drained(employeeId: string): void }`
  - `class ScreenStreamer { constructor(hooks: StreamerHooks, tickMs?: number); enqueue(employeeId: string, text: string): void; isDraining(employeeId: string): boolean; clear(employeeId: string): void; stop(): void }`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/streamer.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/streamer.test.ts`
Expected: FAIL — cannot find module `./streamer.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/streamer.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/streamer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/streamer.ts server/src/streamer.test.ts
git commit -m "feat: ScreenStreamer paces monitor output with adaptive typewriter rate"
```

---

### Task 2: Drain-aware employee lifecycle in Office

**Files:**
- Modify: `server/src/office.ts` (add `attachStreamer`/`notifyDrained`; change `assign` idle filter, `finish`, `remove`)
- Test: `server/src/office.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly — Office depends only on a narrow interface: `interface ScreenStream { isDraining(id: string): boolean; clear(id: string): void }` (declared in office.ts; `ScreenStreamer` structurally satisfies it).
- Produces:
  - `Office.attachStreamer(s: ScreenStream): void`
  - `Office.notifyDrained(employeeId: string): void`
  - `assign()` skips employees whose stream is draining; `finish()` defers the idle transition until drain; `remove()` clears the removed employee's queue.

**Note:** `Office`'s constructor reads/writes `data/office.json` via `save()`. Tests must isolate this: `Office.load` falls back to defaults when the file is unreadable, and `save()` writes — point `DATA_DIR` nowhere. Simplest reliable approach: stub `save` on the instance (`(office as any).save = () => {}`) right after construction, and construct with a variant pool provider so the catalog file isn't needed: `new Office(() => ['Knight'])`. If `data/office.json` exists locally the constructor will read it — so tests must not assume default employee names; instead create a fresh state via the real API (`hireManual`) or operate on whatever employees exist. To keep tests deterministic, have each test use `assign()` to claim employees rather than assuming counts.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/office.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Office } from './office.ts';

function makeOffice() {
  const office = new Office(() => ['Knight', 'Mage', 'Rogue']);
  (office as any).save = () => {}; // keep tests off the real data file
  return office;
}

describe('Office drain-aware lifecycle', () => {
  let office: Office;
  let draining: Set<string>;
  let cleared: string[];

  beforeEach(() => {
    office = makeOffice();
    draining = new Set();
    cleared = [];
    office.attachStreamer({
      isDraining: (id) => draining.has(id),
      clear: (id) => cleared.push(id),
    });
  });

  it('assign skips employees whose screen is still draining', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.finish('s:t1'); // idle again, not draining
    draining.add(a.id);
    const b = office.assign('s:t2', 'Read').employee;
    expect(b.id).not.toBe(a.id);
  });

  it('finish defers idle until notifyDrained when streaming', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    draining.add(a.id);
    office.finish('s:t1');
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
    draining.delete(a.id);
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });

  it('finish goes idle immediately when not streaming', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.finish('s:t1');
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });

  it('notifyDrained without a pending finish is a no-op', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('notifyDrained keeps the employee working if another activity is still assigned', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    // hire everyone else out of the way so t2 lands on a new employee, then
    // force-reassign t2 to a by making a the only idle one is fiddly; instead
    // assign a second activity directly to the same employee via the map:
    draining.add(a.id);
    office.finish('s:t1'); // pendingIdle: a
    (office as any).assignments.set('s:t2', a.id); // second activity on same emp
    draining.delete(a.id);
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('remove clears the streamer queue for that employee', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.remove(a.id);
    expect(cleared).toContain(a.id);
  });

  it('works with no streamer attached (assign/finish behave as before)', () => {
    const plain = makeOffice();
    const a = plain.assign('s:t1', 'Bash').employee;
    plain.finish('s:t1');
    expect(plain.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/office.test.ts`
Expected: FAIL — `office.attachStreamer is not a function`.

- [ ] **Step 3: Implement in office.ts**

Add near the top (after the `Listener` type):

```ts
/** Narrow view of ScreenStreamer so Office never imports it (avoids a cycle). */
export interface ScreenStream {
  isDraining(id: string): boolean;
  clear(id: string): void;
}
```

Add fields and methods to the `Office` class:

```ts
  private streamer: ScreenStream | null = null;
  /** employees whose activity finished but whose screen is still streaming */
  private pendingIdle = new Set<string>();

  attachStreamer(s: ScreenStream) {
    this.streamer = s;
  }

  /** Called when an employee's screen queue empties; completes a deferred finish. */
  notifyDrained(employeeId: string) {
    if (!this.pendingIdle.delete(employeeId)) return;
    if ([...this.assignments.values()].includes(employeeId)) return;
    this.setIdle(employeeId);
  }

  private setIdle(employeeId: string) {
    const emp = this.state.employees.find((e) => e.id === employeeId);
    if (!emp) return;
    emp.status = 'idle';
    emp.task = null;
    this.broadcastState();
  }
```

Change the idle filter in `assign()`:

```ts
    let employee = this.state.employees
      .filter((e) => e.status === 'idle' && !this.streamer?.isDraining(e.id))
      .sort((a, b) => a.seat - b.seat)[0];
```

Replace `finish()`:

```ts
  /**
   * Mark the activity done. The employee goes idle once their screen has
   * finished streaming (immediately if it already has).
   */
  finish(activityKey: string) {
    const empId = this.assignments.get(activityKey);
    if (!empId) return;
    this.assignments.delete(activityKey);
    if ([...this.assignments.values()].includes(empId)) return;
    if (this.streamer?.isDraining(empId)) {
      this.pendingIdle.add(empId);
      return;
    }
    this.setIdle(empId);
  }
```

In `remove()`, before `this.save()`:

```ts
    this.streamer?.clear(id);
    this.pendingIdle.delete(id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/src/office.test.ts`
Expected: PASS (7 tests). Also run `npx vitest run server/src` to confirm `characters.test.ts` still passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/office.ts server/src/office.test.ts
git commit -m "feat: employees stay busy until their screen drains"
```

---

### Task 3: Route all screen content through the streamer, untruncated

**Files:**
- Modify: `server/src/transcript.ts` (constructor, `startTool`, `finishTool`, `handleSubagentLine`; delete display-path truncation)
- Modify: `server/src/watcher.ts` (wire streamer)
- Test: `server/src/transcript.test.ts` (new)

**Interfaces:**
- Consumes: `ScreenStreamer` from Task 1 (`enqueue`), `Office.attachStreamer`/`notifyDrained` from Task 2.
- Produces:
  - `new Transcripts(office: Office, streamer: ScreenStreamer)` — signature change; `watcher.ts` is the only caller.
  - All screen content (input previews, tool results, subagent text/thinking/tool_use/tool_result) reaches screens via `streamer.enqueue(employeeId, text)`, in full.

**Test seam:** `transcript.ts` imports `summarizePrompt`/`nameNewHire` from `./summarizer.ts`, which may call an LLM. Mock the module in every transcript test file:

```ts
vi.mock('./summarizer.ts', () => ({
  summarizePrompt: async () => null,
  nameNewHire: async () => null,
}));
```

Use a stub office and a real `ScreenStreamer` with fake timers, or a stub streamer that records `enqueue` calls. For routing tests a recording stub is simpler and is what the tests below use.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/transcript.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transcripts } from './transcript.ts';
import type { Office } from './office.ts';
import type { ScreenStreamer } from './streamer.ts';

vi.mock('./summarizer.ts', () => ({
  summarizePrompt: async () => null,
  nameNewHire: async () => null,
}));

const MAIN = '/proj/-home-user-code-myapp/sess-1.jsonl';
const AGENT = '/proj/-home-user-code-myapp/sess-1/subagents/agent-abc.jsonl';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function makeHarness() {
  const enqueued: Array<{ id: string; text: string }> = [];
  const monitors: any[] = [];
  const finished: string[] = [];
  let seq = 0;
  const office = {
    assign: vi.fn((key: string, task: string) => ({
      employee: { id: `emp-${++seq}`, name: 'E', seat: seq, variant: 'Knight', hiredAt: '', status: 'working', task },
      hired: false,
    })),
    finish: vi.fn((key: string) => finished.push(key)),
    monitor: vi.fn((target: string, opts: any) => monitors.push({ target, ...opts })),
    setBossStatus: vi.fn(),
    pushInbox: vi.fn(),
    updateInboxText: vi.fn(),
    setTodos: vi.fn(),
    rename: vi.fn(),
    lastInboxId: 'inbox-1',
  } as unknown as Office;
  const streamer = {
    enqueue: vi.fn((id: string, text: string) => enqueued.push({ id, text })),
    isDraining: () => false,
    clear: vi.fn(),
    stop: vi.fn(),
  } as unknown as ScreenStreamer;
  const transcripts = new Transcripts(office, streamer);
  return { transcripts, office, enqueued, monitors, finished };
}

function startBash(t: Transcripts, id = 'tu-1') {
  t.handleLines(MAIN, [
    line({
      type: 'assistant',
      sessionId: 'sess-1',
      cwd: '/home/user/code/myapp',
      message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] },
    }),
  ]);
}

describe('main-session tool flow', () => {
  it('streams the input preview and the full untruncated result', () => {
    const { transcripts, enqueued, finished } = makeHarness();
    startBash(transcripts);
    expect(enqueued[0]).toEqual({ id: 'emp-1', text: '$ npm test' });

    const bigOutput = Array.from({ length: 500 }, (_, i) => `out ${i}`).join('\n'); // > old 4000-char cap
    transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: bigOutput }] },
      }),
    ]);
    const result = enqueued[1].text;
    expect(result).toContain('out 0');
    expect(result).toContain('out 499'); // nothing truncated
    expect(result).not.toContain('truncated');
    expect(result).toContain('✓ done');
    expect(finished).toEqual(['sess-1:tu-1']);
  });

  it('clear/title still go directly to office.monitor on start', () => {
    const { transcripts, monitors } = makeHarness();
    startBash(transcripts);
    expect(monitors[0]).toMatchObject({ target: 'emp-1', clear: true, title: 'Bash · myapp' });
    expect(monitors[0].append).toBeUndefined();
  });
});

describe('subagent flow', () => {
  function startTask(t: Transcripts) {
    t.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore', prompt: 'look around' } }] },
      }),
    ]);
    t.fileAppeared(AGENT);
  }

  it('streams subagent text, thinking (💭-prefixed), tool_use, and tool_result in full', () => {
    const { transcripts, enqueued } = makeHarness();
    startTask(transcripts);
    const empId = enqueued[0].id;

    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'let me look at the files' },
            { type: 'text', text: 'Reading the config now.' },
            { type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-sub-1', content: 'export const config = {...}' }],
        },
      }),
    ]);

    const texts = enqueued.filter((e) => e.id === empId).map((e) => e.text);
    expect(texts).toContain('💭 let me look at the files');
    expect(texts).toContain('Reading the config now.');
    expect(texts.some((t) => t.startsWith('> Read /app/config.ts') || t.startsWith('> Read read /app/config.ts'))).toBe(true);
    expect(texts).toContain('export const config = {...}');
  });
});
```

Note: the tool_use line assertion above is loose on purpose; pin it to the exact format you implement (`> Read read /app/config.ts` given `inputPreview('Read', …)` returns `read /app/config.ts`) and tighten the assertion to `toContain('> Read read /app/config.ts')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/transcript.test.ts`
Expected: FAIL — `Transcripts` constructor takes 1 argument today and nothing is enqueued (`streamer.enqueue` never called).

- [ ] **Step 3: Implement in transcript.ts**

Constructor and imports:

```ts
import { ScreenStreamer } from './streamer.ts';
// …
constructor(
  private office: Office,
  private streamer: ScreenStreamer,
) {}
```

Delete `MAX_OUTPUT_CHARS` and the `truncate()` helper; remove all its call sites (`finishTool`, `handleSubagentLine`, `inputPreview`'s Task/Agent and default branches lose their `truncate(...)` wrappers but keep the formatting).

`startTool` — replace the final `office.monitor` call:

```ts
    this.office.monitor(employee.id, { clear: true, title: `${label} · ${project}` });
    this.streamer.enqueue(employee.id, inputPreview(name, input));
```

`finishTool` — replace the final `office.monitor` block:

```ts
    const text = extractText(result.content) || '(no output)';
    this.streamer.enqueue(activity.employeeId, text + '\n\n✓ done');
    this.office.finish(activity.key);
```

`handleSubagentLine` — full replacement:

```ts
  private handleSubagentLine(activity: Activity, line: any) {
    if (line.type === 'assistant') {
      for (const b of contentBlocks(line.message?.content)) {
        if (b.type === 'text' && b.text?.trim()) {
          this.streamer.enqueue(activity.employeeId, b.text.trim());
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          this.streamer.enqueue(activity.employeeId, '💭 ' + b.thinking.trim());
        } else if (b.type === 'tool_use') {
          this.streamer.enqueue(activity.employeeId, `> ${b.name} ${oneLine(inputPreview(b.name, b.input ?? {}))}`);
        }
      }
      return;
    }
    if (line.type === 'user') {
      for (const b of contentBlocks(line.message?.content)) {
        if (b.type !== 'tool_result') continue;
        const text = extractText(b.content);
        if (text) this.streamer.enqueue(activity.employeeId, text);
      }
    }
  }
```

`watcher.ts` — wire it up (replace the first line of `startWatcher`):

```ts
import { ScreenStreamer } from './streamer.ts';
// …
export function startWatcher(office: Office) {
  const streamer = new ScreenStreamer({
    emit: (id, text) => office.monitor(id, { append: text }),
    drained: (id) => office.notifyDrained(id),
  });
  office.attachStreamer(streamer);
  const transcripts = new Transcripts(office, streamer);
  // … rest unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/src`
Expected: PASS — transcript, office, streamer, characters tests all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript.ts server/src/watcher.ts server/src/transcript.test.ts
git commit -m "feat: stream all tool output, subagent results and thinking to screens untruncated"
```

---

### Task 4: Boss replies stream to pool employees

**Files:**
- Modify: `server/src/transcript.ts` (`handleMainLine` assistant branch; new `onBossReply`)
- Test: `server/src/transcript.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's streamer routing; `office.assign`/`finish`.
- Produces: each main-session assistant line with text/thinking claims a pool employee under activity key `` `${sessionId}:${line.uuid}` `` (fallback `` `${sessionId}:reply-${n}` `` via a `replySeq` counter when `uuid` is missing), labeled `Reporting to the Boss`, and is `finish()`ed immediately after enqueueing (the drain defers the idle transition).

- [ ] **Step 1: Write the failing test** (append to `transcript.test.ts`)

```ts
describe('boss replies', () => {
  it('assigns a pool employee, streams thinking + text, finishes immediately', () => {
    const { transcripts, office, enqueued, monitors, finished } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'msg-uuid-1',
        cwd: '/home/user/code/myapp',
        message: {
          content: [
            { type: 'thinking', thinking: 'planning the fix' },
            { type: 'text', text: 'I found the bug in the parser.' },
          ],
        },
      }),
    ]);
    expect(office.assign).toHaveBeenCalledWith('sess-1:msg-uuid-1', 'Reporting to the Boss');
    expect(monitors[0]).toMatchObject({ target: 'emp-1', clear: true, title: 'Reporting to the Boss · myapp' });
    expect(enqueued[0].text).toBe('💭 planning the fix\nI found the bug in the parser.');
    expect(finished).toEqual(['sess-1:msg-uuid-1']);
  });

  it('a mixed message starts its tools AND streams its text', () => {
    const { transcripts, office } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'msg-uuid-2',
        cwd: '/home/user/code/myapp',
        message: {
          content: [
            { type: 'text', text: 'Running the tests now.' },
            { type: 'tool_use', id: 'tu-9', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }),
    ]);
    expect(office.assign).toHaveBeenCalledWith('sess-1:tu-9', 'Bash');
    expect(office.assign).toHaveBeenCalledWith('sess-1:msg-uuid-2', 'Reporting to the Boss');
  });

  it('tool_use-only messages do not claim a reply employee', () => {
    const { transcripts, office } = makeHarness();
    startBash(transcripts);
    expect(office.assign).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/transcript.test.ts`
Expected: FAIL — no `Reporting to the Boss` assignment happens.

- [ ] **Step 3: Implement**

Add a field to `Transcripts`:

```ts
  private replySeq = 0;
```

Extend the assistant branch of `handleMainLine`:

```ts
    if (line.type === 'assistant') {
      const blocks = contentBlocks(line.message?.content);
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      if (toolUses.length > 0) this.touchBoss();
      for (const tu of toolUses) this.startTool(sessionId, project, tu);
      this.onBossReply(sessionId, project, line, blocks);
    }
```

New method (place after `onUserPrompt`):

```ts
  /** The main Claude's own text/thinking: an employee walks it over to the Boss. */
  private onBossReply(sessionId: string, project: string, line: any, blocks: any[]) {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking?.trim()) parts.push('💭 ' + b.thinking.trim());
      else if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
    }
    if (parts.length === 0) return;
    this.touchBoss();
    const key = `${sessionId}:${line.uuid ?? `reply-${++this.replySeq}`}`;
    const { employee, hired } = this.office.assign(key, 'Reporting to the Boss');
    if (hired) {
      nameNewHire('Reporting to the Boss').then((name) => {
        if (name) this.office.rename(employee.id, name);
      });
    }
    this.office.monitor(employee.id, { clear: true, title: `Reporting to the Boss · ${project}` });
    this.streamer.enqueue(employee.id, parts.join('\n'));
    this.office.finish(key);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript.ts server/src/transcript.test.ts
git commit -m "feat: main Claude's replies and thinking stream to a pool employee's screen"
```

---

### Task 5: Subagent attachment race fix

**Files:**
- Modify: `server/src/transcript.ts` (`fileAppeared`, `handleLines`, `startTool`; new `attachAgentFile`, unmatched pool + line buffer)
- Test: `server/src/transcript.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's subagent routing.
- Produces: attachment works in both event orders. Internals: `unmatchedAgentFiles: Map<string, string[]>` (sessionId → files, FIFO), `bufferedLines: Map<string, any[]>` (file → parsed lines, capped at `MAX_BUFFERED_LINES = 500`), `private attachAgentFile(activity: Activity, file: string): void`.

- [ ] **Step 1: Write the failing test** (append to `transcript.test.ts`)

```ts
describe('subagent attachment race', () => {
  const taskLine = line({
    type: 'assistant',
    sessionId: 'sess-1',
    cwd: '/home/user/code/myapp',
    message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
  });
  const agentText = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello from agent' }] },
  });

  it('attaches when the file appears BEFORE the Task tool_use, replaying buffered lines', () => {
    const { transcripts, enqueued } = makeHarness();
    transcripts.fileAppeared(AGENT);
    transcripts.handleLines(AGENT, [agentText]); // buffered, no activity yet
    expect(enqueued).toEqual([]);
    transcripts.handleLines(MAIN, [taskLine]);
    const texts = enqueued.map((e) => e.text);
    expect(texts).toContain('hello from agent'); // replayed on attach
  });

  it('still attaches when the Task tool_use arrives first (existing order)', () => {
    const { transcripts, enqueued } = makeHarness();
    transcripts.handleLines(MAIN, [taskLine]);
    transcripts.fileAppeared(AGENT);
    transcripts.handleLines(AGENT, [agentText]);
    expect(enqueued.map((e) => e.text)).toContain('hello from agent');
  });

  it('caps the buffer for files that never match', () => {
    const { transcripts } = makeHarness();
    transcripts.fileAppeared(AGENT);
    const lines = Array.from({ length: 600 }, () => agentText);
    transcripts.handleLines(AGENT, lines);
    expect((transcripts as any).bufferedLines.get(AGENT)).toHaveLength(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/transcript.test.ts`
Expected: FAIL — first test gets no replay (`hello from agent` missing).

- [ ] **Step 3: Implement**

Add fields and constant:

```ts
const MAX_BUFFERED_LINES = 500;
// in the class:
  /** sessionId -> subagent files that appeared before their Task tool_use */
  private unmatchedAgentFiles = new Map<string, string[]>();
  /** file -> parsed lines held until the file is matched to an activity */
  private bufferedLines = new Map<string, any[]>();
```

Replace `fileAppeared`:

```ts
  fileAppeared(file: string) {
    if (!isSubagentFile(file)) return;
    const sessionId = sessionIdForSubagentFile(file);
    const activity = this.pendingTasks.get(sessionId)?.shift();
    if (activity) {
      this.attachAgentFile(activity, file);
      return;
    }
    // Task tool_use hasn't been read yet (event-order race): pool the file.
    const pool = this.unmatchedAgentFiles.get(sessionId) ?? [];
    pool.push(file);
    this.unmatchedAgentFiles.set(sessionId, pool);
  }

  private attachAgentFile(activity: Activity, file: string) {
    activity.agentFile = file;
    this.agentFiles.set(file, activity);
    const buffered = this.bufferedLines.get(file);
    if (buffered) {
      this.bufferedLines.delete(file);
      for (const l of buffered) this.handleSubagentLine(activity, l);
    }
  }
```

In `handleLines`, replace the subagent branch:

```ts
      if (agentActivity || isSubagentFile(file)) {
        if (agentActivity) {
          this.handleSubagentLine(agentActivity, line);
        } else {
          const buf = this.bufferedLines.get(file) ?? [];
          if (buf.length < MAX_BUFFERED_LINES) buf.push(line);
          this.bufferedLines.set(file, buf);
        }
        continue;
      }
```

In `startTool`, replace the `if (isTask) { … }` block:

```ts
    if (isTask) {
      const file = this.unmatchedAgentFiles.get(sessionId)?.shift();
      if (file) {
        this.attachAgentFile(activity, file);
      } else {
        const pending = this.pendingTasks.get(sessionId) ?? [];
        pending.push(activity);
        this.pendingTasks.set(sessionId, pending);
      }
    }
```

In `finishTool`, alongside the existing `agentFiles` cleanup, also drop any leftover buffer:

```ts
    if (activity.agentFile) {
      this.agentFiles.delete(activity.agentFile);
      this.bufferedLines.delete(activity.agentFile);
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all server, shared, and web tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript.ts server/src/transcript.test.ts
git commit -m "fix: subagent transcripts attach regardless of file/tool_use event order"
```

---

## Post-plan verification (manual)

Run the app (`docker compose up` per README / memory: WATCH_POLL=1 in Docker) alongside a real Claude Code session and confirm: thinking streams with 💭, subagent tool output types across employee screens, a boss reply claims its own employee, parallel tools fan out to multiple desks, and busy-streaming employees are skipped for new work.
