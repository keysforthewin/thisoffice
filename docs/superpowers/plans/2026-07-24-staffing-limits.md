# Staffing Limits, Work Queue & Idle Eviction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the office roster (min 3 / max 12, settings-editable), queue overflow work with buffered replay, speed up screens under backlog pressure, and auto-evict employees idle for 60 s.

**Architecture:** `Office` gains persisted `staffing` settings, a FIFO `workQueue` drained at the moment an employee frees (`setIdle`), and per-employee idle timers that call the existing `remove()`. The `ScreenStreamer` gains a pressure multiplier. `Transcripts` buffers content for queued activities and replays it via an `onAssign` callback. Spec: `docs/superpowers/specs/2026-07-24-staffing-limits-design.md`.

**Tech Stack:** Node 22+ ESM TypeScript with type-stripping (`.ts` import extensions), vitest (root config, `globals: true`, colocated `server/src/*.test.ts`), React 19 for the settings panel. No new dependencies.

## Global Constraints

- Defaults exactly: `minEmployees: 3`, `maxEmployees: 12`, `IDLE_FIRE_MS = 60_000`.
- Pressure contract: with N queued jobs, per-tick accrual is `max(0.5, rate) * (1 + N)`.
- Protected from eviction: the `minEmployees` lowest-seat employees, computed at fire time; eviction also never fires when headcount ≤ `minEmployees` or the employee is not idle.
- Queued activities buffer ALL their content untruncated and replay through the normal typewriter on pickup; `office.finish` for a done-while-queued activity is called only after replay is enqueued.
- Existing behavior preserved: manual hire/fire endpoints unchanged (manual hires are evictable); no forced firing when max is lowered below headcount.
- Idle timers must be `unref()`'d so they never hold the process (or tests) open.
- Match existing code style. Run tests with `npx vitest run <file>` from the repo root; run `npx vitest run` (full suite, currently 41 green) before each commit.

---

### Task 1: Streamer pressure multiplier

**Files:**
- Modify: `server/src/streamer.ts`
- Test: `server/src/streamer.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ScreenStreamer` internals (`Queue.rate`, `tick()`).
- Produces: `setPressure(n: number): void` — clamps negative to 0; `tick()` accrual becomes `Math.max(0.5, q.rate) * (1 + this.pressure)`.

- [ ] **Step 1: Write the failing test** (append inside the existing `describe('ScreenStreamer', ...)`)

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/streamer.test.ts`
Expected: FAIL — `s.setPressure is not a function`.

- [ ] **Step 3: Implement**

Add to the `ScreenStreamer` class:

```ts
  private pressure = 0;

  /** Backlog pressure from the office work queue: N waiting jobs → screens drain (1+N)× faster. */
  setPressure(n: number) {
    this.pressure = Math.max(0, n);
  }
```

In `tick()`, change the accrual line to:

```ts
      q.acc += Math.max(0.5, q.rate) * (1 + this.pressure);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/src/streamer.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/streamer.ts server/src/streamer.test.ts
