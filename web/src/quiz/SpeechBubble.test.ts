import { describe, it, expect } from 'vitest';
import type { OfficeState } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { selectAskerSeat } from './SpeechBubble.tsx';

function makeOffice(overrides: Partial<OfficeState> = {}): OfficeState {
  return {
    officeName: 'This Office',
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [{ id: 'e1', name: 'Dana', seat: 1, variant: 'Mage', hiredAt: '', status: 'idle', task: null }],
    inbox: [],
    todos: null,
    status: [],
    staffing: { minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 },
    waitingForInput: false,
    ...overrides,
  };
}

describe('SpeechBubble store subscriptions', () => {
  it('selectAskerSeat is Object.is-stable across a broadcast that only changes an unrelated field', () => {
    // Simulate two server broadcasts the way ws.ts really delivers them: each
    // one JSON.parses to a brand-new `employees` array, even though the
    // roster itself (and this asker's seat) hasn't changed. Only `status`
    // differs between the two, mimicking a status-board push.
    const apply = useStore.getState().applyServerMsg;
    apply({
      type: 'quiz',
      quiz: {
        enabled: true,
        roundId: 'r1',
        askedCount: 1,
        answers: [],
        question: { id: 'q1', text: 'Is it alive?', guess: false, asker: 'e1', askerName: 'Dana', at: 'now' },
        awaitingPhoto: false,
        winner: null,
      },
    } as never);
    apply({ type: 'state', state: makeOffice({ status: [] }) });
    const seatBefore = selectAskerSeat(useStore.getState());

    apply({
      type: 'state',
      state: JSON.parse(
        JSON.stringify(makeOffice({ status: [{ id: 's1', kind: 'boss', text: 'unrelated status push', at: 'now' }] })),
      ),
    });
    const seatAfter = selectAskerSeat(useStore.getState());

    // The selector reruns (zustand always reruns selectors), but its *output*
    // is Object.is-equal — this is what actually prevents SpeechBubble from
    // re-rendering, regardless of `office.employees` being a fresh array both times.
    expect(Object.is(seatBefore, seatAfter)).toBe(true);
    expect(seatBefore).toBe(1);
  });

  it('office.layout stays reference-stable across the same kind of unrelated broadcast', () => {
    const apply = useStore.getState().applyServerMsg;
    const layout = { seats: { 1: { x: 2.5, z: 3.5, rotY: 0 } } };
    apply({ type: 'state', state: makeOffice({ status: [], layout }) });
    const layoutBefore = useStore.getState().office?.layout;

    apply({
      type: 'state',
      state: JSON.parse(
        JSON.stringify(makeOffice({ status: [{ id: 's1', kind: 'boss', text: 'unrelated status push', at: 'now' }], layout })),
      ),
    });
    const layoutAfter = useStore.getState().office?.layout;

    // stableLayout (store.ts) carries the previous `layout` object forward
    // when the new one is deep-equal — this is the reference SpeechBubble's
    // `layout` selector relies on.
    expect(layoutAfter).toBe(layoutBefore);
  });
});
