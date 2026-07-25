import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, clampStaffing } from './office.ts';

function makeOffice() {
  const office = new Office(() => ['Knight', 'Mage', 'Rogue'], '/nonexistent/office.json');
  (office as any).save = () => {}; // keep tests off the real data file
  return office;
}

describe('Office drain-aware lifecycle', () => {
  let office: Office;
  let draining: Set<string>;
  let cleared: string[];
  let pressures: number[];
  let boosts: boolean[];

  beforeEach(() => {
    office = makeOffice();
    draining = new Set();
    cleared = [];
    pressures = [];
    boosts = [];
    office.attachStreamer({
      isDraining: (id) => draining.has(id),
      clear: (id) => cleared.push(id),
      setPressure: (n) => pressures.push(n),
      setBoost: (on) => boosts.push(on),
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

describe('inbox persistence', () => {
  function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
    return path.join(dir, 'office.json');
  }

  it('inbox survives a save/load round-trip', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushInbox('thisoffice', 'first message');
    office.pushInbox('thisoffice', 'second message');
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().inbox.map((i) => i.text)).toEqual(['first message', 'second message']);
  });

  it('new items after a reload never reuse a restored id', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushInbox('thisoffice', 'first');
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    reloaded.pushInbox('thisoffice', 'second');
    const ids = reloaded.getState().inbox.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('todos survive a save/load round-trip', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.setTodos('thisoffice', [
      { content: 'write tests', status: 'completed' },
      { content: 'persist todos', status: 'in_progress' },
    ]);
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().todos).toMatchObject({
      project: 'thisoffice',
      items: [
        { content: 'write tests', status: 'completed' },
        { content: 'persist todos', status: 'in_progress' },
      ],
    });
  });

  it('setTodos stamps a timestamp and legacy persisted todos restore as epoch', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.setTodos('thisoffice', [{ content: 'x', status: 'completed' }]);
    const at = office.getState().todos!.at!;
    expect(Date.now() - Date.parse(at)).toBeLessThan(5_000);
    // strip `at` from the file, as pre-upgrade office.json would have it
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete raw.todos.at;
    fs.writeFileSync(file, JSON.stringify(raw));
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().todos!.at).toBe(new Date(0).toISOString());
  });

  it('pushStatus caps the feed, keeps ids monotonic, and survives a reload', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    for (let i = 1; i <= 13; i++) office.pushStatus('done', `job ${i}`);
    const status = office.getState().status;
    expect(status.length).toBe(10);
    expect(status[0].text).toBe('job 4');
    expect(status.at(-1)!.text).toBe('job 13');
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().status.map((s) => s.text)).toEqual(status.map((s) => s.text));
    reloaded.pushStatus('boss', 'after reload');
    const ids = reloaded.getState().status.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('an identical consecutive status refreshes the tail instead of duplicating', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushStatus('session', 'Looking at myapp: "Fix login"');
    office.pushStatus('session', 'Looking at myapp: "Fix login"');
    expect(office.getState().status).toHaveLength(1);
    office.pushStatus('done', 'Looking at myapp: "Fix login"'); // different kind → new item
    expect(office.getState().status).toHaveLength(2);
  });

  it('updateStatusText rewrites the item in place (summarizer path)', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushStatus('boss', 'Message from upstairs: raw prompt text');
    office.updateStatusText(office.lastStatusId, 'Message from upstairs: tidy summary');
    expect(office.getState().status.at(-1)!.text).toBe('Message from upstairs: tidy summary');
    expect(office.getState().status.length).toBe(1);
  });

  it('fullText survives a save/load round-trip and the summarizer only rewrites text', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushInbox('thisoffice', 'preview…', 'the full raw prompt\nwith a second line');
    office.updateInboxText(office.lastInboxId, 'short summary');
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().inbox[0].text).toBe('short summary');
    expect(reloaded.getState().inbox[0].fullText).toBe('the full raw prompt\nwith a second line');
  });

  it('legacy inbox items without fullText load clean, and non-string fullText is dropped', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushInbox('thisoffice', 'legacy');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.inbox[0].fullText;
    raw.inbox.push({ ...raw.inbox[0], id: 'inbox-2', fullText: 123 });
    fs.writeFileSync(file, JSON.stringify(raw));
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().inbox.map((i) => i.fullText)).toEqual([undefined, undefined]);
  });

  it('a summarizer text update is persisted too', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    office.pushInbox('thisoffice', 'long raw prompt preview');
    office.updateInboxText(office.lastInboxId, 'short summary');
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getState().inbox[0].text).toBe('short summary');
  });
});

