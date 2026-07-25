# Full-Fidelity Streaming Screens — Design

**Date:** 2026-07-24
**Status:** Approved

## Problem

The visualizer drops most of what a Claude Code session actually produces, and what it does
show appears all at once:

1. Subagent tool results (`user`-role lines with `tool_result` blocks in
   `subagents/*.jsonl`) are never shown — employee screens show `> Bash …` commands but
   never their output.
2. `thinking` blocks (the majority of assistant content by block count) are dropped in both
   main-session and subagent handling.
3. The main session's assistant replies (text + thinking) are shown nowhere.
4. Subagent transcript files are only matched to their `Task`/`Agent` tool_use at file-add
   time; if chokidar delivers the file `add` before the main-file `change` containing the
   tool_use, the agent is never attached and its employee screen stays blank.
5. Output is truncated (4,000-char results, 1,000-char text, 120-char one-liners) and
   appended in one blob when the tool finishes, instead of streaming.

## Goals

- Show **everything**: tool results, thinking, and main-Claude replies, with **no
  truncation** anywhere in the server pipeline.
- **Stream** all screen content as a typewriter effect, a few lines per second, adaptively
  faster for large backlogs.
- Employees stay **busy while their screen is still streaming**; new work goes to a free
  employee or a new hire. 10 parallel tool calls → up to 10 busy desks.
- Fix the subagent-file attachment race.

## Architecture

New server component: **`ScreenStreamer`** (`server/src/streamer.ts`).

```
transcript.ts ──enqueue(employeeId, lines)──▶ ScreenStreamer ──office.monitor(append)──▶ ws ──▶ store ──▶ canvas
```

All screen content goes through the streamer instead of calling `office.monitor({append})`
directly. (`clear`/`title` on activity start still go direct — they are instant.)

Pacing lives **server-side** so the server authoritatively knows when a screen has drained;
that knowledge drives the assignment rule, and all connected clients render identically.

### ScreenStreamer

- Per-employee FIFO queue of lines. `enqueue(employeeId, text)` splits text into lines and
  appends.
- A single interval ticker (~150 ms). Each tick, for each non-empty queue, emit
  `office.monitor(employeeId, { append })` with the next N lines joined.
- **Adaptive rate:** baseline ~3 lines/sec (one line every other tick), scaling with
  backlog — lines per tick `= max(baseline, ceil(backlog / 300))` — so any backlog drains
  in ≤ ~45 s.
- `isDraining(employeeId): boolean` — queue non-empty.
- `onDrain(employeeId, cb)` — fires when the queue empties (used to free employees).
- The ticker idles (clears interval) when all queues are empty.

Exact tick/rate constants may be tuned during implementation; the contract is: readable
typewriter pace for small outputs, bounded (≤ ~45 s) drain time for any output.

### Employee lifecycle (office.ts)

- `assign()` unchanged in interface, but "idle" now means `status === 'idle'` **and** the
  streamer reports not draining. Office needs a `busyCheck` hook (injected by server
  wiring) or the transcript layer passes eligibility — implementation detail; the rule is:
  a streaming screen is never reassigned.
- `finish(activityKey)` becomes drain-aware: if the employee's queue is non-empty, defer
  the idle transition until `onDrain` fires. Activity bookkeeping (assignment map cleanup)
  still happens immediately.

### Content routing (transcript.ts)

| Source | Destination |
|---|---|
| Main-session `tool_use` | claims employee via `assign()` (as today); input preview enqueued |
| Main-session `tool_result` | enqueued in full to that tool's employee, then finish |
| Main-session assistant `text` + `thinking` | **new**: each assistant turn with text/thinking becomes an activity, assigned via the normal pool (any idle employee, hire if none); freed on drain |
| Subagent assistant `text` / `thinking` / `tool_use` | enqueued to the Task's employee (as today, but via streamer, untruncated) |
| Subagent `tool_result` (user-role lines) | **new**: enqueued in full to the Task's employee |

- Thinking lines are prefixed with `💭 ` so they read differently from output on screen.
- All `truncate()` calls, `MAX_OUTPUT_CHARS`, and the 120-char one-liner cap are removed
  from the display path. `inputPreview` keeps its per-tool formatting but returns full
  content.
- Boss-reply activities: key `sessionId:<message-uuid>`, label like `Reporting to the Boss`.
  The reply activity is finished (freed on drain) as soon as its content is enqueued —
  it has no result to wait for.

### Subagent attachment race fix (transcript.ts)

Replace the one-shot matching with a symmetric pending pool:

- `fileAppeared(file)`: if a pending Task exists for the session → attach (as today);
  otherwise add the file to an `unmatchedAgentFiles` pool keyed by sessionId, **and buffer
  any lines that arrive** for unmatched files.
- `startTool()` for Task/Agent: first check `unmatchedAgentFiles` for that session → attach
  oldest and replay buffered lines; otherwise push to `pendingTasks` (as today).

Neither event order can drop an agent. Buffered lines for files that never match are capped
(drop after N lines) to bound memory; this is a pathological case, not normal flow.

### Client (web/src/store.ts)

- `monitor` append handling unchanged in shape; the per-screen line buffer is capped at the
  last ~200 lines (render window — the canvas shows ~20 lines; this is not content
  truncation, the full content has already scrolled past on screen).

## Not changing

Inbox/prompt summarization, whiteboard/task board, watcher, 3D scene, hiring/naming,
`isSidechain` skip, TodoWrite/TaskCreate/TaskUpdate handling.

## Error handling

- Streamer swallows nothing: enqueue for unknown/removed employees is a no-op (employee may
  be fired mid-stream via settings panel; `office.remove` should also clear that queue).
- Malformed JSONL lines: skipped, as today.

## Testing

Vitest (config already present):

- `ScreenStreamer`: pacing math (adaptive N), drain callback ordering, idle-ticker
  behavior, queue clearing on employee removal — with fake timers.
- `Transcripts`: feed synthetic JSONL lines and assert routing — subagent tool_result
  reaches the employee queue; thinking blocks stream; boss reply claims a pool employee;
  file-before-tool_use and tool_use-before-file orders both attach; no truncation of a
  large payload.
- `Office.assign`: skips employees whose streamer queue is non-empty; `finish` defers idle
  until drain.
