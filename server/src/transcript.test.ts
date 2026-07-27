import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transcripts, describeAsk } from './transcript.ts';
import type { Office } from './office.ts';
import type { ScreenStreamer } from './streamer.ts';

const MAIN = '/proj/-home-user-code-myapp/sess-1.jsonl';
const AGENT = '/proj/-home-user-code-myapp/sess-1/subagents/agent-abc.jsonl';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function makeHarness(opts: { queue?: boolean; hire?: boolean } = {}) {
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
        employee: {
          id: `emp-${++seq}`,
          name: opts.hire ? 'New Hire' : 'E',
          seat: seq,
          variant: 'Knight',
          hiredAt: '',
          status: 'working',
          task,
        },
        hired: !!opts.hire,
      };
    }),
    pickHireName: vi.fn(() => 'Tab Completion'),
    finish: vi.fn((key: string) => finished.push(key)),
    cancelQueued: vi.fn(),
    monitor: vi.fn((target: string, opts: any) => monitors.push({ target, ...opts })),
    setBossStatus: vi.fn(),
    setWaitingForInput: vi.fn(),
    setPendingAsk: vi.fn(),
    pushInbox: vi.fn(),
    updateInboxText: vi.fn(),
    pushStatus: vi.fn(),
    updateStatusText: vi.fn(),
    setTodos: vi.fn(),
    rename: vi.fn(),
    employeeFor: vi.fn((key: string) => ({ id: 'emp-1', name: 'E', seat: 1, variant: 'Knight', hiredAt: '', status: 'working', task: 'Agent: explore' })),
    lastInboxId: 'inbox-1',
    lastStatusId: 'status-1',
  } as unknown as Office;
  const streamer = {
    enqueue: vi.fn((id: string, text: string) => enqueued.push({ id, text })),
    isDraining: () => false,
    clear: vi.fn(),
    stop: vi.fn(),
  } as unknown as ScreenStreamer;
  const stats = {
    recordUsage: vi.fn(),
    recordTool: vi.fn(),
    recordPrompt: vi.fn(),
    recordSession: vi.fn(),
    recordTurn: vi.fn(),
    recordHeadcount: vi.fn(),
    recordHire: vi.fn(),
    isDirty: vi.fn(() => false),
    flush: vi.fn(),
    snapshot: vi.fn(),
  };
  const transcripts = new Transcripts(office, streamer, stats as any);
  const pickup = (key: string, id = 'emp-9') =>
    onAssignCb?.(key, { id, name: 'Q', seat: 9, variant: 'Knight', hiredAt: '', status: 'working', task: null });
  return { transcripts, office, enqueued, monitors, finished, pickup, stats };
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

  it('emits image blocks from a Read tool_result as marker lines, before the text', () => {
    const { transcripts, enqueued } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-img', name: 'Read', input: { file_path: '/tmp/shot.png' } }] },
      }),
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-img',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
            },
          ],
        },
      }),
    ]);
    expect(enqueued[1].text).toBe('⟦IMG⟧data:image/png;base64,AAAA');
    expect(enqueued[2].text).toContain('✓ done');
  });

  it('a section boundary + title goes directly to office.monitor on start', () => {
    const { transcripts, monitors } = makeHarness();
    startBash(transcripts);
    expect(monitors[0]).toMatchObject({ target: 'emp-1', section: true, title: 'Bash · myapp' });
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

  it('streams subagent text, thinking (💭-prefixed) on the Task screen; tool_use fans out to its own employee', () => {
    const { transcripts, enqueued } = makeHarness();
    startTask(transcripts);
    const taskEmpId = enqueued[0].id;

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

    const taskTexts = enqueued.filter((e) => e.id === taskEmpId).map((e) => e.text);
    expect(taskTexts).toContain('💭 let me look at the files');
    expect(taskTexts).toContain('Reading the config now.');
    expect(taskTexts).toContain('> Read'); // breadcrumb only; full preview/result land on the child's own employee
    expect(taskTexts).not.toContain('export const config = {...}\n\n✓ done');

    const childTexts = enqueued.filter((e) => e.id !== taskEmpId).map((e) => e.text);
    expect(childTexts).toContain('read /app/config.ts');
    expect(childTexts).toContain('export const config = {...}\n\n✓ done');
  });
});