describe('biographies', () => {
  function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
    return path.join(dir, 'office.json');
  }

  it('employee bio set/get round-trip; unknown ids are rejected', () => {
    const office = makeOffice();
    const emp = office.getState().employees[0];
    expect(office.getEmployeeBio(emp.id)).toBe('');
    expect(office.setEmployeeBio(emp.id, 'Born in a server room.')).toBe(true);
    expect(office.getEmployeeBio(emp.id)).toBe('Born in a server room.');
    expect(office.setEmployeeBio('nope', 'x')).toBe(false);
    expect(office.getEmployeeBio('nope')).toBe(null);
  });

  it('boss bio set/get round-trip', () => {
    const office = makeOffice();
    expect(office.getBossBio()).toBe('');
    office.setBossBio('The boss story.');
    expect(office.getBossBio()).toBe('The boss story.');
  });

  it('rename and setVariant do not clobber the bio', () => {
    const office = makeOffice();
    const emp = office.getState().employees[0];
    office.setEmployeeBio(emp.id, 'keep me');
    office.rename(emp.id, 'New Name');
    office.setVariant(emp.id, 'Mage');
    expect(office.getEmployeeBio(emp.id)).toBe('keep me');
  });

  it('bio survives eviction and returns with the rehired seat', () => {
    const office = makeOffice();
    const emp = office.getState().employees[0];
    const seat = emp.seat;
    office.setEmployeeBio(emp.id, 'seat memory');
    office.remove(emp.id);
    // hire() refills the lowest free seat, restoring the remembered identity
    const rehired = office.hireManual();
    expect(rehired.seat).toBe(seat);
    expect(office.getEmployeeBio(rehired.id)).toBe('seat memory');
  });

  it('bios persist across a save/load round-trip, and legacy files load clean', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    const emp = office.getState().employees[0];
    office.setEmployeeBio(emp.id, 'persisted employee bio');
    office.setBossBio('persisted boss bio');
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(reloaded.getBossBio()).toBe('persisted boss bio');
    expect(reloaded.getEmployeeBio(reloaded.getState().employees[0].id)).toBe('persisted employee bio');

    // legacy file: strip the bio fields entirely
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.boss.bio;
    for (const r of raw.roster ?? []) delete r.bio;
    fs.writeFileSync(file, JSON.stringify(raw));
    const legacy = new Office(() => ['Knight', 'Mage', 'Rogue'], file);
    expect(legacy.getBossBio()).toBe('');
    expect(legacy.getEmployeeBio(legacy.getState().employees[0].id)).toBe('');
  });
});

describe('waiting for input', () => {
  it('setWaitingForInput broadcasts only on change and never persists', () => {
    const office = makeOffice();
    const msgs: unknown[] = [];
    office.subscribe((m) => msgs.push(m));
    office.setWaitingForInput(true);
    office.setWaitingForInput(true);
    expect(office.getState().waitingForInput).toBe(true);
    expect(msgs.length).toBe(1);
    office.setWaitingForInput(false);
    expect(office.getState().waitingForInput).toBe(false);
    expect(msgs.length).toBe(2);
  });
});

