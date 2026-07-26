import { describe, expect, it } from 'vitest';
import type { Employee, OfficeState } from '../../../shared/types.ts';
import { buildPovList } from './CameraRig.tsx';

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: 'e1',
    name: 'Alice',
    seat: 1,
    variant: 'Knight',
    hiredAt: new Date().toISOString(),
    status: 'working',
    task: null,
    ...overrides,
  };
}

function makeOffice(overrides: Partial<OfficeState> = {}): OfficeState {
  return {
    boss: { name: 'Boss', variant: 'Knight' },
    bossStatus: 'idle',
    employees: [makeEmployee({ id: 'e1', seat: 1 }), makeEmployee({ id: 'e2', seat: 2 })],
    inbox: [],
    todos: null,
    staffing: { minEmployees: 0, maxEmployees: 9, idleTimeoutSec: 60 },
    ...overrides,
  } as OfficeState;
}

describe('buildPovList', () => {
  it('always resolves the tv, so the list is boss + employees + whiteboard + statusboard + tv', () => {
    const office = makeOffice();
    const povs = buildPovList(office);
    expect(povs.map((p) => p.label)).toEqual(['Boss', 'Alice', 'Alice', 'Whiteboard', 'Status Board', 'Stats TV']);
    expect(povs).toHaveLength(office.employees.length + 4);
  });

  it('has a "Stats TV" spot as the LAST entry (App.tsx cycles by this same list, not a hand-rolled count)', () => {
    const povs = buildPovList(makeOffice());
    expect(povs.at(-1)!.label).toBe('Stats TV');
  });

  it('resolves the same shape with no office (null) — an idle/disconnected client can still cycle POVs', () => {
    const povs = buildPovList(null);
    expect(povs.map((p) => p.label)).toEqual(['Boss', 'Whiteboard', 'Status Board', 'Stats TV']);
  });

  it('the tv spot sits in front of the tv along its normal and looks straight at its center', () => {
    const povs = buildPovList(makeOffice());
    const tv = povs.find((p) => p.label === 'Stats TV')!;
    // left-wall tv is readable from +x: the camera sits further +x than what it looks at
    expect(tv.position.x).toBeGreaterThan(tv.lookAt.x);
    expect(tv.position.y).toBeCloseTo(tv.lookAt.y, 6);
    expect(tv.position.z).toBeCloseTo(tv.lookAt.z, 6);
  });

  it('growing the roster grows the list by exactly one entry per employee, keeping tv last', () => {
    const small = buildPovList(makeOffice({ employees: [makeEmployee({ id: 'e1', seat: 1 })] }));
    const big = buildPovList(
      makeOffice({ employees: Array.from({ length: 9 }, (_, i) => makeEmployee({ id: `e${i}`, seat: i + 1 })) }),
    );
    expect(big.length - small.length).toBe(8);
    expect(small.at(-1)!.label).toBe('Stats TV');
    expect(big.at(-1)!.label).toBe('Stats TV');
  });
});
