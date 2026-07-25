import { describe, expect, it } from 'vitest';
import type { Employee, InboxItem, OfficeState } from '../../../shared/types.ts';
import { boardContent } from './whiteboardContent.ts';

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: 'e1',
    name: 'Alice',
    seat: 1,
    variant: 'Knight',
    hiredAt: new Date().toISOString(),
    status: 'idle',
    task: null,
    ...overrides,
  };
}

function makeInbox(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: 'i1',
    project: 'thisoffice',
    text: 'Doing a thing',
    at: new Date().toISOString(),
    ...overrides,
  };
}

function makeOffice(overrides: Partial<OfficeState>): OfficeState {
  return {
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [],
    inbox: [],
    todos: null,
    staffing: { minEmployees: 1, maxEmployees: 5, idleTimeoutSec: 60 },
    waitingForInput: false,
    ...overrides,
  };
}

describe('boardContent', () => {
  it('returns empty when there is no office', () => {
    expect(boardContent(null)).toEqual({ mode: 'empty' });
  });

  it('returns empty when the office has no todos, inbox, or working employees', () => {
    const office = makeOffice({});
    expect(boardContent(office)).toEqual({ mode: 'empty' });
  });

  it('prefers real todos over a synopsis, even with inbox and working employees present', () => {
    const office = makeOffice({
      todos: { project: 'thisoffice', items: [{ content: 'Ship it', status: 'pending' }] },
      inbox: [makeInbox({})],
      employees: [makeEmployee({ status: 'working', task: 'Bash' })],
    });
    const result = boardContent(office);
    expect(result.mode).toBe('todos');
    if (result.mode === 'todos') {
      expect(result.project).toBe('thisoffice');
      expect(result.items).toEqual([{ content: 'Ship it', status: 'pending' }]);
    }
  });

  it('falls back to synopsis when todos is null', () => {
    const office = makeOffice({
      todos: null,
      inbox: [makeInbox({ project: 'thisoffice', text: 'Refactoring the whiteboard' })],
      employees: [
        makeEmployee({ id: 'e2', name: 'Bob', seat: 2, status: 'working', task: 'Edit' }),
        makeEmployee({ id: 'e1', name: 'Alice', seat: 1, status: 'working', task: 'Bash' }),
      ],
    });
    const result = boardContent(office);
    expect(result).toEqual({
      mode: 'synopsis',
      project: 'thisoffice',
      summary: 'Refactoring the whiteboard',
      workers: [
        { name: 'Alice', task: 'Bash' },
        { name: 'Bob', task: 'Edit' },
      ],
    });
  });

  it('falls back to synopsis when todos has empty items', () => {
    const office = makeOffice({
      todos: { project: 'thisoffice', items: [] },
      inbox: [makeInbox({ text: 'Latest prompt' })],
      employees: [],
    });
    const result = boardContent(office);
    expect(result.mode).toBe('synopsis');
    if (result.mode === 'synopsis') {
      expect(result.summary).toBe('Latest prompt');
      expect(result.workers).toEqual([]);
    }
  });

  it('excludes idle employees and working employees without a task', () => {
    const office = makeOffice({
      inbox: [makeInbox({})],
      employees: [
        makeEmployee({ id: 'e1', name: 'Idle Ivy', status: 'idle', task: null }),
        makeEmployee({ id: 'e2', name: 'Taskless Tom', status: 'working', task: null }),
        makeEmployee({ id: 'e3', name: 'Working Wendy', status: 'working', task: 'Read' }),
      ],
    });
    const result = boardContent(office);
    expect(result.mode).toBe('synopsis');
    if (result.mode === 'synopsis') {
      expect(result.workers).toEqual([{ name: 'Working Wendy', task: 'Read' }]);
    }
  });

  it('uses the latest inbox item, sorted by insertion order (last wins)', () => {
    const office = makeOffice({
      inbox: [makeInbox({ text: 'Older prompt' }), makeInbox({ id: 'i2', text: 'Newer prompt' })],
      employees: [],
    });
    const result = boardContent(office);
    expect(result.mode).toBe('synopsis');
    if (result.mode === 'synopsis') {
      expect(result.summary).toBe('Newer prompt');
    }
  });

  it('produces a synopsis from working employees alone when there is no inbox item', () => {
    const office = makeOffice({
      inbox: [],
      employees: [makeEmployee({ status: 'working', task: 'Bash' })],
    });
    const result = boardContent(office);
    expect(result.mode).toBe('synopsis');
    if (result.mode === 'synopsis') {
      expect(result.summary).toBe('');
      expect(result.workers).toEqual([{ name: 'Alice', task: 'Bash' }]);
    }
  });
});