describe('screen snapshots (monitor replay on connect)', () => {
  const IMG = '⟦IMG⟧data:image/png;base64,abc';

  it('replay rebuilds a screen: last title, streamed lines, image last', () => {
    const office = makeOffice();
    office.monitor('emp-1', { clear: true, title: 'Bash · thisoffice' });
    office.monitor('emp-1', { append: '$ npm test\nok' });
    office.monitor('emp-1', { append: IMG + '\n✓ done' });
    const replay = office.screenReplay();
    expect(replay).toEqual([
      {
        type: 'monitor',
        target: 'emp-1',
        clear: true,
        title: 'Bash · thisoffice',
        append: ['$ npm test', 'ok', '✓ done', IMG].join('\n'),
      },
    ]);
  });

  it('treats a URL image payload as the screen image too', () => {
    const office = makeOffice();
    const URL_IMG = '⟦IMG⟧https://x.test/shot.png';
    office.monitor('emp-1', { clear: true, title: 'Read · proj' });
    office.monitor('emp-1', { append: URL_IMG + '\n✓ done' });
    expect(office.screenReplay()).toEqual([
      { type: 'monitor', target: 'emp-1', clear: true, title: 'Read · proj', append: ['✓ done', URL_IMG].join('\n') },
    ]);
  });

  it('clear starts a fresh screen and drops the old image', () => {
    const office = makeOffice();
    office.monitor('emp-1', { clear: true, title: 'Read · proj' });
    office.monitor('emp-1', { append: IMG });
    office.monitor('emp-1', { clear: true, title: 'Bash · proj' });
    office.monitor('emp-1', { append: 'fresh' });
    expect(office.screenReplay()).toEqual([
      { type: 'monitor', target: 'emp-1', clear: true, title: 'Bash · proj', append: 'fresh' },
    ]);
  });

  it('keeps only the most recent lines, not full history', () => {
    const office = makeOffice();
    office.monitor('emp-1', { clear: true, title: 't' });
    for (let i = 0; i < 200; i++) office.monitor('emp-1', { append: `line ${i}` });
    const replay = office.screenReplay()[0] as any;
    const lines = replay.append.split('\n');
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines[lines.length - 1]).toBe('line 199');
  });

  it('removing an employee drops their screen from replay', () => {
    const office = makeOffice();
    const emp = office.getState().employees[0];
    office.monitor(emp.id, { clear: true, title: 'Bash', append: 'hi' });
    office.remove(emp.id);
    expect(office.screenReplay()).toEqual([]);
  });
});

describe('staffing settings', () => {
  it('defaults to min 3 / max 12', () => {
    const office = makeOffice();
    expect(office.getState().staffing).toEqual({ minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 });
  });

  it('setStaffing applies valid values and persists via save', () => {
    const office = makeOffice();
    let saved = 0;
    (office as any).save = () => saved++;
    office.setStaffing({ minEmployees: 2, maxEmployees: 8 });
    expect(office.getState().staffing).toEqual({ minEmployees: 2, maxEmployees: 8, idleTimeoutSec: 60 });
    expect(saved).toBe(1);
  });

  it('ignores non-integers and floors min at 1; min clamps down to max', () => {
    const office = makeOffice();
    office.setStaffing({ minEmployees: 2.5 as any, maxEmployees: NaN as any });
    expect(office.getState().staffing).toEqual({ minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 });
    office.setStaffing({ minEmployees: 0 });
    expect(office.getState().staffing.minEmployees).toBe(1);
    office.setStaffing({ minEmployees: 6, maxEmployees: 4 });
    expect(office.getState().staffing).toEqual({ minEmployees: 4, maxEmployees: 4, idleTimeoutSec: 60 });
  });
});