describe('subagent tool fan-out', () => {
  function startTask(t: Transcripts) {
    t.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
    ]);
    t.fileAppeared(AGENT);
  }

  it('a subagent tool_use gets its own assign/monitor/preview; the Task screen gets a breadcrumb', () => {
    const { transcripts, office, enqueued, monitors } = makeHarness();
    startTask(transcripts);
    const taskEmpId = enqueued[0].id; // emp-1

    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }] },
      }),
    ]);

    expect(office.assign).toHaveBeenCalledWith('sess-1:tu-sub-1', 'Read');
    const childMonitor = monitors.find((m) => m.title === 'Read · myapp');
    expect(childMonitor).toBeDefined();
    expect(childMonitor.target).not.toBe(taskEmpId);
    expect(enqueued.some((e) => e.id === childMonitor.target && e.text === 'read /app/config.ts')).toBe(true);
    expect(enqueued.some((e) => e.id === taskEmpId && e.text === '> Read')).toBe(true);
  });

  it("a fanned-out child's tool_result finishes on its own employee via finishTool", () => {
    const { transcripts, enqueued, finished } = makeHarness();
    startTask(transcripts);
    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }] },
      }),
    ]);
    const childEmpId = enqueued.at(-1)!.id;
    transcripts.handleLines(AGENT, [
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-sub-1', content: 'export const config = {...}' }] },
      }),
    ]);
    const childTexts = enqueued.filter((e) => e.id === childEmpId).map((e) => e.text);
    expect(childTexts).toContain('export const config = {...}\n\n✓ done');
    expect(finished).toContain('sess-1:tu-sub-1');
  });

  it('a nested Task/Agent tool_use inside a subagent stays a one-line breadcrumb, not fanned out', () => {
    const { transcripts, office, enqueued } = makeHarness();
    startTask(transcripts);
    const assignCallsBefore = vi.mocked(office.assign).mock.calls.length;
    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-nested', name: 'Task', input: { description: 'nested work' } }] },
      }),
    ]);
    expect(vi.mocked(office.assign).mock.calls.length).toBe(assignCallsBefore); // no new assign for the nested Task
    expect(enqueued.some((e) => e.text.startsWith('> Task'))).toBe(true);
  });

  it('a Task finishing closes any still-open (assigned) children so their desk is freed', () => {
    const { transcripts, enqueued, finished } = makeHarness();
    startTask(transcripts);
    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }] },
      }),
    ]);
    const childEmpId = enqueued.at(-1)!.id;
    // The Task's own tool_result arrives before the child's ever does (race being guarded against).
    transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-task', content: 'done exploring' }] },
      }),
    ]);
    expect(finished).toContain('sess-1:tu-sub-1');
    expect(enqueued.some((e) => e.id === childEmpId && e.text === '✓ done')).toBe(true);
  });

  it('a still-queued (unassigned) child is cancelled, not left stranded, when its Task finishes', () => {
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
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }] },
      }),
    ]);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-task', content: 'done exploring' }] },
      }),
    ]);
    expect(h.office.cancelQueued).toHaveBeenCalledWith('sess-1:tu-sub-1');
  });

  it('a duplicate/replayed subagent tool_use line does not re-fan-out (no second assign/monitor/preview/breadcrumb)', () => {
    const { transcripts, office, enqueued, monitors } = makeHarness();
    startTask(transcripts);
    const dupLine = line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }] },
    });
    transcripts.handleLines(AGENT, [dupLine]);
    transcripts.handleLines(AGENT, [dupLine]); // replayed/duplicate line, same toolUseId

    expect(vi.mocked(office.assign).mock.calls.filter((c) => c[0] === 'sess-1:tu-sub-1')).toHaveLength(1);
    expect(monitors.filter((m) => m.title === 'Read · myapp')).toHaveLength(1);
    expect(enqueued.filter((e) => e.text === 'read /app/config.ts')).toHaveLength(1);
    expect(enqueued.filter((e) => e.text === '> Read')).toHaveLength(1);
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
    expect(monitors[0]).toMatchObject({ target: 'emp-1', section: true, title: 'Reporting to the Boss · myapp' });
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

  it('fans out a tool_use replayed from the buffer when the file appeared before the Task tool_use', () => {
    const { transcripts, office, enqueued, monitors } = makeHarness();
    transcripts.fileAppeared(AGENT);
    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }] },
      }),
    ]); // buffered, no activity yet
    expect(enqueued).toEqual([]);
    transcripts.handleLines(MAIN, [taskLine]);
    expect(office.assign).toHaveBeenCalledWith('sess-1:tu-sub-1', 'Read');
    const childMonitor = monitors.find((m) => m.title === 'Read · myapp');
    expect(childMonitor).toBeDefined();
    expect(enqueued.some((e) => e.id === childMonitor.target && e.text === 'read /app/config.ts')).toBe(true);
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
    // Screen still gets its section/title + input preview even with no file attached yet.
    expect(monitors[0]).toMatchObject({ section: true, title: 'Agent: explore · myapp' });
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
    expect(h.monitors.at(-1)).toMatchObject({ target: 'emp-9', section: true, title: 'Bash · myapp' });
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

