import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeState } from '../../shared/types.ts';
import { resetWhiteboardKeyForTest, useStore } from './store.ts';

function makeOffice(overrides: Partial<OfficeState> = {}): OfficeState {
  return {
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [],
    inbox: [],
    todos: null,
    staffing: { minEmployees: 0, maxEmployees: 9, idleTimeoutSec: 60 },
    ...overrides,
  } as OfficeState;
}

describe('lastActivity stamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetWhiteboardKeyForTest();
    useStore.setState({ office: null, monitors: {}, monitorVersion: {}, lastActivity: {} });
  });
  afterEach(() => vi.useRealTimers());

  it('stamps the target when a monitor message appends text', () => {
    useStore.getState().applyServerMsg({ type: 'monitor', target: 'e1', append: 'hello\n' } as never);
    expect(useStore.getState().lastActivity['e1']).toBe(1_000_000);
  });

  it('does not stamp on clear-only monitor messages', () => {
    useStore.getState().applyServerMsg({ type: 'monitor', target: 'e1', clear: true } as never);
    expect(useStore.getState().lastActivity['e1']).toBeUndefined();
  });

  it('stamps the whiteboard when derived board content changes, but not on the first state', () => {
    useStore.getState().applyServerMsg({ type: 'state', state: makeOffice() });
    expect(useStore.getState().lastActivity['whiteboard']).toBeUndefined();

    vi.setSystemTime(1_005_000);
    const changed = makeOffice({
      inbox: [{ id: 'i1', project: 'p', text: 'new prompt', at: new Date().toISOString() }],
    } as Partial<OfficeState>);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);

    // identical content again → no re-stamp
    vi.setSystemTime(1_009_000);
    useStore.getState().applyServerMsg({ type: 'state', state: changed });
    expect(useStore.getState().lastActivity['whiteboard']).toBe(1_005_000);
  });
});
