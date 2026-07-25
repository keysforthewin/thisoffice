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

function makeHarness(opts: { queue?: boolean } = {}) {
  const enqueued: Array<{ id: string; text: string }> = [];
  const monitors: any[] = [];
  const finished: string[] = [];
  let seq = 0;
  let onAssignCb: ((key: string, employee: any) => void) | null = null;
  const office = {
    onAssign: vi.fn((cb: (key: string, employee: any) => void) => {
      onAssignCb = cb;
    }),
    assign: vi.fn((key: string, task: string) => {
      if (opts.queue) return { employee: null, hired: false };
      return {
        employee: { id: `emp-${++seq}`, name: 'E', seat: seq, variant: 'Knight', hiredAt: '', status: 'working', task },
        hired: false,
      };
    }),
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
  const pickup = (key: string, id = 'emp-9') =>
    onAssignCb?.(key, { id, name: 'Q', seat: 9, variant: 'Knight', hiredAt: '', status: 'working', task: null });
  return { transcripts, office, enqueued, monitors, finished, pickup };
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
    expect(texts).toContain('> Read read /app/config.ts');
    expect(texts).toContain('export const config = {...}');
  });
});

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

  it('replayed buffered lines land after the clear/title/input preview (file-before-tool_use order)', () => {
    const { transcripts, enqueued } = makeHarness();
    transcripts.fileAppeared(AGENT);
    transcripts.handleLines(AGENT, [agentText]); // buffered, no activity yet
    transcripts.handleLines(MAIN, [taskLine]);
    const texts = enqueued.map((e) => e.text);
    const previewIdx = texts.findIndex((t) => t === 'explore');
    const replayIdx = texts.indexOf('hello from agent');
    expect(previewIdx).toBeGreaterThanOrEqual(0);
    expect(replayIdx).toBeGreaterThan(previewIdx);
  });

  it('a file never announced via fileAppeared is not attached at Task start; the input preview still streams, and a later fileAppeared attaches it', () => {
    const { transcripts, enqueued, monitors } = makeHarness();
    // Task tool_use arrives, but the pre-existing subagent file was never
    // announced (simulating the watcher's isNew gate skipping it).
    transcripts.handleLines(MAIN, [taskLine]);
    expect((transcripts as any).pendingTasks.get('sess-1')).toHaveLength(1);
    expect((transcripts as any).agentFiles.has(AGENT)).toBe(false);
    // Screen still gets its clear/title + input preview even with no file attached yet.
    expect(monitors[0]).toMatchObject({ clear: true, title: 'Agent: explore · myapp' });
    expect(enqueued.map((e) => e.text)).toContain('explore');

    // The normal live flow still works: a later fileAppeared attaches it.
    transcripts.fileAppeared(AGENT);
    expect((transcripts as any).agentFiles.has(AGENT)).toBe(true);
    transcripts.handleLines(AGENT, [agentText]);
    expect(enqueued.map((e) => e.text)).toContain('hello from agent');
  });
});

describe('finished agent files', () => {
  it('drops (does not stream or buffer) lines that arrive on an agent file after its Task finished', () => {
    const { transcripts, enqueued } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
    ]);
    transcripts.fileAppeared(AGENT);
    transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-task', content: 'done exploring' }] },
      }),
    ]);
    const countBefore = enqueued.length;

    // A trailing flush lands on the now-finished agent file.
    transcripts.handleLines(AGENT, [
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'late straggler line' }] } }),
    ]);

    expect(enqueued).toHaveLength(countBefore); // not streamed
    expect((transcripts as any).bufferedLines.get(AGENT)).toBeUndefined(); // not buffered
    expect(enqueued.map((e) => e.text)).not.toContain('late straggler line');
  });
});

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

  it('pickup of an unknown queued key releases the desk via office.finish instead of stranding it', () => {
    const h = makeHarness({ queue: true });
    h.pickup('sess-1:ghost'); // no matching entry in `queued` (e.g. duplicate pickup)
    expect(h.finished).toEqual(['sess-1:ghost']);
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