describe('waiting-for-input detection', () => {
  const MAIN2 = '/proj/-home-user-code-myapp/sess-2.jsonl';
  const OTHER = '/proj/-home-user-code-otherapp/sess-9.jsonl';

  function endTurn(file: string, t: Transcripts) {
    t.handleLines(file, [
      line({
        type: 'assistant',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] },
      }),
    ]);
  }

  function userPrompt(file: string, t: Transcripts) {
    t.handleLines(file, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: 'please continue' }] },
      }),
    ]);
  }

  it('an end_turn response marks the office as waiting', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
  });

  it('a tool_use response does not mark waiting', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    const calls = vi.mocked(h.office.setWaitingForInput).mock.calls;
    expect(calls.every((c) => c[0] === false)).toBe(true);
  });

  it('a user prompt clears waiting', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    userPrompt(MAIN, h.transcripts);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('a tool result clears waiting for that session', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('any waiting project keeps the flag on until every project resumes', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    endTurn(OTHER, h.transcripts);
    userPrompt(OTHER, h.transcripts);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
    userPrompt(MAIN, h.transcripts);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it("a user prompt in a new file for the same project clears the old file's waiting entry", () => {
    // resume/fork/compact write a NEW jsonl in the same project dir; the old
    // file's entry must not pin the light for the stale-sweep duration
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    userPrompt(MAIN2, h.transcripts);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it("user activity in one project leaves another project's waiting flag on", () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    userPrompt(OTHER, h.transcripts);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
  });

  it('a slash command clears waiting', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: '<command-name>/foo</command-name><command-message>foo</command-message>' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('an interrupt clears waiting', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('a meta user line clears waiting', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        isMeta: true,
        message: { content: [{ type: 'text', text: 'Caveat: injected context' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('a task-notification clears waiting', () => {
    const h = makeHarness();
    endTurn(MAIN, h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: '<task-notification>agent done</task-notification>' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('subagent end_turn lines never mark waiting', () => {
    const h = makeHarness();
    h.transcripts.fileAppeared(AGENT);
    h.transcripts.handleLines(AGENT, [
      line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'sub done' }] } }),
    ]);
    const calls = vi.mocked(h.office.setWaitingForInput).mock.calls;
    expect(calls.every((c) => c[0] === false)).toBe(true);
  });

  /**
   * The whole point of ASK_TOOLS: these responses carry stop_reason 'tool_use'
   * like any other, so without the name check they'd switch the light OFF at the
   * moment the session is blocked on the user.
   */
  function askTool(t: Transcripts, tu: Record<string, unknown>, file = MAIN) {
    t.handleLines(file, [
      line({
        type: 'assistant',
        sessionId: 'sess-x',
        cwd: '/home/user/code/myapp',
        message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', ...tu }] },
      }),
    ]);
  }

  it('a pending plan approval marks the office as waiting', () => {
    const h = makeHarness();
    askTool(h.transcripts, { id: 'tu-plan', name: 'ExitPlanMode', input: { plan: '# Rewire the beacon\n\nsome detail' } });
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
    expect(vi.mocked(h.office.setPendingAsk).mock.lastCall?.[0]).toMatchObject({
      id: 'tu-plan',
      kind: 'plan',
      summary: 'Rewire the beacon',
      options: [],
      project: 'myapp',
    });
  });

  it('a pending question carries its menu labels in order', () => {
    const h = makeHarness();
    askTool(h.transcripts, {
      id: 'tu-q',
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Which approach?', options: [{ label: 'Rewrite' }, { label: 'Patch' }] },
          { question: 'And the tests?', options: [{ label: 'Later' }] },
        ],
      },
    });
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
    expect(vi.mocked(h.office.setPendingAsk).mock.lastCall?.[0]).toMatchObject({
      kind: 'question',
      summary: 'Which approach? (+1 more)',
      options: ['Rewrite', 'Patch'],
    });
  });

  it('answering a plan approval clears waiting', () => {
    const h = makeHarness();
    askTool(h.transcripts, { id: 'tu-plan', name: 'ExitPlanMode', input: { plan: '# Do it' } });
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-x',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-plan', content: 'approved' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
  });

  it('re-reading the same ask line does not re-announce it', () => {
    const h = makeHarness();
    const tu = { id: 'tu-plan', name: 'ExitPlanMode', input: { plan: '# Do it' } };
    askTool(h.transcripts, tu);
    askTool(h.transcripts, tu);
    expect(vi.mocked(h.office.setPendingAsk).mock.calls).toHaveLength(1);
    expect(vi.mocked(h.office.pushStatus).mock.calls.filter((c) => c[0] === 'ask')).toHaveLength(1);
  });

  it('a stale waiting session stops holding the light after the sweep', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      endTurn(MAIN, h.transcripts);
      expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
      vi.advanceTimersByTime(9 * 60_000);
      expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
      vi.advanceTimersByTime(2 * 60_000);
      expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function userText(text: string, extra: Record<string, unknown> = {}) {
  return line({
    type: 'user',
    sessionId: 'sess-1',
    cwd: '/home/user/code/myapp',
    message: { content: [{ type: 'text', text }] },
    ...extra,
  });
}

describe('tagged user text', () => {
  it('surfaces slash commands as a Slash Command screen', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      userText('<command-message>help</command-message>\n<command-name>/help</command-name>\n<command-args>--verbose</command-args>'),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Slash Command');
    expect(h.enqueued[0].text).toBe('ran /help --verbose\nhelp');
    expect(h.finished).toHaveLength(1);
    expect(h.office.pushInbox).not.toHaveBeenCalled();
  });

  it('surfaces local command stdout as a Command Output screen', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [userText('<local-command-stdout>build ok\nall green</local-command-stdout>')]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Command Output');
    expect(h.enqueued[0].text).toBe('build ok\nall green');
  });

  it('surfaces ! shell passthrough with stderr marked as errors', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      userText('<bash-input>ls /tmp</bash-input>\n<bash-stdout>a.txt</bash-stdout>\n<bash-stderr>oh no</bash-stderr>'),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Shell (!)');
    expect(h.enqueued[0].text).toBe('! ls /tmp\na.txt\n✗ oh no');
  });

  it('surfaces task notifications via their summary and result', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      userText('<task-notification>\n<task-id>t1</task-id>\n<summary>Agent finished</summary>\n<result>found 3 bugs</result>\n</task-notification>'),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Task Notification');
    expect(h.enqueued[0].text).toBe('Agent finished\nfound 3 bugs');
  });

  it('routes unknown tags and system-reminders to the housekeeping digest, not a screen of their own', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.transcripts.handleLines(MAIN, [
        userText('<system-reminder>background context here</system-reminder>'),
        userText('<some-new-tag>mystery payload</some-new-tag>'),
      ]);
      expect(h.office.assign).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3100);
      expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Office Chores');
      expect(h.enqueued[0].text).toBe('reminder: background context here\nsome-new-tag: mystery payload');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still routes a plain prompt to the inbox (regression)', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [userText('please fix the login page')]);
    expect(h.office.pushInbox).toHaveBeenCalledWith('myapp', 'please fix the login page', 'please fix the login page');
  });

  it('surfaces a user interrupt', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [userText('[Request interrupted by user]')]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Interrupted');
    expect(h.enqueued[0].text).toBe('✗ the Boss interrupted');
    expect(h.office.pushInbox).not.toHaveBeenCalled();
  });
});

