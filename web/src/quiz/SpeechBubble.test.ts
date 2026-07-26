import { describe, it, expect } from 'vitest';
import type { OfficeState } from '../../../shared/types.ts';
import { useStore } from '../store.ts';
import { askerAnchor } from './askerAnchor.ts';
import { seatTransform } from '../scene/layout.ts';

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
    katPerson: true,
    waitingForInput: false,
    ...overrides,
  };
}

describe('SpeechBubble store subscriptions', () => {
  it('anchors the bubble from the question, not the live roster', () => {
    // The asker is idle-evicted while their question is still up — the only
    // recoverable state at that point is what rode the protocol. Resolving the
    // anchor from `question.askerSeat` (as SpeechBubble does) must therefore
    // still place the bubble, because the server keeps holding this question
    // until this bubble answers it. It also keeps the store subscription cheap:
    // nothing here reads `office.employees`, which ws.ts JSON.parses into a
    // fresh array on every single broadcast.
    const apply = useStore.getState().applyServerMsg;
    apply({
      type: 'quiz',
      quiz: {
        enabled: true,
        roundId: 'r1',
        askedCount: 1,
        answers: [],
        question: {
          id: 'q1',
          text: 'Is it alive?',
          guess: false,
          asker: 'gone-9',
          askerName: 'Dana',
          askerSeat: 5,
          at: 'now',
        },
        awaitingPhoto: false,
        winner: null,
      },
    } as never);
    // roster with no trace of the asker, exactly as after an eviction
    apply({ type: 'state', state: makeOffice() });

    const st = useStore.getState();
    const q = st.quiz!.question!;
    const anchor = askerAnchor(q.asker, q.askerSeat, { layout: st.office?.layout }, 5);
    expect(anchor).not.toBeNull();
    expect(anchor![0]).toBeCloseTo(seatTransform(5).position.x, 5);
    expect(anchor![2]).toBeCloseTo(seatTransform(5).position.z, 5);
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
