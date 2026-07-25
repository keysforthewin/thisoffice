import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Office, clampStaffing } from './office.ts';

function makeOffice() {
  const office = new Office(() => ['Knight', 'Mage', 'Rogue']);
  (office as any).save = () => {}; // keep tests off the real data file
  return office;
}

describe('Office drain-aware lifecycle', () => {
  let office: Office;
  let draining: Set<string>;
  let cleared: string[];
  let pressures: number[];

  beforeEach(() => {
    office = makeOffice();
    draining = new Set();
    cleared = [];
    pressures = [];
    office.attachStreamer({
      isDraining: (id) => draining.has(id),
      clear: (id) => cleared.push(id),
      setPressure: (n) => pressures.push(n),
    });
  });

  it('assign skips employees whose screen is still draining', () => {
    const a = office.assign('s:t1', 'Bash').employee!;
    office.finish('s:t1'); // idle again, not draining
    draining.add(a.id);
    const b = office.assign('s:t2', 'Read').employee!;
    expect(b.id).not.toBe(a.id);
  });

  it('finish defers idle until notifyDrained when streaming', () => {
    const a = office.assign('s:t1', 'Bash').employee!;
    draining.add(a.id);
    office.finish('s:t1');
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
    draining.delete(a.id);
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });

  it('finish goes idle immediately when not streaming', () => {
    const a = office.assign('s:t1', 'Bash').employee!;
    office.finish('s:t1');
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });

  it('notifyDrained without a pending finish is a no-op', () => {
    const a = office.assign('s:t1', 'Bash').employee!;
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('notifyDrained keeps the employee working if another activity is still assigned', () => {
    const a = office.assign('s:t1', 'Bash').employee!;
    // hire everyone else out of the way so t2 lands on a new employee, then
    // force-reassign t2 to a by making a the only idle one is fiddly; instead
    // assign a second activity directly to the same employee via the map:
    draining.add(a.id);
    office.finish('s:t1'); // pendingIdle: a
    (office as any).assignments.set('s:t2', a.id); // second activity on same emp
    draining.delete(a.id);
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('remove clears the streamer queue for that employee', () => {
    const a = office.assign('s:t1', 'Bash').employee!;
    office.remove(a.id);
    expect(cleared).toContain(a.id);
  });

  it('works with no streamer attached (assign/finish behave as before)', () => {
    const plain = makeOffice();
    const a = plain.assign('s:t1', 'Bash').employee!;
    plain.finish('s:t1');
    expect(plain.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });
});

describe('staffing settings', () => {
  it('defaults to min 3 / max 12', () => {
    const office = makeOffice();
    expect(office.getState().staffing).toEqual({ minEmployees: 3, maxEmployees: 12 });
  });

  it('setStaffing applies valid values and persists via save', () => {
    const office = makeOffice();
    let saved = 0;
    (office as any).save = () => saved++;
    office.setStaffing({ minEmployees: 2, maxEmployees: 8 });
    expect(office.getState().staffing).toEqual({ minEmployees: 2, maxEmployees: 8 });
    expect(saved).toBe(1);
  });

  it('ignores non-integers and floors min at 1; min clamps down to max', () => {
    const office = makeOffice();
    office.setStaffing({ minEmployees: 2.5 as any, maxEmployees: NaN as any });
    expect(office.getState().staffing).toEqual({ minEmployees: 3, maxEmployees: 12 });
    office.setStaffing({ minEmployees: 0 });
    expect(office.getState().staffing.minEmployees).toBe(1);
    office.setStaffing({ minEmployees: 6, maxEmployees: 4 });
    expect(office.getState().staffing).toEqual({ minEmployees: 4, maxEmployees: 4 });
  });
});

describe('clampStaffing (load-time validation)', () => {
  it('clamps a hand-edited persisted value with min > max down to max', () => {
    expect(clampStaffing({ minEmployees: 10, maxEmployees: 2 })).toEqual({ minEmployees: 2, maxEmployees: 2 });
  });

  it('ignores non-integers and floors min at 1, same as setStaffing', () => {
    expect(clampStaffing({ minEmployees: 2.5 as any, maxEmployees: NaN as any })).toEqual({ minEmployees: 3, maxEmployees: 12 });
    expect(clampStaffing({ minEmployees: 0 })).toEqual({ minEmployees: 1, maxEmployees: 12 });
  });

  it('falls back to defaults when nothing is persisted', () => {
    expect(clampStaffing(undefined)).toEqual({ minEmployees: 3, maxEmployees: 12 });
  });
});

describe('work queue', () => {
  let draining: Set<string>;
  let pressures: number[];

  function makeQueueOffice() {
    const office = makeOffice();
    draining = new Set();
    pressures = [];
    office.attachStreamer({
      isDraining: (id) => draining.has(id),
      clear: () => {},
      setPressure: (n) => pressures.push(n),
    });
    return office;
  }

  it('queues work at max headcount and reports pressure', () => {
    const office = makeQueueOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length }); // cap at current size
    const n = office.getState().employees.length;
    for (let i = 0; i < n; i++) expect(office.assign(`s:t${i}`, 'Bash').employee).not.toBeNull();
    const overflow = office.assign('s:overflow', 'Read');
    expect(overflow.employee).toBeNull();
    expect(office.getState().employees.length).toBe(n); // no hire
    expect(pressures.at(-1)).toBe(1);
  });

  it('assigning the same queued key twice at max headcount queues it only once', () => {
    const office = makeQueueOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length });
    const n = office.getState().employees.length;
    for (let i = 0; i < n; i++) office.assign(`s:t${i}`, 'Bash');
    expect(office.assign('s:dup', 'Read').employee).toBeNull();
    expect(office.assign('s:dup', 'Read').employee).toBeNull(); // duplicate pickup replay, not a second queue entry
    expect(pressures.at(-1)).toBe(1); // still just one queued job, not two
    const assigned: string[] = [];
    office.onAssign((key) => assigned.push(key));
    office.finish('s:t0');
    expect(assigned).toEqual(['s:dup']);
    // no second pickup follows since the key was only queued once
    office.finish('s:t1');
    expect(assigned).toEqual(['s:dup']);
  });

  it('a freeing employee picks up the queue head; onAssign fires; pressure drops', () => {
    const office = makeQueueOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length });
    const n = office.getState().employees.length;
    const first = office.assign('s:t0', 'Bash').employee!;
    for (let i = 1; i < n; i++) office.assign(`s:t${i}`, 'Bash');
    office.assign('s:q1', 'Grep');
    const assigned: Array<{ key: string; id: string }> = [];
    office.onAssign((key, emp) => assigned.push({ key, id: emp.id }));
    office.finish('s:t0'); // not draining → setIdle → dequeues
    expect(assigned).toEqual([{ key: 's:q1', id: first.id }]);
    const emp = office.getState().employees.find((e) => e.id === first.id)!;
    expect(emp.status).toBe('working');
    expect(emp.task).toBe('Grep');
    expect(pressures.at(-1)).toBe(0);
    office.finish('s:q1');
    expect(office.getState().employees.find((e) => e.id === first.id)!.status).toBe('idle');
  });

  it('drain-deferred finish also dequeues on notifyDrained', () => {
    const office = makeQueueOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length });
    const n = office.getState().employees.length;
    const first = office.assign('s:t0', 'Bash').employee!;
    for (let i = 1; i < n; i++) office.assign(`s:t${i}`, 'Bash');
    office.assign('s:q1', 'Grep');
    const assigned: string[] = [];
    office.onAssign((key) => assigned.push(key));
    draining.add(first.id);
    office.finish('s:t0'); // deferred
    expect(assigned).toEqual([]);
    draining.delete(first.id);
    office.notifyDrained(first.id);
    expect(assigned).toEqual(['s:q1']);
  });
});