describe('clampStaffing (load-time validation)', () => {
  it('clamps a hand-edited persisted value with min > max down to max', () => {
    expect(clampStaffing({ minEmployees: 10, maxEmployees: 2 })).toEqual({ minEmployees: 2, maxEmployees: 2, idleTimeoutSec: 60 });
  });

  it('ignores non-integers and floors min at 1, same as setStaffing', () => {
    expect(clampStaffing({ minEmployees: 2.5 as any, maxEmployees: NaN as any })).toEqual({ minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 });
    expect(clampStaffing({ minEmployees: 0 })).toEqual({ minEmployees: 1, maxEmployees: 12, idleTimeoutSec: 60 });
  });

  it('falls back to defaults when nothing is persisted', () => {
    expect(clampStaffing(undefined)).toEqual({ minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 });
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
      setBoost: () => {},
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

  it('cancelQueued removes a queued job and drops pressure', () => {
    const office = makeQueueOffice();
    office.setStaffing({ minEmployees: 1, maxEmployees: office.getState().employees.length });
    const n = office.getState().employees.length;
    for (let i = 0; i < n; i++) office.assign(`s:t${i}`, 'Bash');
    office.assign('s:q1', 'Grep'); // queued, pressure 1
    expect(pressures.at(-1)).toBe(1);
    expect(office.cancelQueued('s:q1')).toBe(true);
    expect(pressures.at(-1)).toBe(0);
    expect(office.cancelQueued('s:q1')).toBe(false); // already gone
    // freeing an employee now dequeues nothing (the queued job was cancelled)
    const assigned: string[] = [];
    office.onAssign((key) => assigned.push(key));
    office.finish('s:t0');
    expect(assigned).toEqual([]);
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

describe('max-staffing boost', () => {
  function makeBoostOffice() {
    const office = makeOffice();
    const boosts: boolean[] = [];
    office.attachStreamer({
      isDraining: () => false,
      clear: () => {},
      setPressure: () => {},
      setBoost: (on) => boosts.push(on),
    });
    return { office, boosts };
  }

  it('attaching the streamer while already at max staffing boosts immediately', () => {
    const { office, boosts } = makeBoostOffice();
    office.setStaffing({ maxEmployees: office.getState().employees.length });
    boosts.length = 0;
    office.attachStreamer({ isDraining: () => false, clear: () => {}, setPressure: () => {}, setBoost: (on) => boosts.push(on) });
    expect(boosts.at(-1)).toBe(true);
  });

  it('hiring up to max staffing turns boost on', () => {
    const { office, boosts } = makeBoostOffice();
    office.setStaffing({ maxEmployees: office.getState().employees.length + 1 });
    expect(boosts.at(-1)).toBe(false); // below max after raising the cap
    office.hireManual(); // now at max
    expect(boosts.at(-1)).toBe(true);
  });

  it('removing an employee below max turns boost off', () => {
    const { office, boosts } = makeBoostOffice();
    office.setStaffing({ maxEmployees: office.getState().employees.length }); // at max already
    expect(boosts.at(-1)).toBe(true);
    const victim = office.getState().employees[0];
    office.remove(victim.id);
    expect(boosts.at(-1)).toBe(false);
  });

  it('setStaffing raising the cap above headcount turns boost off; lowering it back on', () => {
    const { office, boosts } = makeBoostOffice();
    const n = office.getState().employees.length;
    office.setStaffing({ maxEmployees: n }); // at max
    expect(boosts.at(-1)).toBe(true);
    office.setStaffing({ maxEmployees: n + 5 }); // raise cap: no longer at max
    expect(boosts.at(-1)).toBe(false);
    office.setStaffing({ maxEmployees: n }); // lower it back to headcount
    expect(boosts.at(-1)).toBe(true);
  });
});

describe('seat identity roster', () => {
  function fillAndHire(office: Office): { extra: any; keys: string[] } {
    const keys = office.getState().employees.map((_, i) => `s:t${i}`);
    keys.forEach((k) => office.assign(k, 'Bash'));
    const extra = office.assign('s:new', 'Read').employee!;
    return { extra, keys };
  }

  it('a rehire into an evicted seat gets the same name and variant back', () => {
    const office = makeOffice();
    office.attachStreamer({ isDraining: () => false, clear: () => {}, setPressure: () => {}, setBoost: () => {} });
    const { extra, keys } = fillAndHire(office);
    office.rename(extra.id, 'Custom Carl');
    office.setVariant(extra.id, 'Mage');
    const seat = extra.seat;
    office.finish('s:new');
    keys.forEach((k) => office.finish(k));
    office.remove(extra.id); // same path idle-eviction takes

    keys.forEach((k, i) => office.assign(`s:again${i}`, 'Bash')); // occupy everyone again
    const rehire = office.assign('s:new2', 'Read').employee!;
    expect(rehire.seat).toBe(seat); // lowest free seat is reused
    expect(rehire.name).toBe('Custom Carl');
    expect(rehire.variant).toBe('Mage');
  });

  it('hire fills the lowest free seat, not max+1', () => {
    const office = makeOffice();
    office.attachStreamer({ isDraining: () => false, clear: () => {}, setPressure: () => {}, setBoost: () => {} });
    const gapSeat = office.getState().employees[0].seat; // seat 1
    const gapId = office.getState().employees[0].id;
    office.remove(gapId);
    const hired = office.hireManual();
    expect(hired.seat).toBe(gapSeat);
  });

  it('hireManual restores a remembered identity instead of randomizing', () => {
    const office = makeOffice();
    const first = office.getState().employees.find((e) => e.seat === 1)!;
    office.rename(first.id, 'Custom Cass');
    office.remove(first.id);
    const rehire = office.hireManual();
    expect(rehire.seat).toBe(1);
    expect(rehire.name).toBe('Custom Cass');
    expect(rehire.variant).toBe(first.variant);
  });

  it('roster round-trips through save/load', () => {
    const office = makeOffice();
    let persisted: any;
    (office as any).save = function () {
      persisted = {
        boss: this.state.boss,
        employees: this.state.employees.map(({ id, name, seat, variant, hiredAt }: any) => ({ id, name, seat, variant, hiredAt })),
        staffing: this.state.staffing,
        roster: [...this.roster.entries()].map(([seat, r]: any) => ({ seat, ...r })),
      };
    };
    const first = office.getState().employees.find((e) => e.seat === 1)!;
    office.rename(first.id, 'Custom Codi');
    office.remove(first.id); // seat 1 gone from employees, but kept in roster
    expect(persisted.roster).toContainEqual({ seat: 1, name: 'Custom Codi', variant: first.variant });

    // boot a new office from that file: rehire restores the identity
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify(persisted));
    const reloaded = new Office(() => ['Knight', 'Mage', 'Rogue'], '/nonexistent/office.json');
    (reloaded as any).save = () => {};
    const rehire = reloaded.hireManual();
    expect(rehire.seat).toBe(1);
    expect(rehire.name).toBe('Custom Codi');
  });
});

describe('idle eviction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeEvictionOffice() {
    const office = new Office(() => ['Knight', 'Mage', 'Rogue'], '/nonexistent/office.json');
    (office as any).save = () => {};
    office.attachStreamer({ isDraining: () => false, clear: () => {}, setPressure: () => {}, setBoost: () => {} });
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

  it('idleTimeoutSec 0 means employees are never evicted', () => {
    const office = makeEvictionOffice();
    office.setStaffing({ idleTimeoutSec: 0 });
    const extra = office.hireManual(); // idle from birth
    vi.advanceTimersByTime(600_000);
    expect(office.getState().employees.find((e) => e.id === extra.id)).toBeDefined();
  });

  it('setting idleTimeoutSec to 0 cancels a pending eviction; restoring it re-arms', () => {
    const office = makeEvictionOffice();
    const extra = office.hireManual();
    vi.advanceTimersByTime(30_000); // halfway to eviction
    office.setStaffing({ idleTimeoutSec: 0 });
    vi.advanceTimersByTime(600_000);
    expect(office.getState().employees.find((e) => e.id === extra.id)).toBeDefined();
    office.setStaffing({ idleTimeoutSec: 10 });
    vi.advanceTimersByTime(10_001);
    expect(office.getState().employees.find((e) => e.id === extra.id)).toBeUndefined();
  });

  it('a shorter timeout applies to already-idle employees', () => {
    const office = makeEvictionOffice();
    const extra = office.hireManual();
    office.setStaffing({ idleTimeoutSec: 5 });
    vi.advanceTimersByTime(5_001);
    expect(office.getState().employees.find((e) => e.id === extra.id)).toBeUndefined();
  });

  it('clampStaffing floors idleTimeoutSec at 0 and ignores non-integers', () => {
    expect(clampStaffing({ idleTimeoutSec: -5 }).idleTimeoutSec).toBe(0);
    expect(clampStaffing({ idleTimeoutSec: 2.5 as any }).idleTimeoutSec).toBe(60);
    expect(clampStaffing({ idleTimeoutSec: 0 }).idleTimeoutSec).toBe(0);
    expect(clampStaffing({ idleTimeoutSec: 300 }).idleTimeoutSec).toBe(300);
  });

  it('timers from construction evict leftover extras with no activity at all', () => {
    const office = makeEvictionOffice();
    const before = office.getState().employees.length;
    office.hireManual(); // 1 extra, idle from birth
    vi.advanceTimersByTime(60_001);
    expect(office.getState().employees.length).toBe(Math.max(before, office.getState().staffing.minEmployees));
  });
});

describe('layout persistence', () => {
  function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
    return path.join(dir, 'office.json');
  }

  it('setLayout merges per-map and survives a save/load round-trip', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight'], file);
    office.setLayout({ seats: { 1: { x: 2, z: 3, rotY: 0.5 } } });
    office.setLayout({ furniture: { couch: { x: -1, z: 0, rotY: Math.PI } } });
    office.setLayout({ wallItems: { wallArt: 2.4 } });
    office.setLayout({ seats: { 2: { x: 0, z: 5, rotY: 0 } } });
    const reloaded = new Office(() => ['Knight'], file);
    const layout = reloaded.getState().layout!;
    expect(layout.seats![1]).toEqual({ x: 2, z: 3, rotY: 0.5 });
    expect(layout.seats![2]).toEqual({ x: 0, z: 5, rotY: 0 });
    expect(layout.furniture!.couch).toEqual({ x: -1, z: 0, rotY: Math.PI });
    expect(layout.wallItems!.wallArt).toBe(2.4);
  });

  it('resetLayout clears everything and persists the clear', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight'], file);
    office.setLayout({ seats: { 0: { x: 1, z: 1, rotY: 0 } }, wallItems: { windowBack: -3.9 } });
    office.resetLayout();
    expect(office.getState().layout).toBeUndefined();
    const reloaded = new Office(() => ['Knight'], file);
    expect(reloaded.getState().layout).toBeUndefined();
  });

  it('drops non-finite and malformed entries', () => {
    const office = new Office(() => ['Knight'], tempFile());
    office.setLayout({
      seats: { 1: { x: Infinity, z: 0, rotY: 0 }, 2: { x: 1, z: 1, rotY: 1 } },
      furniture: { couch: { x: 0 } as any, shelf: { x: 1, z: 2, rotY: 3 } },
      wallItems: { wallArt: NaN, pictureFrame: 1.5 },
    });
    const layout = office.getState().layout!;
    expect(layout.seats![1]).toBeUndefined();
    expect(layout.seats![2]).toEqual({ x: 1, z: 1, rotY: 1 });
    expect(layout.furniture!.couch).toBeUndefined();
    expect(layout.furniture!.shelf).toEqual({ x: 1, z: 2, rotY: 3 });
    expect(layout.wallItems!.wallArt).toBeUndefined();
    expect(layout.wallItems!.pictureFrame).toBe(1.5);
  });

  it('caps each map at 200 keys', () => {
    const office = new Office(() => ['Knight'], tempFile());
    for (let i = 0; i < 250; i++) office.setLayout({ seats: { [i]: { x: i, z: 0, rotY: 0 } } });
    expect(Object.keys(office.getState().layout!.seats!).length).toBeLessThanOrEqual(200);
  });

  it('broadcasts state after a layout change', () => {
    const office = new Office(() => ['Knight'], tempFile());
    const msgs: any[] = [];
    office.subscribe((m) => msgs.push(m));
    office.setLayout({ furniture: { couch: { x: 1, z: 1, rotY: 0 } } });
    const stateMsg = msgs.find((m) => m.type === 'state');
    expect(stateMsg?.state.layout?.furniture?.couch).toEqual({ x: 1, z: 1, rotY: 0 });
  });

  it('a legacy office.json with no layout loads with layout undefined', () => {
    const file = tempFile();
    const office = new Office(() => ['Knight'], file);
    office.save();
    const reloaded = new Office(() => ['Knight'], file);
    expect(reloaded.getState().layout).toBeUndefined();
  });
});
