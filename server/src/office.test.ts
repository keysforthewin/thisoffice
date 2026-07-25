import { describe, it, expect, beforeEach } from 'vitest';
import { Office } from './office.ts';

function makeOffice() {
  const office = new Office(() => ['Knight', 'Mage', 'Rogue']);
  (office as any).save = () => {}; // keep tests off the real data file
  return office;
}

describe('Office drain-aware lifecycle', () => {
  let office: Office;
  let draining: Set<string>;
  let cleared: string[];

  beforeEach(() => {
    office = makeOffice();
    draining = new Set();
    cleared = [];
    office.attachStreamer({
      isDraining: (id) => draining.has(id),
      clear: (id) => cleared.push(id),
    });
  });

  it('assign skips employees whose screen is still draining', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.finish('s:t1'); // idle again, not draining
    draining.add(a.id);
    const b = office.assign('s:t2', 'Read').employee;
    expect(b.id).not.toBe(a.id);
  });

  it('finish defers idle until notifyDrained when streaming', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    draining.add(a.id);
    office.finish('s:t1');
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
    draining.delete(a.id);
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });

  it('finish goes idle immediately when not streaming', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.finish('s:t1');
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('idle');
  });

  it('notifyDrained without a pending finish is a no-op', () => {
    const a = office.assign('s:t1', 'Bash').employee;
    office.notifyDrained(a.id);
    expect(office.getState().employees.find((e) => e.id === a.id)!.status).toBe('working');
  });

  it('notifyDrained keeps the employee working if another activity is still assigned', () => {
    const a = office.assign('s:t1', 'Bash').employee;
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
    const a = office.assign('s:t1', 'Bash').employee;
    office.remove(a.id);
    expect(cleared).toContain(a.id);
  });

  it('works with no streamer attached (assign/finish behave as before)', () => {
    const plain = makeOffice();
    const a = plain.assign('s:t1', 'Bash').employee;
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