describe('idle eviction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeEvictionOffice() {
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], 60_000);
    (office as any).save = () => {};
    office.attachStreamer({ isDraining: () => false, clear: () => {}, setPressure: () => {} });
    return office;
  }

  it('evicts an auto-hired employee after 60s idle, never below min or the protected seats', () => {
    const office = makeEvictionOffice();
    const baseline = office.getState().employees.length;
    // occupy everyone so a new hire happens, then free it
    const keys = office.getState().employees.map((e, i) => `s:t${i}`);
    keys.forEach((k) => office.assign(k, 'Bash'));
    const extra = office.assign('s:new', 'Read').employee!; // hired
    office.finish('s:new'); // idle → timer starts
    keys.forEach((k) => office.finish(k));
    vi.advanceTimersByTime(60_001);
    const after = office.getState().employees;
    expect(after.find((e) => e.id === extra.id)).toBeUndefined(); // extra evicted
    expect(after.length).toBeGreaterThanOrEqual(office.getState().staffing.minEmployees);
    // protected lowest seats survive even though idle for over a minute
    const protectedIds = [...after].sort((a, b) => a.seat - b.seat).slice(0, 3).map((e) => e.id);
    vi.advanceTimersByTime(120_000);
    for (const id of protectedIds) {
      expect(office.getState().employees.find((e) => e.id === id)).toBeDefined();
    }
  });

  it('protected lowest-seat employees survive repeated full idle windows; a non-protected extra is evicted', () => {
    const office = makeEvictionOffice();
    const before = office.getState().employees;
    const minEmployees = office.getState().staffing.minEmployees;
    const protectedIds = [...before]
      .sort((a, b) => a.seat - b.seat)
      .slice(0, minEmployees)
      .map((e) => e.id);
    const extra = office.hireManual(); // idle from birth, beyond the protected seats

    // advance through several full idle-timer windows; protected seats must keep
    // getting rescheduled (Finding 2) so they never lapse into eviction.
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(60_001);

    const after = office.getState().employees;
    expect(after.find((e) => e.id === extra.id)).toBeUndefined(); // non-protected extra evicted
    for (const id of protectedIds) {
      expect(after.find((e) => e.id === id)).toBeDefined(); // protected seats survive every window
    }
    expect(after.length).toBe(minEmployees);
  });

  it('a working employee is never evicted; timer clears on assignment', () => {
    const office = makeEvictionOffice();
    const a = office.assign('s:t1', 'Bash').employee!;
    vi.advanceTimersByTime(120_000);
    expect(office.getState().employees.find((e) => e.id === a.id)).toBeDefined();
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('timers from construction evict leftover extras with no activity at all', () => {
    const office = makeEvictionOffice();
    const before = office.getState().employees.length;
    office.hireManual(); // 1 extra, idle from birth
    vi.advanceTimersByTime(60_001);
    expect(office.getState().employees.length).toBe(Math.max(before, office.getState().staffing.minEmployees));
  });
});