describe('tool errors and rich results', () => {
  it('an is_error tool_result ends with ✗ failed, not ✓ done', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'command not found', is_error: true }] },
      }),
    ]);
    expect(h.enqueued[1].text).toBe('command not found\n\n✗ failed');
  });

  it('a denied tool shows ✗ blocked with the denial kind', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        toolDenialKind: 'user-rejected',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'The user rejected this tool call' }] },
      }),
    ]);
    expect(h.enqueued[1].text).toContain('✗ blocked (user-rejected)');
  });

  it('an Edit result renders the structuredPatch from the toolUseResult sidecar', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-e', name: 'Edit', input: { file_path: '/a.ts', old_string: 'foo', new_string: 'bar' } }] },
      }),
      line({
        type: 'user',
        sessionId: 'sess-1',
        toolUseResult: { structuredPatch: [{ lines: ['-foo', '+bar'] }] },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-e', content: 'File updated' }] },
      }),
    ]);
    expect(h.enqueued.at(-1)!.text).toBe('-foo\n+bar\n\n✓ done');
  });

  it('Write and Edit input previews include the content being written', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-w', name: 'Write', input: { file_path: '/b.ts', content: 'line one\nline two' } },
            { type: 'tool_use', id: 'tu-e2', name: 'Edit', input: { file_path: '/c.ts', old_string: 'old', new_string: 'new' } },
          ],
        },
      }),
    ]);
    const texts = h.enqueued.map((e) => e.text);
    expect(texts).toContain('write /b.ts\nline one\nline two');
    expect(texts).toContain('edit /c.ts\n- old\n+ new');
  });

  it('strips embedded system-reminder spans from tool_result text', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'real output<system-reminder>host noise</system-reminder>' }],
        },
      }),
    ]);
    expect(h.enqueued[1].text).toBe('real output\n\n✓ done');
  });

  it('text sharing a user line with tool_results still finishes the tool AND claims a Note from the Boss', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
            { type: 'text', text: 'also please check the tests' },
          ],
        },
      }),
    ]);
    expect(h.finished).toContain('sess-1:tu-1');
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Note from the Boss');
    expect(h.enqueued.map((e) => e.text)).toContain('also please check the tests');
  });
});

