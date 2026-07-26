import { describe, expect, it } from 'vitest';
import type { OfficeState, TodoItem } from '../../../shared/types.ts';
import { boardContent, TODO_STALE_MS } from './whiteboardContent.ts';

function makeOffice(overrides: Partial<OfficeState>): OfficeState {
  return {
    officeName: 'This Office',
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [],
    inbox: [],
    todos: null,
    status: [],
    staffing: { minEmployees: 1, maxEmployees: 5, idleTimeoutSec: 60 },
    waitingForInput: false,
    ...overrides,
  };
}

const NOW = Date.parse('2026-07-25T12:00:00Z');

function todosAt(items: TodoItem[], ageMs: number) {
  return { project: 'thisoffice', items, at: new Date(NOW - ageMs).toISOString() };
}

describe('boardContent', () => {
  it('returns empty when there is no office or no todos', () => {
    expect(boardContent(null)).toEqual({ mode: 'empty' });
    expect(boardContent(makeOffice({}))).toEqual({ mode: 'empty' });
    expect(boardContent(makeOffice({ todos: { project: 'p', items: [], at: new Date(NOW).toISOString() } }), NOW)).toEqual({
      mode: 'empty',
    });
  });

  it('shows todos even when the inbox and employees have activity (synopsis lives on the status board)', () => {
    const office = makeOffice({
      todos: todosAt([{ content: 'Ship it', status: 'pending' }], 0),
      inbox: [{ id: 'i1', project: 'thisoffice', text: 'Doing a thing', at: new Date(NOW).toISOString() }],
    });
    expect(boardContent(office, NOW)).toEqual({
      mode: 'todos',
      project: 'thisoffice',
      items: [{ content: 'Ship it', status: 'pending' }],
    });
  });

  it('keeps a fresh all-completed list on the board', () => {
    const office = makeOffice({ todos: todosAt([{ content: 'x', status: 'completed' }], TODO_STALE_MS - 60_000) });
    expect(boardContent(office, NOW).mode).toBe('todos');
  });

  it('drops an all-completed list once it goes stale', () => {
    const office = makeOffice({ todos: todosAt([{ content: 'x', status: 'completed' }], TODO_STALE_MS + 60_000) });
    expect(boardContent(office, NOW)).toEqual({ mode: 'empty' });
  });

  it('an old list with unfinished items never goes stale', () => {
    const office = makeOffice({
      todos: todosAt(
        [
          { content: 'done', status: 'completed' },
          { content: 'still open', status: 'pending' },
        ],
        TODO_STALE_MS * 10,
      ),
    });
    expect(boardContent(office, NOW).mode).toBe('todos');
  });

  it('an all-completed list without a timestamp (old server) is stale immediately', () => {
    const office = makeOffice({
      todos: { project: 'thisoffice', items: [{ content: 'x', status: 'completed' }] },
    });
    expect(boardContent(office, NOW)).toEqual({ mode: 'empty' });
  });
});
