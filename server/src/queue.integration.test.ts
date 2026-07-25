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
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], 60_000, '/nonexistent/office.json');
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
});
