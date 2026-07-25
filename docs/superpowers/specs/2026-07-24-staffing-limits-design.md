# Staffing Limits, Work Queue & Idle Eviction — Design

**Date:** 2026-07-24
**Status:** Approved (user-specified requirements)

## Problem

The streaming-screens feature holds each employee busy until their screen drains, so
bursts of transcript activity auto-hire without bound (observed: 99 employees). Hires
persist in `data/office.json` and never leave.

## Requirements (from the user)

1. Settings: `maxEmployees` (default 12) and `minEmployees` (default 3), editable in the
   settings panel, persisted.
2. At max headcount with nobody free, new work queues (FIFO) instead of hiring; a freed
   employee immediately picks up the queue head and their screen replays the buffered
   content with the usual typewriter.
3. When a backlog exists, screens type faster: with N queued jobs, the streamer's
   drain-time bound shrinks from ~45 s to ~45/(1+N) s.
4. An employee idle for 60 s disappears (removed from roster and office.json) — unless
   that would drop headcount below `minEmployees`.
5. The protected minimum = the `minEmployees` lowest-seat employees (the original three:
   seats 1-3); they are never auto-evicted and are always on screen.

## Architecture

### Office (`server/src/office.ts`)

- `OfficeState`/persisted state gain `staffing: { minEmployees: number; maxEmployees: number }`
  (defaults `{ minEmployees: 3, maxEmployees: 12 }`, applied when absent from office.json).
- `setStaffing(cfg: Partial<{ minEmployees: number; maxEmployees: number }>)` — validates
  (integers, `1 ≤ min`, `min ≤ max`), persists, broadcasts.
- **Work queue:** `private workQueue: Array<{ key: string; label: string }>`.
  `assign(key, label)` return type becomes `{ employee: Employee | null; hired: boolean }`:
  - idle + not-draining employee → claim it (as today);
  - none free and headcount < `maxEmployees` → hire (as today);
  - otherwise → push `{key, label}` onto `workQueue`, update streamer pressure, return
    `{ employee: null, hired: false }`.
- `onAssign(cb: (key: string, employee: Employee) => void)` — transcripts registers; fired
  when a queued job is picked up.
- Dequeue: in `setIdle(empId)` (the single point where an employee frees), if `workQueue`
  is non-empty: shift the head, keep the employee `working` with the new label, register
  the assignment, update pressure, broadcast, fire `onAssign`. The employee only actually
  goes idle when the queue is empty.
- **Pressure:** the `ScreenStream` interface gains `setPressure(n: number): void`; Office
  calls it with `workQueue.length` whenever the queue length changes.
- **Idle eviction:** `IDLE_FIRE_MS = 60_000`. When an employee goes idle, start a
  (unref'd) timer; clear it when they're assigned work. On fire: remove the employee via
  the existing `remove(id)` iff they still exist, are idle, and are not protected.
  Protected = the `staffing.minEmployees` lowest-seat employees at fire time.
  On construction, timers start for all employees (everyone loads idle), so leftover
  hires from a previous run self-heal. A test seam allows injecting the timer duration.

### ScreenStreamer (`server/src/streamer.ts`)

- `private pressure = 0`; `setPressure(n: number)` clamps to `≥ 0`.
- `tick()`: accrual becomes `q.acc += Math.max(0.5, q.rate) * (1 + this.pressure)`.

### Transcripts (`server/src/transcript.ts`)

- `Activity` gains `employeeId: string | null`, plus `pendingTitle?: string`,
  `buffer?: string[]`, `doneWhileQueued?: boolean`.
- All screen writes go through a private `emitTo(activity, text)`: assigned → `streamer.enqueue`;
  queued → `activity.buffer.push(text)`.
- `startTool` / `onBossReply`: when `assign` returns `employee: null`, store the title in
  `pendingTitle` and buffer the input preview / reply content instead of emitting.
  (Boss replies buffered too; their `office.finish` is deferred to pickup.)
- `finishTool` for a queued activity: buffer the result + `✓ done`, set
  `doneWhileQueued = true`; do NOT call `office.finish` yet.
- On `onAssign(key, employee)`: set `activity.employeeId`, emit
  `office.monitor(employee.id, { clear: true, title: pendingTitle })`, enqueue the joined
  buffer, drop it, and if `doneWhileQueued` (or it was a boss reply) call
  `office.finish(key)` — the drain-aware finish frees the employee after typing.
- Subagent lines for a queued Task route through `emitTo` and buffer transparently.

### API & UI

- `PUT /api/settings` additionally accepts `staffing: { minEmployees?, maxEmployees? }` →
  `office.setStaffing(...)`.
- `SettingsPanel.tsx`: a "Staffing" section with two number inputs (Min employees, Max
  employees) reading `office.staffing`, writing on blur via the existing `api()` helper.
- `shared/types.ts`: `OfficeState.staffing` added.

## Not changing

Streaming pacing contract otherwise, subagent attachment, whiteboard, inbox, manual
hire/fire endpoints (manual hires are subject to idle eviction like everyone else).

## Edge cases

- Queued job whose tool_result arrives before pickup (common for fast tools): fully
  buffered, replayed and finished on pickup.
- `remove()` of a queued-work employee: existing cleanup applies; queue entries reference
  keys, not employees, so nothing dangles.
- Eviction never fires for a working employee (checked at fire time).
- `setStaffing` lowering max below current headcount: no forced firing — eviction
  naturally shrinks the roster as employees go idle.

## Testing

- Streamer: pressure multiplies drain rate (fake timers).
- Office: queue-at-max, dequeue-on-drain with `onAssign` callback ordering, pressure
  updates, eviction (fires only when idle > 60 s, respects min and protection, boot
  timers), setStaffing validation.
- Transcripts: queued activity buffers untruncated and replays on assignment;
  done-while-queued finishes after replay; boss replies queue correctly.