describe('images', () => {
  it('surfaces images attached to a user prompt', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: {
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
            { type: 'text', text: 'look at this screenshot' },
          ],
        },
      }),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Attachment from the Boss');
    expect(h.enqueued[0].text).toBe('⟦IMG⟧data:image/jpeg;base64,BBBB\nlook at this screenshot');
  });

  it('passes URL-sourced tool_result images through as marker lines', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/i.png' } }] },
          ],
        },
      }),
    ]);
    expect(h.enqueued[1].text).toBe('⟦IMG⟧https://x.test/i.png');
  });
});

describe('assistant-side events', () => {
  it('surfaces API error lines as API Trouble', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] },
      }),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'API Trouble');
    expect(h.enqueued[0].text).toBe('✗ server_error 529\nAPI Error: 529 Overloaded');
  });

  it('surfaces model fallback blocks as Model Swap', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } }] },
      }),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Model Swap');
    expect(h.enqueued[0].text).toBe('⚠ model fallback: claude-fable-5 → claude-opus-4-8');
  });

  it('renders redacted_thinking as a redacted thought in the boss reply', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'msg-r',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'redacted_thinking', data: 'xxx' }, { type: 'text', text: 'done' }] },
      }),
    ]);
    expect(h.enqueued[0].text).toBe('💭 [redacted]\ndone');
  });
});

describe('status whiteboard feed', () => {
  it('a boss prompt pushes a status line', () => {
    // (the summarizer-rewrite mechanics are covered by office.test.ts updateStatusText)
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: 'please fix the login bug' }] },
      }),
    ]);
    expect(h.office.pushStatus).toHaveBeenCalledWith('boss', 'Message from upstairs: please fix the login bug');
  });

  it('a finishing Task pushes a done status with the employee name and task', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-task', content: 'found it' }] },
      }),
    ]);
    expect(h.office.pushStatus).toHaveBeenCalledWith('done', 'E finished Agent: explore');
  });

  it('a plain Bash finish pushes nothing', () => {
    const h = makeHarness();
    startBash(h.transcripts);
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
      }),
    ]);
    const kinds = vi.mocked(h.office.pushStatus).mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain('done');
  });

  it('a failed Task pushes no done status', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
      line({
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-task', content: 'boom', is_error: true }] },
      }),
    ]);
    const kinds = vi.mocked(h.office.pushStatus).mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain('done');
  });

  it('plan approval, away summaries, and session titles push their kinds', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({ type: 'attachment', sessionId: 'sess-1', cwd: '/home/user/code/myapp', attachment: { type: 'plan_mode_exit', planFilePath: '/tmp/plan.md' } }),
      line({ type: 'system', subtype: 'away_summary', sessionId: 'sess-1', cwd: '/home/user/code/myapp', content: 'I fixed three bugs.' }),
      line({ type: 'ai-title', aiTitle: 'Fixing login', sessionId: 'sess-1', cwd: '/home/user/code/myapp' }),
    ]);
    const calls = vi.mocked(h.office.pushStatus).mock.calls;
    expect(calls).toContainEqual(['plan', 'Plan approved · myapp']);
    expect(calls).toContainEqual(['away', 'While you were away: I fixed three bugs.']);
    expect(calls).toContainEqual(['session', 'Looking at myapp: “Fixing login”']);
  });
});

