import { describe, expect, it } from 'vitest';
import type { Employee, OfficeState, StatusItem } from '../../../shared/types.ts';
import { statusBoardContent, STATUS_BOARD_MAX_ITEMS } from './statusBoardContent.ts';

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

function makeStatus(i: number, overrides: Partial<StatusItem> = {}): StatusItem {
  return { id: `status-${i}`, at: new Date().toISOString(), text: `event ${i}`, kind: 'done', ...overrides };
}

function makeOffice(overrides: Partial<OfficeState>): OfficeState {
  return {
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

describe('statusBoardContent', () => {
  it('renders empty content (not null) when there is nothing to show', () => {
    expect(statusBoardContent(null)).toEqual({ items: [], workers: [] });
    expect(statusBoardContent(makeOffice({}))).toEqual({ items: [], workers: [] });
  });

  it('lists status items newest first, capped to the board size', () => {
    const status = Array.from({ length: STATUS_BOARD_MAX_ITEMS + 3 }, (_, i) => makeStatus(i + 1));
    const result = statusBoardContent(makeOffice({ status }));
    expect(result.items).toHaveLength(STATUS_BOARD_MAX_ITEMS);
    expect(result.items[0].text).toBe(`event ${STATUS_BOARD_MAX_ITEMS + 3}`);
    expect(result.items.at(-1)!.text).toBe('event 4');
  });

  it('tolerates a state from an older server with no status field', () => {
    const office = makeOffice({});
    delete (office as Partial<OfficeState>).status;
    expect(statusBoardContent(office)).toEqual({ items: [], workers: [] });
  });

  it('lists working employees with tasks, sorted by seat', () => {
    const office = makeOffice({
      employees: [
        makeEmployee({ id: 'e2', name: 'Bob', seat: 2, status: 'working', task: 'Edit' }),
        makeEmployee({ id: 'e1', name: 'Alice', seat: 1, status: 'working', task: 'Bash' }),
        makeEmployee({ id: 'e3', name: 'Idle Ivy', seat: 3, status: 'idle', task: null }),
        makeEmployee({ id: 'e4', name: 'Taskless Tom', seat: 4, status: 'working', task: null }),
      ],
    });
    expect(statusBoardContent(office).workers).toEqual([
      { name: 'Alice', task: 'Bash' },
      { name: 'Bob', task: 'Edit' },
    ]);
  });
});