git commit -m "feat: streamer pressure multiplier — screens type faster under queue backlog"
```

---

### Task 2: Staffing settings (state, persistence, API)

**Files:**
- Modify: `shared/types.ts`, `server/src/office.ts`, `server/src/index.ts`
- Test: `server/src/office.test.ts` (extend)

**Interfaces:**
- Consumes: existing `Office` load/save/broadcast.
- Produces:
  - `shared/types.ts`: `export interface StaffingSettings { minEmployees: number; maxEmployees: number }`; `OfficeState` gains `staffing: StaffingSettings`.
  - `office.ts`: `DEFAULT_STAFFING = { minEmployees: 3, maxEmployees: 12 }`; state and persistence carry `staffing`; `setStaffing(cfg: Partial<StaffingSettings>): void` validates (integers only applied; `min ≥ 1`; `min` clamped down to `max` when it would exceed it), saves, broadcasts.
  - `PUT /api/settings` additionally forwards `body.staffing` to `office.setStaffing`.

- [ ] **Step 1: Write the failing test** (append to `office.test.ts`; reuse the existing `makeOffice()` helper)

```ts
describe('staffing settings', () => {
  it('defaults to min 3 / max 12', () => {
    const office = makeOffice();
    expect(office.getState().staffing).toEqual({ minEmployees: 3, maxEmployees: 12 });
  });

  it('setStaffing applies valid values and persists via save', () => {
    const office = makeOffice();
    let saved = 0;
    (office as any).save = () => saved++;
    office.setStaffing({ minEmployees: 2, maxEmployees: 8 });
    expect(office.getState().staffing).toEqual({ minEmployees: 2, maxEmployees: 8 });
    expect(saved).toBe(1);
  });

  it('ignores non-integers and floors min at 1; min clamps down to max', () => {
    const office = makeOffice();
    office.setStaffing({ minEmployees: 2.5 as any, maxEmployees: NaN as any });
    expect(office.getState().staffing).toEqual({ minEmployees: 3, maxEmployees: 12 });
    office.setStaffing({ minEmployees: 0 });
    expect(office.getState().staffing.minEmployees).toBe(1);
    office.setStaffing({ minEmployees: 6, maxEmployees: 4 });
    expect(office.getState().staffing).toEqual({ minEmployees: 4, maxEmployees: 4 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/office.test.ts`
Expected: FAIL — `staffing` undefined on state.

- [ ] **Step 3: Implement**

`shared/types.ts` — add near `OfficeState`:

```ts
export interface StaffingSettings {
  minEmployees: number;
  maxEmployees: number;
}
```

and add `staffing: StaffingSettings;` to `OfficeState`.

`server/src/office.ts`:

```ts
const DEFAULT_STAFFING: StaffingSettings = { minEmployees: 3, maxEmployees: 12 };
```

- `PersistedState` gains `staffing?: StaffingSettings`.
- In `load()`'s returned state: `staffing: { ...DEFAULT_STAFFING, ...persisted.staffing },`
- In `save()`'s persisted object: `staffing: this.state.staffing,`
- New method:

```ts
  setStaffing(cfg: Partial<StaffingSettings>) {
    const s = { ...this.state.staffing };
    if (Number.isInteger(cfg.minEmployees)) s.minEmployees = Math.max(1, cfg.minEmployees!);
    if (Number.isInteger(cfg.maxEmployees)) s.maxEmployees = Math.max(1, cfg.maxEmployees!);
    if (s.minEmployees > s.maxEmployees) s.minEmployees = s.maxEmployees;
    this.state.staffing = s;
    this.save();
    this.broadcastState();
  }
```

`server/src/index.ts` — in the `PUT /api/settings` handler, after `office.setBoss(...)`:

```ts
      if (body.staffing) office.setStaffing(body.staffing);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/src`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts server/src/office.ts server/src/index.ts server/src/office.test.ts
git commit -m "feat: staffing settings (min/max employees) persisted and settable via API"
```

---

### Task 3: Work queue in Office

**Files:**
- Modify: `server/src/office.ts`, `server/src/transcript.ts` (call-site guard only)
- Test: `server/src/office.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `staffing`; existing `setIdle`, `ScreenStream`.
- Produces:
  - `ScreenStream` interface gains `setPressure(n: number): void` (existing test stubs must add it).
  - `assign(key, label)` returns `{ employee: Employee | null; hired: boolean }` — `null` means queued.
  - `onAssign(cb: (key: string, employee: Employee) => void): void`.
  - Dequeue happens inside `setIdle`; pressure synced on every queue length change.
  - **Temporary** (replaced in Task 5): `transcript.ts` call sites guard `if (!employee) return;` after `assign` so the build stays green; queued content is dropped until Task 5 adds buffering. Mark each with `// TODO(task 5): buffer queued activity`.

- [ ] **Step 1: Write the failing test** (append to `office.test.ts`; extend the shared fake streamer in the `beforeEach` with a `setPressure` spy)

Update the `beforeEach` streamer stub to record pressure:

```ts
    pressures = [];
    office.attachStreamer({
      isDraining: (id) => draining.has(id),
      clear: (id) => cleared.push(id),
      setPressure: (n) => pressures.push(n),
    });
```

(declare `let pressures: number[];` beside the other lets; the Task-2-era `attachStreamer` object in other tests gains the same no-op/spy member.)

```ts
describe('work queue', () => {
  it('queues work at max headcount and reports pressure', () => {
    const office = makeOffice(); // fresh, with its own streamer stub as above
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length }); // cap at current size
    const n = office.getState().employees.length;
    for (let i = 0; i < n; i++) expect(office.assign(`s:t${i}`, 'Bash').employee).not.toBeNull();
    const overflow = office.assign('s:overflow', 'Read');
    expect(overflow.employee).toBeNull();
    expect(office.getState().employees.length).toBe(n); // no hire
    expect(pressures.at(-1)).toBe(1);
  });

  it('a freeing employee picks up the queue head; onAssign fires; pressure drops', () => {
    const office = makeOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length });
    const n = office.getState().employees.length;
    const first = office.assign('s:t0', 'Bash').employee!;
    for (let i = 1; i < n; i++) office.assign(`s:t${i}`, 'Bash');
    office.assign('s:q1', 'Grep');
    const assigned: Array<{ key: string; id: string }> = [];
    office.onAssign((key, emp) => assigned.push({ key, id: emp.id }));
    office.finish('s:t0'); // not draining → setIdle → dequeues
    expect(assigned).toEqual([{ key: 's:q1', id: first.id }]);
    const emp = office.getState().employees.find((e) => e.id === first.id)!;
    expect(emp.status).toBe('working');
    expect(emp.task).toBe('Grep');
    expect(pressures.at(-1)).toBe(0);
    office.finish('s:q1');
    expect(office.getState().employees.find((e) => e.id === first.id)!.status).toBe('idle');
  });

  it('drain-deferred finish also dequeues on notifyDrained', () => {
    const office = makeOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length });
    const n = office.getState().employees.length;
    const first = office.assign('s:t0', 'Bash').employee!;
    for (let i = 1; i < n; i++) office.assign(`s:t${i}`, 'Bash');
    office.assign('s:q1', 'Grep');
    const assigned: string[] = [];
    office.onAssign((key) => assigned.push(key));
    draining.add(first.id);
    office.finish('s:t0'); // deferred
    expect(assigned).toEqual([]);
    draining.delete(first.id);
    office.notifyDrained(first.id);
    expect(assigned).toEqual(['s:q1']);
  });
});
```

Note for the implementer: `makeOffice()` in this describe must attach the streamer stub that records `pressures` and uses the shared `draining` set — mirror the existing `beforeEach` pattern (extract a small helper if that reads better).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/office.test.ts`
Expected: FAIL — `onAssign is not a function` / overflow hires instead of queueing.

- [ ] **Step 3: Implement**

`server/src/office.ts` — extend the interface:

```ts
export interface ScreenStream {
  isDraining(id: string): boolean;
  clear(id: string): void;
  setPressure(n: number): void;
}
```

Class additions:

```ts
  /** activities waiting for a free employee (at max headcount) */
  private workQueue: Array<{ key: string; label: string }> = [];
  private assignCb: ((key: string, employee: Employee) => void) | null = null;

  /** Transcripts registers to replay buffered content when a queued job is picked up. */
  onAssign(cb: (key: string, employee: Employee) => void) {
    this.assignCb = cb;
  }

  private syncPressure() {
    this.streamer?.setPressure(this.workQueue.length);
  }
```

In `assign()`, replace the hire fallback:

```ts
    let hired = false;
    if (!employee) {
      if (this.state.employees.length >= this.state.staffing.maxEmployees) {
        this.workQueue.push({ key: activityKey, label: task });
        this.syncPressure();
        return { employee: null, hired: false };
      }
      employee = this.hire();
      hired = true;
    }
```

and change the return type annotation to `{ employee: Employee | null; hired: boolean }` (the early-return for an existing assignment keeps returning the employee).

Replace `setIdle()`:

```ts
  private setIdle(employeeId: string) {
    const emp = this.state.employees.find((e) => e.id === employeeId);
    if (!emp) return;
    const job = this.workQueue.shift();
    if (job) {
      this.syncPressure();
      emp.status = 'working';
      emp.task = job.label;
      this.assignments.set(job.key, emp.id);
      this.broadcastState();
      this.assignCb?.(job.key, emp);
      return;
    }
    emp.status = 'idle';
    emp.task = null;
    this.broadcastState();
  }
```

`server/src/transcript.ts` — at the two `office.assign(...)` call sites (`startTool`, `onBossReply`), destructure as before and add immediately after:

```ts
    if (!employee) return; // TODO(task 5): buffer queued activity
```

(TypeScript narrows `employee` to non-null below.) Existing `office.test.ts` streamer stubs from Tasks 2-3 and `transcript.test.ts` harness stubs need `setPressure` added as a no-op to satisfy the interface.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: PASS — all green including transcript tests (their stub office always returns an employee).

- [ ] **Step 5: Commit**

```bash
git add server/src/office.ts server/src/office.test.ts server/src/transcript.ts server/src/transcript.test.ts
git commit -m "feat: FIFO work queue at max headcount with onAssign pickup and streamer pressure"
```

---

### Task 4: Idle eviction

**Files:**
- Modify: `server/src/office.ts`
- Test: `server/src/office.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 staffing, Task 3 `setIdle` shape, existing `remove()`.
- Produces: `Office` constructor gains an optional second param `idleFireMs = 60_000` (test seam). Employees idle for `idleFireMs` are removed unless headcount ≤ `minEmployees` or they are among the `minEmployees` lowest-seat employees. Timers start for every employee at construction (all load idle), are cleared on assignment/dequeue, rescheduled on idle, cleared on `remove`, and are `unref()`'d.

- [ ] **Step 1: Write the failing test** (append to `office.test.ts`)

```ts
describe('idle eviction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeEvictionOffice() {
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], 60_000);
    (office as any).save = () => {};
    office.attachStreamer({ isDraining: () => false, clear: () => {}, setPressure: () => {} });
    return office;
  }

  it('evicts an auto-hired employee after 60s idle, never below min or the protected seats', () => {
    const office = makeEvictionOffice();
    const baseline = office.getState().employees.length;
    // occupy everyone so a new hire happens, then free it
    const keys = office.getState().employees.map((e, i) => `s:t${i}`);
    keys.forEach((k) => office.assign(k, 'Bash'));
    const extra = office.assign('s:new', 'Read').employee!; // hired
    office.finish('s:new'); // idle → timer starts
    keys.forEach((k) => office.finish(k));
    vi.advanceTimersByTime(60_001);
    const after = office.getState().employees;
    expect(after.find((e) => e.id === extra.id)).toBeUndefined(); // extra evicted
    expect(after.length).toBeGreaterThanOrEqual(office.getState().staffing.minEmployees);
    // protected lowest seats survive even though idle for over a minute
    const protectedIds = [...after].sort((a, b) => a.seat - b.seat).slice(0, 3).map((e) => e.id);
    vi.advanceTimersByTime(120_000);
    for (const id of protectedIds) {
      expect(office.getState().employees.find((e) => e.id === id)).toBeDefined();
    }
  });

  it('a working employee is never evicted; timer clears on assignment', () => {
    const office = makeEvictionOffice();
    const a = office.assign('s:t1', 'Bash').employee!;
    vi.advanceTimersByTime(120_000);
    expect(office.getState().employees.find((e) => e.id === a.id)).toBeDefined();
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('timers from construction evict leftover extras with no activity at all', () => {
    const office = makeEvictionOffice();
    const before = office.getState().employees.length;
    office.hireManual(); // 1 extra, idle from birth
    vi.advanceTimersByTime(60_001);
    expect(office.getState().employees.length).toBe(Math.max(before, office.getState().staffing.minEmployees));
  });
});
```

Note: `hireManual` starts the new employee idle — `hire()`/`hireManual` must schedule a timer for them too.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/office.test.ts`
Expected: FAIL — constructor rejects second arg / no eviction happens.

- [ ] **Step 3: Implement**

`server/src/office.ts`:

```ts
const IDLE_FIRE_MS = 60_000;
```

Constructor:

```ts
  constructor(
    variantPoolProvider?: () => string[],
    private idleFireMs = IDLE_FIRE_MS,
  ) {
    this.variantPool = variantPoolProvider?.() ?? loadVariantPool();
    if (!this.variantPool.length) this.variantPool = loadVariantPool();
    this.state = this.load();
    for (const e of this.state.employees) this.scheduleIdleTimer(e.id);
  }
```

Class additions:

```ts
  private idleTimers = new Map<string, NodeJS.Timeout>();

  private scheduleIdleTimer(id: string) {
    this.clearIdleTimer(id);
    const t = setTimeout(() => this.fireIfIdle(id), this.idleFireMs);
    t.unref?.();
    this.idleTimers.set(id, t);
  }

  private clearIdleTimer(id: string) {
    const t = this.idleTimers.get(id);
    if (t) clearTimeout(t);
    this.idleTimers.delete(id);
  }

  /** Idle for the full window: let them go, unless they're part of the core staff. */
  private fireIfIdle(id: string) {
    this.idleTimers.delete(id);
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp || emp.status !== 'idle') return;
    if (this.state.employees.length <= this.state.staffing.minEmployees) return;
    const protectedIds = [...this.state.employees]
      .sort((a, b) => a.seat - b.seat)
      .slice(0, this.state.staffing.minEmployees)
      .map((e) => e.id);
    if (protectedIds.includes(id)) return;
    this.remove(id);
  }
```

Wire-ups:
- `assign()` — after claiming/hiring an employee (both paths): `this.clearIdleTimer(employee.id);`
- `setIdle()` — dequeue branch: `this.clearIdleTimer(emp.id);` before marking working; idle branch: `this.scheduleIdleTimer(emp.id);` after marking idle.
- `hire()` — after pushing the employee: `this.scheduleIdleTimer(employee.id);` (covers `hireManual` too; `assign`'s clear immediately follows for auto-hires).
- `remove()` — add `this.clearIdleTimer(id);` beside the existing cleanup.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/office.ts server/src/office.test.ts
git commit -m "feat: employees idle for 60s are let go, protecting the min-staff lowest seats"
```

---

### Task 5: Buffered replay for queued activities in Transcripts

**Files:**
- Modify: `server/src/transcript.ts`
- Test: `server/src/transcript.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `assign` null-return + `onAssign`; existing streamer/finish flow.
- Produces:
  - `Activity.employeeId: string | null`; optional `pendingTitle?: string`, `buffer?: string[]`, `doneWhileQueued?: boolean`.
  - `private queued = new Map<string, Activity>()` keyed by activity key.
  - `private emitTo(activity, text)` routes to streamer or buffer.
  - Constructor registers `office.onAssign(...)` → replay: `monitor({clear, title})`, enqueue joined buffer, then `office.finish(key)` if `doneWhileQueued`.
  - The two `// TODO(task 5)` guards are replaced with real buffering.

- [ ] **Step 1: Write the failing test** (append to `transcript.test.ts`)

The harness needs a queueing mode. Extend `makeHarness` with an optional flag and an `onAssign` capture — change its signature to `makeHarness(opts: { queue?: boolean } = {})` and inside:

```ts
  let onAssignCb: ((key: string, employee: any) => void) | null = null;
  // office stub gains:
  //   onAssign: vi.fn((cb) => { onAssignCb = cb; }),
  //   assign: vi.fn((key, task) => {
  //     if (opts.queue) return { employee: null, hired: false };
  //     ...existing employee-returning body...
  //   }),
  // and the returned object gains: pickup: (key: string, id = 'emp-9') =>
  //     onAssignCb?.(key, { id, name: 'Q', seat: 9, variant: 'Knight', hiredAt: '', status: 'working', task: null }),
```

(Existing tests keep passing — default opts returns employees as before; `onAssign` registration is unconditional in the constructor.)

```ts
describe('queued activities', () => {
  it('buffers a queued tool activity untruncated and replays on pickup, finishing after replay', () => {
    const h = makeHarness({ queue: true });
    startBash(h.transcripts);
    expect(h.enqueued).toEqual([]); // nothing streamed while queued
    const big = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n');
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: big }] },
      }),
    ]);
    expect(h.finished).toEqual([]); // finish deferred while queued
    h.pickup('sess-1:tu-1');
    expect(h.monitors.at(-1)).toMatchObject({ target: 'emp-9', clear: true, title: 'Bash · myapp' });
    const replay = h.enqueued.map((e) => e.text).join('\n');
    expect(replay).toContain('$ npm test');
    expect(replay).toContain('row 0');
    expect(replay).toContain('row 399');
    expect(replay).toContain('✓ done');
    expect(h.finished).toEqual(['sess-1:tu-1']);
  });

  it('queued boss replies buffer and finish on pickup', () => {
    const h = makeHarness({ queue: true });
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'msg-q',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: 'All done, boss.' }] },
      }),
    ]);
    expect(h.enqueued).toEqual([]);
    h.pickup('sess-1:msg-q');
    expect(h.enqueued.map((e) => e.text).join('\n')).toContain('All done, boss.');
    expect(h.finished).toEqual(['sess-1:msg-q']);
  });

  it('subagent lines for a queued Task buffer through to the replay', () => {
    const h = makeHarness({ queue: true });
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
    ]);
    h.transcripts.fileAppeared(AGENT);
    h.transcripts.handleLines(AGENT, [
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'agent says hi' }] } }),
    ]);
    expect(h.enqueued).toEqual([]);
    h.pickup('sess-1:tu-task');
    expect(h.enqueued.map((e) => e.text).join('\n')).toContain('agent says hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/transcript.test.ts`
Expected: FAIL — queued content dropped by the Task 3 guards (`enqueued` empty after pickup, no finish).

- [ ] **Step 3: Implement**

`server/src/transcript.ts`:

Activity interface:

```ts
interface Activity {
  key: string; // sessionId:toolUseId (or sessionId:<uuid> for boss replies)
  employeeId: string | null;
  tool: string;
  isTask: boolean;
  agentFile?: string;
  /** set while waiting in the office work queue */
  pendingTitle?: string;
  buffer?: string[];
  doneWhileQueued?: boolean;
}
```

Class additions:

```ts
  /** activity key -> queued activity awaiting an employee */
  private queued = new Map<string, Activity>();

  constructor(
    private office: Office,
    private streamer: ScreenStreamer,
  ) {
    office.onAssign((key, employee) => this.onQueuedAssigned(key, employee));
  }

  private emitTo(activity: Activity, text: string) {
    if (activity.employeeId) this.streamer.enqueue(activity.employeeId, text);
    else activity.buffer?.push(text);
  }

  private onQueuedAssigned(key: string, employee: Employee) {
    const activity = this.queued.get(key);
    if (!activity) return;
    this.queued.delete(key);
    activity.employeeId = employee.id;
    this.office.monitor(employee.id, { clear: true, title: activity.pendingTitle ?? '' });
    if (activity.buffer?.length) this.streamer.enqueue(employee.id, activity.buffer.join('\n'));
    activity.buffer = undefined;
    if (activity.doneWhileQueued) this.office.finish(key);
  }
```

(import `Employee` type from `../../shared/types.ts`.)

`startTool` — replace the guard and the monitor/enqueue tail:

```ts
    const { employee, hired } = this.office.assign(`${sessionId}:${toolUseId}`, label);
    const activity: Activity = {
      key: `${sessionId}:${toolUseId}`,
      employeeId: employee?.id ?? null,
      tool: name,
      isTask,
    };
    if (!employee) {
      activity.pendingTitle = `${label} · ${project}`;
      activity.buffer = [];
      this.queued.set(activity.key, activity);
    }
    this.activities.set(toolUseId, activity);
    // (pendingTasks / unmatchedAgentFiles handling unchanged — works for queued activities too)
    if (hired && employee) {
      nameNewHire(label).then((n) => {
        if (n) this.office.rename(employee.id, n);
      });
    }
    if (employee) {
      this.office.monitor(employee.id, { clear: true, title: `${label} · ${project}` });
      this.streamer.enqueue(employee.id, inputPreview(name, input));
    } else {
      this.emitTo(activity, inputPreview(name, input));
    }
```

`finishTool` — replace the tail:

```ts
    const text = extractText(result.content) || '(no output)';
    this.emitTo(activity, text + '\n\n✓ done');
    if (activity.employeeId) this.office.finish(activity.key);
    else activity.doneWhileQueued = true;
```

`handleSubagentLine` — replace every `this.streamer.enqueue(activity.employeeId, X)` with `this.emitTo(activity, X)`.

`onBossReply` — replace the guard:

```ts
    const { employee, hired } = this.office.assign(key, 'Reporting to the Boss');
    if (!employee) {
      this.queued.set(key, {
        key,
        employeeId: null,
        tool: 'reply',
        isTask: false,
        pendingTitle: `Reporting to the Boss · ${project}`,
        buffer: [parts.join('\n')],
        doneWhileQueued: true,
      });
      return;
    }
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript.ts server/src/transcript.test.ts
git commit -m "feat: queued activities buffer their content and replay when an employee frees up"
```

---

### Task 6: Settings panel staffing controls

**Files:**
- Modify: `web/src/settings/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `office.staffing` from Task 2's `OfficeState`; existing `api()` helper and styles.
- Produces: a "Staffing" section with Min/Max number inputs writing `PUT /api/settings { staffing: {...} }` on blur.

- [ ] **Step 1: Implement** (no web test infra; verified by typecheck + manual check)

In `SettingsPanel`, after the Employees section's hire button:

```tsx
        <h3 style={styles.sectionTitle}>Staffing</h3>
        <div style={styles.row}>
          <StaffingInput
            label="Min employees"
            value={office.staffing.minEmployees}
            onCommit={(v) => api('/settings', 'PUT', { staffing: { minEmployees: v } })}
          />
          <StaffingInput
            label="Max employees"
            value={office.staffing.maxEmployees}
            onCommit={(v) => api('/settings', 'PUT', { staffing: { maxEmployees: v } })}
          />
        </div>
```

New component beside `EmployeeRow`:

```tsx
function StaffingInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label style={{ flex: 1, fontSize: 12, color: '#9aa4b0' }}>
      {label}
      <input
        style={{ ...styles.input, width: '100%', marginTop: 4 }}
        type="number"
        min={1}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = parseInt(draft ?? '', 10);
          if (Number.isInteger(v) && v >= 1 && v !== value) onCommit(v);
          setDraft(null);
        }}
      />
    </label>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit -p . && cd ..`
Expected: clean.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/settings/SettingsPanel.tsx
git commit -m "feat: min/max employee staffing controls in the settings panel"
```

---

## Post-plan verification (manual)

Restart the server container, generate a burst of activity, and confirm: headcount never exceeds 12; queued work replays with the typewriter when desks free; screens visibly speed up while the queue is non-empty; extras evaporate ~60 s after going idle, never dropping below Pat/Sam/Scan (seats 1-3); settings panel edits persist across restart.