describe('system and attachment events', () => {
  it('surfaces away summaries on their own screen', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({ type: 'system', subtype: 'away_summary', sessionId: 'sess-1', cwd: '/home/user/code/myapp', content: 'I fixed three bugs while you were out.' }),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'While You Were Away');
    expect(h.enqueued[0].text).toBe('I fixed three bugs while you were out.');
  });

  it('surfaces hook runs with output; silent hooks go to the digest', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.transcripts.handleLines(MAIN, [
        line({
          type: 'attachment',
          sessionId: 'sess-1',
          cwd: '/home/user/code/myapp',
          attachment: { type: 'hook_success', hookName: 'lint', command: 'npm run lint', stdout: 'all clean', stderr: '', exitCode: 0, durationMs: 40 },
        }),
        line({
          type: 'attachment',
          sessionId: 'sess-1',
          cwd: '/home/user/code/myapp',
          attachment: { type: 'hook_success', hookName: 'fmt', command: 'fmt', stdout: '', stderr: '', exitCode: 0, durationMs: 5 },
        }),
      ]);
      expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Hook: lint');
      expect(h.enqueued[0].text).toBe('$ npm run lint\nall clean');
      vi.advanceTimersByTime(3100);
      expect(h.enqueued.at(-1)!.text).toBe('hook fmt ok (5ms)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('batches housekeeping bursts into a single Office Chores screen', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.transcripts.handleLines(MAIN, [
        line({ type: 'attachment', sessionId: 'sess-1', cwd: '/home/user/code/myapp', attachment: { type: 'skill_listing', skillCount: 12 } }),
        line({ type: 'attachment', sessionId: 'sess-1', cwd: '/home/user/code/myapp', attachment: { type: 'command_permissions', allowedTools: ['a', 'b'] } }),
        line({ type: 'attachment', sessionId: 'sess-1', cwd: '/home/user/code/myapp', attachment: { type: 'task_reminder', itemCount: 4 } }),
        line({ type: 'system', subtype: 'turn_duration', sessionId: 'sess-1', cwd: '/home/user/code/myapp', durationMs: 12000, messageCount: 7 }),
      ]);
      expect(h.office.assign).not.toHaveBeenCalled(); // nothing claims a desk mid-burst
      vi.advanceTimersByTime(3100);
      expect(vi.mocked(h.office.assign).mock.calls).toHaveLength(1);
      expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Office Chores');
      expect(h.enqueued[0].text).toBe(
        'skills: 12 available\npermissions: 2 tools allowed\ntodo reminder (4 items)\nturn: 12s, 7 msgs',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a full digest flushes immediately without waiting for quiet', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const lines = Array.from({ length: 20 }, (_, i) =>
        line({ type: 'attachment', sessionId: 'sess-1', cwd: '/home/user/code/myapp', attachment: { type: 'date_change', newDate: `d${i}` } }),
      );
      h.transcripts.handleLines(MAIN, lines);
      expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Office Chores');
      expect(h.enqueued[0].text.split('\n')).toHaveLength(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('system/attachment lines never flip the waiting-for-input light', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] },
      }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
    h.transcripts.handleLines(MAIN, [
      line({ type: 'attachment', sessionId: 'sess-1', cwd: '/home/user/code/myapp', attachment: { type: 'skill_listing', skillCount: 3 } }),
      line({ type: 'system', subtype: 'turn_duration', sessionId: 'sess-1', cwd: '/home/user/code/myapp', durationMs: 100, messageCount: 1 }),
    ]);
    expect(vi.mocked(h.office.setWaitingForInput).mock.lastCall).toEqual([true]);
  });
});

