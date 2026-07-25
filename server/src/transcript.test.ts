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
