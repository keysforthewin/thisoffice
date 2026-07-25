import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Office } from './office.ts';
import { ScreenStreamer } from './streamer.ts';
import { Transcripts } from './transcript.ts';
import type { ServerMsg } from '../../shared/types.ts';

vi.mock('./summarizer.ts', () => ({
  summarizePrompt: async () => null,
  nameNewHire: async () => null,
}));

const MAIN = '/proj/-home-user-code-myapp/sess-1.jsonl';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function toolUse(id: string, command: string) {
  return line({
    type: 'assistant',
    sessionId: 'sess-1',
    cwd: '/home/user/code/myapp',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
}

function toolResult(id: string, content: string) {
  return line({
    type: 'user',
    sessionId: 'sess-1',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
}

describe('Office + ScreenStreamer + Transcripts integration (real classes, fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a queued job is picked up, streams its buffered content, and the office drains back to all-idle', () => {
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], '/nonexistent/office.json');
    (office as any).save = () => {};

    const monitorMsgs: Extract<ServerMsg, { type: 'monitor' }>[] = [];
    office.subscribe((msg) => {
      if (msg.type === 'monitor') monitorMsgs.push(msg);
    });

    const streamer = new ScreenStreamer({
      emit: (id, text) => office.monitor(id, { append: text }),
      drained: (id) => office.notifyDrained(id),
    });
    office.attachStreamer(streamer);

    const transcripts = new Transcripts(office, streamer);

    const employeeCount = office.getState().employees.length;
    office.setStaffing({ minEmployees: 1, maxEmployees: employeeCount });

    // One Bash tool per existing employee, plus two more that must queue.
    const toolIds = Array.from({ length: employeeCount + 2 }, (_, i) => `tu-${i}`);
    for (const id of toolIds) transcripts.handleLines(MAIN, [toolUse(id, `echo ${id}`)]);

    // Only `employeeCount` tools actually got an employee; the rest queued.
    expect(office.getState().employees.every((e) => e.status === 'working')).toBe(true);

    // Finish every started tool (results arrive for all, including the queued ones,
    // which buffer until picked up).
    for (const id of toolIds) transcripts.handleLines(MAIN, [toolResult(id, `output for ${id}`)]);

    // Drain the real streamer's ticks (150ms default) until everything settles.
    for (let i = 0; i < 2000 && office.getState().employees.some((e) => e.status !== 'idle'); i++) {
      vi.advanceTimersByTime(150);
    }

    const finalState = office.getState();
    expect(finalState.employees.every((e) => e.status === 'idle')).toBe(true);
    expect(finalState.employees.every((e) => e.task === null)).toBe(true);

    // The queued tools' output eventually streamed to some employee's screen.
    const appended = monitorMsgs
      .filter((m) => typeof m.append === 'string')
      .map((m) => m.append)
      .join('\n');
    for (const id of toolIds) {
      expect(appended).toContain(`output for ${id}`);
    }
  });

  it('a Task finishing with mixed assigned+queued fanned-out children cancels the queued one instead of misclassifying it', () => {
    // Regression test for a reentrancy bug: office.finish() on an assigned sibling
    // synchronously dequeues+reassigns the office's real work queue (setIdle ->
    // assignCb -> onQueuedAssigned), which can flip a still-queued sibling's
    // employeeId mid-loop if a single combined pass finishes assigned children
    // before cancelling queued ones. This needs the REAL Office (its assign/finish/
    // workQueue/assignCb wiring is what reenters) — a mocked office can't express it.
    // A real ScreenStreamer would defer every finish() via isDraining (since we just
    // enqueued the '✓ done' text), which papers over the bug, so the stream stub here
    // reports never-draining, the same way office.test.ts's own unit tests do — that's
    // what makes office.finish() call setIdle() synchronously and reenter assignCb.
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], '/nonexistent/office.json');
    (office as any).save = () => {};

    const monitorMsgs: Extract<ServerMsg, { type: 'monitor' }>[] = [];
    office.subscribe((msg) => {
      if (msg.type === 'monitor') monitorMsgs.push(msg);
    });

    const enqueued: Array<{ id: string; text: string }> = [];
    const streamStub = {
      enqueue: (id: string, text: string) => enqueued.push({ id, text }),
      isDraining: () => false,
      clear: () => {},
      setPressure: () => {},
      setBoost: () => {},
      stop: () => {},
    };
    office.attachStreamer(streamStub);

    const transcripts = new Transcripts(office, streamStub as unknown as ScreenStreamer);

    const employeeCount = office.getState().employees.length; // 3 by default
    office.setStaffing({ minEmployees: 1, maxEmployees: employeeCount });

    // The Task itself takes one desk.
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
    ]);
    const AGENT = '/proj/-home-user-code-myapp/sess-1/subagents/agent-abc.jsonl';
    transcripts.fileAppeared(AGENT);

    // Two fanned-out children fill every remaining desk (all assigned).
    transcripts.handleLines(AGENT, [
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-sub-a', name: 'Read', input: { file_path: '/app/a.ts' } }] } }),
    ]);
    transcripts.handleLines(AGENT, [
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-sub-b', name: 'Bash', input: { command: 'echo b' } }] } }),
    ]);
    expect(office.getState().employees.every((e) => e.status === 'working')).toBe(true);

    // A third fanned-out child queues: no desks are left.
    transcripts.handleLines(AGENT, [
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-sub-c', name: 'Grep', input: { pattern: 'TODO' } }] } }),
    ]);
    expect((office as any).workQueue.some((j: { key: string }) => j.key === 'sess-1:tu-sub-c')).toBe(true);

    // The Task's own tool_result finishes while two children are assigned and one is still queued.
    transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-task', content: 'done exploring' }] },
      }),
    ]);

    // The queued child was cancelled outright: it must never have gotten a desk
    // (a reentrant misfire would give it a monitor + stream its buffered preview first,
    // then a second, spurious '✓ done' on top of that).
    expect(monitorMsgs.some((m) => m.title === 'Grep · myapp')).toBe(false);
    expect(enqueued.some((e) => e.text.includes('TODO'))).toBe(false);
    expect((office as any).workQueue.some((j: { key: string }) => j.key === 'sess-1:tu-sub-c')).toBe(false);

    // Both real children each get exactly one done marker on their own screen — no
    // employee is double-finished by a reentrant pickup mid-loop.
    const doneCounts = enqueued.filter((e) => e.text === '✓ done').length;
    expect(doneCounts).toBe(2);

    const finalState = office.getState();
    expect(finalState.employees.every((e) => e.status === 'idle')).toBe(true);
    expect(finalState.employees).toHaveLength(employeeCount); // no stray hire from a phantom queue pickup
  });
});