describe('sidecar records', () => {
  it('an envelope-less ai-title record surfaces and titles later ephemerals', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [line({ type: 'ai-title', aiTitle: 'Fix login flow', sessionId: 'sess-1' })]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Session Titled');
    expect(h.monitors[0].title).toBe('Session Titled · myapp');
    expect(h.enqueued[0].text).toBe('“Fix login flow”');

    h.transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        uuid: 'msg-t',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'text', text: 'on it' }] },
      }),
    ]);
    expect(h.monitors.at(-1)!.title).toBe('Reporting to the Boss · myapp — Fix login flow');
  });

  it('a queued prompt (queue-operation enqueue) surfaces its content', () => {
    const h = makeHarness();
    h.transcripts.handleLines(MAIN, [
      line({ type: 'queue-operation', operation: 'enqueue', sessionId: 'sess-1', content: 'next: update the docs' }),
    ]);
    expect(h.office.assign).toHaveBeenCalledWith(expect.any(String), 'Queued Prompt');
    expect(h.enqueued[0].text).toBe('next: update the docs');
  });

  it('unknown and legacy record types land in the digest without throwing', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.transcripts.handleLines(MAIN, [
        line({ type: 'summary', summary: 'old style', leafUuid: 'x' }),
        line({ type: 'file-history-snapshot', messageId: 'm1', snapshot: {} }),
        line({ type: 'some-future-type', sessionId: 'sess-1' }),
      ]);
      vi.advanceTimersByTime(3100);
      expect(h.enqueued[0].text).toBe('summary\nfile-history-snapshot\nsome-future-type');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stats aggregator wiring', () => {
  it('records usage and tool calls from a main-transcript assistant line', () => {
    const { transcripts, stats } = makeHarness();
    const usage = { input_tokens: 10, output_tokens: 5 };
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: {
          id: 'msg-1',
          model: 'claude-fable-5',
          usage,
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
    ]);
    expect(stats.recordUsage).toHaveBeenCalledWith('msg-1', 'claude-fable-5', usage);
    expect(stats.recordTool).toHaveBeenCalledWith('Bash', 'tu-1');
  });

  it('records usage twice for a streamed repeat of the same message id (dedupe is the aggregator\'s job)', () => {
    const { transcripts, stats } = makeHarness();
    const makeLine = (usage: unknown) =>
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { id: 'msg-1', model: 'claude-fable-5', usage, content: [{ type: 'text', text: 'thinking' }] },
      });
    transcripts.handleLines(MAIN, [makeLine({ input_tokens: 10, output_tokens: 5 })]);
    transcripts.handleLines(MAIN, [makeLine({ input_tokens: 10, output_tokens: 8 })]);
    expect(stats.recordUsage).toHaveBeenCalledTimes(2);
  });

  it('records one recordTool call per tool_use block on an assistant line', () => {
    const { transcripts, stats } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'a' } },
            { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: 'b' } },
          ],
        },
      }),
    ]);
    expect(stats.recordTool).toHaveBeenCalledWith('Bash', 'tu-1');
    expect(stats.recordTool).toHaveBeenCalledWith('Read', 'tu-2');
    expect(stats.recordTool).toHaveBeenCalledTimes(2);
  });

  it('records usage and tool calls from a subagent-transcript assistant line', () => {
    const { transcripts, stats } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        message: { content: [{ type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'explore' } }] },
      }),
    ]);
    transcripts.fileAppeared(AGENT);
    const usage = { input_tokens: 3, output_tokens: 2 };
    transcripts.handleLines(AGENT, [
      line({
        type: 'assistant',
        message: {
          id: 'sub-msg-1',
          model: 'claude-fable-5',
          usage,
          content: [{ type: 'tool_use', id: 'tu-sub-1', name: 'Read', input: { file_path: '/app/config.ts' } }],
        },
      }),
    ]);
    expect(stats.recordUsage).toHaveBeenCalledWith('sub-msg-1', 'claude-fable-5', usage);
    expect(stats.recordTool).toHaveBeenCalledWith('Read', 'tu-sub-1');
  });

  it('records a turn_duration system record, forwarding the line uuid for replay dedupe', () => {
    const { transcripts, stats } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({
        type: 'system',
        subtype: 'turn_duration',
        sessionId: 'sess-1',
        cwd: '/home/user/code/myapp',
        uuid: 'turn-uuid-1',
        durationMs: 12000,
        messageCount: 7,
      }),
    ]);
    expect(stats.recordTurn).toHaveBeenCalledWith(12000, 'turn-uuid-1');
  });

  it('records a real user prompt but not meta/tool-result user lines, forwarding the line uuid', () => {
    const { transcripts, stats } = makeHarness();
    transcripts.handleLines(MAIN, [userText('please fix the login page', { uuid: 'prompt-uuid-1' })]);
    expect(stats.recordPrompt).toHaveBeenCalledTimes(1);
    expect(stats.recordPrompt).toHaveBeenCalledWith('prompt-uuid-1');

    transcripts.handleLines(MAIN, [userText('Caveat: injected context', { isMeta: true })]);
    expect(stats.recordPrompt).toHaveBeenCalledTimes(1);

    transcripts.handleLines(MAIN, [
      line({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-x', content: 'ok' }] },
      }),
    ]);
    expect(stats.recordPrompt).toHaveBeenCalledTimes(1);
  });

  it('forwards the same uuid every time a line is replayed, so the aggregator ring can dedupe it', () => {
    // Resume/fork/compact copies prior history lines (same uuid) into a NEW jsonl
    // file the watcher reads from offset 0. transcript.ts's job is just to forward
    // the id consistently; StatsAggregator (covered in stats.test.ts) is what
    // actually recognizes the repeat and skips counting it twice.
    const { transcripts, stats } = makeHarness();
    const prompt = userText('please fix the login page', { uuid: 'prompt-uuid-replay' });
    transcripts.handleLines(MAIN, [prompt]);
    transcripts.handleLines(MAIN, [prompt]);
    expect(stats.recordPrompt).toHaveBeenCalledTimes(2);
    expect(stats.recordPrompt).toHaveBeenNthCalledWith(1, 'prompt-uuid-replay');
    expect(stats.recordPrompt).toHaveBeenNthCalledWith(2, 'prompt-uuid-replay');
  });

  it('records the session id for any main line carrying one', () => {
    const { transcripts, stats } = makeHarness();
    transcripts.handleLines(MAIN, [
      line({ type: 'system', subtype: 'away_summary', sessionId: 'sess-1', cwd: '/home/user/code/myapp', content: 'back now' }),
    ]);
    expect(stats.recordSession).toHaveBeenCalledWith('sess-1');
  });
});

describe('hire naming (no LLM)', () => {
  it('names an auto-hired employee synchronously from the built-in list', () => {
    const h = makeHarness({ hire: true });
    startBash(h.transcripts, 'tu-hire');
    // no await anywhere: the rename lands in the same tick as the hire
    expect(vi.mocked(h.office.pickHireName).mock.calls.length).toBe(1);
    expect(vi.mocked(h.office.rename).mock.lastCall?.[1]).toBe('Tab Completion');
    expect(
      vi.mocked(h.office.pushStatus).mock.calls.some(
        (c) => c[0] === 'hire' && String(c[1]).includes('Tab Completion'),
      ),
    ).toBe(true);
  });

  it('leaves a rehire into a remembered seat alone', () => {
    const h = makeHarness(); // employee comes back named 'E', hired: false
    startBash(h.transcripts, 'tu-rehire');
    expect(vi.mocked(h.office.pickHireName).mock.calls.length).toBe(0);
    expect(vi.mocked(h.office.rename).mock.calls.length).toBe(0);
  });
});

describe('user prompt display (no summary)', () => {
  it('shows the prompt itself and never rewrites it afterwards', async () => {
    const h = makeHarness();
    const prompt = 'Please refactor the parser and add tests';
    h.transcripts.handleLines(MAIN, [
      line({ type: 'user', sessionId: 'sess-1', cwd: '/home/user/code/myapp', message: { role: 'user', content: prompt } }),
    ]);
    expect(vi.mocked(h.office.pushInbox).mock.lastCall?.[1]).toBe(prompt);
    expect(vi.mocked(h.office.pushStatus).mock.lastCall?.[1]).toContain(prompt);

    // the old summarizer rewrote both a tick later; nothing may do that now
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(h.office.updateInboxText).mock.calls.length).toBe(0);
    expect(vi.mocked(h.office.updateStatusText).mock.calls.length).toBe(0);
  });

  it('clips only the status/inbox preview, keeping the full prompt as fullText', () => {
    const h = makeHarness();
    const long = 'x'.repeat(500);
    h.transcripts.handleLines(MAIN, [
      line({ type: 'user', sessionId: 'sess-1', cwd: '/home/user/code/myapp', message: { role: 'user', content: long } }),
    ]);
    const call = vi.mocked(h.office.pushInbox).mock.lastCall!;
    expect(call[1]).toBe('x'.repeat(157) + '…'); // preview: the real text, clipped
    expect(call[2]).toBe(long); // fullText: untouched, what the focus camera scrolls
  });
});

describe('describeAsk', () => {
  it('prefers the plan headline over its first prose line', () => {
    const ask = describeAsk({ id: 'a', name: 'ExitPlanMode', input: { plan: '\n## Fix the light\n\nbody' } }, 'p');
    expect(ask.summary).toBe('Fix the light');
  });

  it('falls back to the first prose line, then to a default', () => {
    expect(describeAsk({ id: 'a', name: 'ExitPlanMode', input: { plan: 'just do it\nmore' } }, 'p').summary).toBe('just do it');
    expect(describeAsk({ id: 'a', name: 'ExitPlanMode', input: {} }, 'p').summary).toBe('Plan ready for approval');
  });

  it('caps a long summary, leaving room for the +N suffix', () => {
    const long = 'x'.repeat(300);
    expect(describeAsk({ id: 'a', name: 'ExitPlanMode', input: { plan: long } }, 'p').summary).toHaveLength(120);
    const q = describeAsk(
      { id: 'a', name: 'AskUserQuestion', input: { questions: [{ question: long }, { question: 'b' }] } },
      'p',
    );
    expect(q.summary).toHaveLength(120);
    expect(q.summary.endsWith(' (+1 more)')).toBe(true);
  });

  it('drops option entries with no label rather than showing blanks', () => {
    const ask = describeAsk(
      { id: 'a', name: 'AskUserQuestion', input: { questions: [{ question: 'q', options: [{ label: 'A' }, {}] }] } },
      'p',
    );
    expect(ask.options).toEqual(['A']);
  });
});
