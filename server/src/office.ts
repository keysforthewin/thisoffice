import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterCatalog, Employee, OfficeState, InboxItem, TodoItem, ServerMsg, WorkerStatus, StaffingSettings } from '../../shared/types.ts';
import { CHARACTER_VARIANTS, MONITOR_IMAGE_MARKER } from '../../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'office.json');

const INBOX_MAX = 8;

const DEFAULT_STAFFING: StaffingSettings = { minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 };

/** Enough to refill a monitor (screens show ~16 rows) without keeping full history. */
const SCREEN_MAX_LINES = 60;

interface ScreenSnapshot {
  title: string;
  lines: string[];
  /** last MONITOR_IMAGE_MARKER line seen since the last clear */
  image?: string;
}

/** Clamp a (possibly hand-edited or partial) staffing config to valid integers, min <= max. */
export function clampStaffing(cfg: Partial<StaffingSettings> | undefined, base: StaffingSettings = DEFAULT_STAFFING): StaffingSettings {
  const s = { ...base };
  if (Number.isInteger(cfg?.minEmployees)) s.minEmployees = Math.max(1, cfg!.minEmployees!);
  if (Number.isInteger(cfg?.maxEmployees)) s.maxEmployees = Math.max(1, cfg!.maxEmployees!);
  if (Number.isInteger(cfg?.idleTimeoutSec)) s.idleTimeoutSec = Math.max(0, cfg!.idleTimeoutSec!);
  if (s.minEmployees > s.maxEmployees) s.minEmployees = s.maxEmployees;
  return s;
}

interface PersistedState {
  boss: { name: string; variant: string };
  employees: Array<Pick<Employee, 'id' | 'name' | 'seat' | 'variant' | 'hiredAt'>>;
  staffing?: StaffingSettings;
  /** per-seat identity memory: an evicted seat's occupant returns with the same name/model */
  roster?: Array<{ seat: number; name: string; variant: string }>;
  /** boss monitor messages; survive server restarts so the boss screen isn't wiped */
  inbox?: InboxItem[];
  /** whiteboard todo list; survives server restarts like the inbox */
  todos?: { project: string; items: TodoItem[] } | null;
}

type Listener = (msg: ServerMsg) => void;

/** Narrow view of ScreenStreamer so Office never imports it (avoids a cycle). */
export interface ScreenStream {
  isDraining(id: string): boolean;
  clear(id: string): void;
  setPressure(n: number): void;
  setBoost(on: boolean): void;
}

const DEFAULT_EMPLOYEE_NAMES = ['Pat Chindexer', 'Sam Greppleton', 'Dee Bugger'];

/** Names for manually hired employees, same pun energy as the defaults */
const HIRE_NAMES = [
  'Anna Lyzer',
  'Cash Money',
  'Gil Blameless',
  'Hugh Mergeconflict',
  'Kay Oss',
  'Lin Terror',
  'Mona Torlogs',
  'Nell Pointer',
  'Perl Scriptor',
  'Polly Fill',
  'Rachel Basecase',
  'Rex Ecutable',
  'Sara Bellum',
  'Stan Dupmeeting',
  'Tab Completion',
];

const CATALOG_FILE = path.resolve(__dirname, '../../web/public/models/characters/catalog.json');

/** Variant ids from the generated character catalog; falls back to the built-in tuple. */
function loadVariantPool(): string[] {
  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
    const ids = (catalog.characters ?? []).map((c: { id: string }) => c.id).filter(Boolean);
    if (ids.length) return ids;
  } catch {
    /* catalog not generated yet */
  }
  return [...CHARACTER_VARIANTS];
}

export class Office {
  private state: OfficeState;
  private listeners = new Set<Listener>();
  /** activityKey (sessionId:toolUseId) -> employeeId */
  private assignments = new Map<string, string>();
  private inboxSeq = 0;
  private variantPool: string[];
  private streamer: ScreenStream | null = null;
  /** employees whose activity finished but whose screen is still streaming */
  private pendingIdle = new Set<string>();
  /** activities waiting for a free employee (at max headcount) */
  private workQueue: Array<{ key: string; label: string }> = [];
  private assignCb: ((key: string, employee: Employee) => void) | null = null;
  private idleTimers = new Map<string, NodeJS.Timeout>();
  /** seat -> remembered identity; survives idle-eviction so rehires come back as the same person */
  private roster = new Map<number, { name: string; variant: string }>();
  /** target -> what's on that monitor right now, so a reconnecting client can rebuild it */
  private screens = new Map<string, ScreenSnapshot>();

  constructor(
    variantPoolProvider?: () => string[],
    private dataFile = DATA_FILE,
  ) {
    this.variantPool = variantPoolProvider?.() ?? loadVariantPool();
    if (!this.variantPool.length) this.variantPool = loadVariantPool();
    this.state = this.load();
    for (const e of this.state.employees) this.scheduleIdleTimer(e.id);
  }

  private scheduleIdleTimer(id: string) {
    this.clearIdleTimer(id);
    const sec = this.state.staffing.idleTimeoutSec;
    if (sec === 0) return; // 0 = employees never leave
    const t = setTimeout(() => this.fireIfIdle(id), sec * 1000);
    t.unref?.();
    this.idleTimers.set(id, t);
  }

  private clearIdleTimer(id: string) {
    const t = this.idleTimers.get(id);
    if (t) clearTimeout(t);
    this.idleTimers.delete(id);
  }

  /** Idle for the full window: let them go, unless they're part of the core staff. */
  private fireIfIdle(id: string) {
    this.idleTimers.delete(id);
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp || emp.status !== 'idle') return;
    if (this.state.employees.length <= this.state.staffing.minEmployees) {
      this.scheduleIdleTimer(id);
      return;
    }
    const protectedIds = [...this.state.employees]
      .sort((a, b) => a.seat - b.seat)
      .slice(0, this.state.staffing.minEmployees)
      .map((e) => e.id);
    if (protectedIds.includes(id)) {
      this.scheduleIdleTimer(id);
      return;
    }
    this.remove(id);
  }

  /** Refresh the pool of variants used for auto-assigning new hires. */
  setVariantPool(ids: string[]) {
    if (ids.length) this.variantPool = ids;
  }

  attachStreamer(s: ScreenStream) {
    this.streamer = s;
    this.syncPressure();
  }

  /** Transcripts registers to replay buffered content when a queued job is picked up. */
  onAssign(cb: (key: string, employee: Employee) => void) {
    this.assignCb = cb;
  }

  private syncPressure() {
    this.streamer?.setPressure(this.workQueue.length);
    this.streamer?.setBoost(this.state.employees.length >= this.state.staffing.maxEmployees);
  }

  /** Called when an employee's screen queue empties; completes a deferred finish. */
  notifyDrained(employeeId: string) {
    if (!this.pendingIdle.delete(employeeId)) return;
    if ([...this.assignments.values()].includes(employeeId)) return;
    this.setIdle(employeeId);
  }

  private setIdle(employeeId: string) {
    const emp = this.state.employees.find((e) => e.id === employeeId);
    if (!emp) return;
    const job = this.workQueue.shift();
    if (job) {
      this.clearIdleTimer(emp.id);
      this.syncPressure();
      emp.status = 'working';
      emp.task = job.label;
      this.assignments.set(job.key, emp.id);
      this.broadcastState();
      this.assignCb?.(job.key, emp);
      return;
    }
    emp.status = 'idle';
    emp.task = null;
    this.scheduleIdleTimer(emp.id);
    this.broadcastState();
  }

  /** Broadcast a refreshed character catalog to all connected clients. */
  emitCatalog(catalog: CharacterCatalog) {
    this.emit({ type: 'catalog', catalog });
  }

  private load(): OfficeState {
    let persisted: PersistedState | null = null;
    try {
      persisted = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
    } catch {
      /* first run */
    }
    if (!persisted) {
      persisted = {
        boss: { name: 'The Boss', variant: 'Knight' },
        employees: DEFAULT_EMPLOYEE_NAMES.map((name, i) => ({
          id: `emp-${i + 1}`,
          name,
          seat: i + 1,
          variant: this.variantPool[(i + 1) % this.variantPool.length],
          hiredAt: new Date().toISOString(),
        })),
      };
    }
    for (const r of persisted.roster ?? []) {
      if (Number.isInteger(r.seat) && r.seat > 0 && r.name && r.variant) {
        this.roster.set(r.seat, { name: r.name, variant: r.variant });
      }
    }
    // current occupants are the freshest identity for their seat (also seeds legacy files)
    for (const e of persisted.employees) this.roster.set(e.seat, { name: e.name, variant: e.variant });
    const inbox = (persisted.inbox ?? []).filter((i) => i && i.id && typeof i.text === 'string').slice(-INBOX_MAX);
    // resume the id sequence past restored items so new ids never collide
    this.inboxSeq = inbox.reduce((max, i) => Math.max(max, parseInt(i.id.replace('inbox-', ''), 10) || 0), 0);
    return {
      boss: persisted.boss,
      bossStatus: 'idle',
      employees: persisted.employees.map((e) => ({ ...e, status: 'idle' as WorkerStatus, task: null })),
      inbox,
      todos: persisted.todos && Array.isArray(persisted.todos.items) ? persisted.todos : null,
      staffing: clampStaffing(persisted.staffing),
    };
  }

  save() {
    const persisted: PersistedState = {
      boss: this.state.boss,
      employees: this.state.employees.map(({ id, name, seat, variant, hiredAt }) => ({ id, name, seat, variant, hiredAt })),
      staffing: this.state.staffing,
      roster: [...this.roster.entries()]
        .sort(([a], [b]) => a - b)
        .map(([seat, r]) => ({ seat, ...r })),
      inbox: this.state.inbox,
      todos: this.state.todos,
    };
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(persisted, null, 2));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMsg) {
    for (const fn of this.listeners) fn(msg);
  }

  getState(): OfficeState {
    return this.state;
  }

  broadcastState() {
    this.emit({ type: 'state', state: this.state });
  }

  monitor(target: string, opts: { title?: string; append?: string; clear?: boolean }) {
    const snap: ScreenSnapshot = opts.clear
      ? { title: '', lines: [] }
      : (this.screens.get(target) ?? { title: '', lines: [] });
    if (opts.title !== undefined) snap.title = opts.title;
    if (opts.append) {
      for (const l of opts.append.split('\n')) {
        if (l.startsWith(MONITOR_IMAGE_MARKER + 'data:image/')) snap.image = l;
        else snap.lines.push(l);
      }
      snap.lines = snap.lines.slice(-SCREEN_MAX_LINES);
    }
    this.screens.set(target, snap);
    this.emit({ type: 'monitor', target, ...opts });
  }

  /** One monitor message per screen that rebuilds it as it looks right now (sent to new connections). */
  screenReplay(): ServerMsg[] {
    return [...this.screens.entries()].map(([target, s]): ServerMsg => {
      const lines = s.image ? [...s.lines, s.image] : s.lines;
      return {
        type: 'monitor',
        target,
        clear: true,
        title: s.title,
        ...(lines.length ? { append: lines.join('\n') } : {}),
      };
    });
  }

  pushInbox(project: string, text: string) {
    const item: InboxItem = {
      id: `inbox-${++this.inboxSeq}`,
      project,
      text,
      at: new Date().toISOString(),
    };
    this.state.inbox = [...this.state.inbox, item].slice(-INBOX_MAX);
    this.save();
    this.broadcastState();
  }

  updateInboxText(id: string, text: string) {
    const item = this.state.inbox.find((i) => i.id === id);
    if (!item) return;
    item.text = text;
    this.save();
    this.broadcastState();
  }

  get lastInboxId(): string {
    return `inbox-${this.inboxSeq}`;
  }

  setTodos(project: string, items: TodoItem[]) {
    this.state.todos = { project, items };
    this.save();
    this.broadcastState();
  }

  setBossStatus(status: WorkerStatus) {
    if (this.state.bossStatus === status) return;
    this.state.bossStatus = status;
    this.broadcastState();
  }

  /**
   * Assign the activity to an idle employee, hiring a new one if under max headcount.
   * At max headcount the activity is queued and `employee` is null; the caller should
   * drop the work for now (a queued job is later picked up via `onAssign`).
   * New hires get a placeholder name; caller may rename async.
   */
  assign(activityKey: string, task: string): { employee: Employee | null; hired: boolean } {
    const existing = this.assignments.get(activityKey);
    if (existing) {
      const emp = this.state.employees.find((e) => e.id === existing)!;
      return { employee: emp, hired: false };
    }
    let employee = this.state.employees
      .filter((e) => e.status === 'idle' && !this.streamer?.isDraining(e.id))
      .sort((a, b) => a.seat - b.seat)[0];
    let hired = false;
    if (!employee) {
      if (this.state.employees.length >= this.state.staffing.maxEmployees) {
        if (this.workQueue.some((j) => j.key === activityKey)) return { employee: null, hired: false };
        this.workQueue.push({ key: activityKey, label: task });
        this.syncPressure();
        return { employee: null, hired: false };
      }
      employee = this.hire();
      hired = true;
    }
    this.clearIdleTimer(employee.id);
    employee.status = 'working';
    employee.task = task;
    this.assignments.set(activityKey, employee.id);
    this.broadcastState();
    return { employee, hired };
  }

  /**
   * Mark the activity done. The employee goes idle once their screen has
   * finished streaming (immediately if it already has).
   */
  finish(activityKey: string) {
    const empId = this.assignments.get(activityKey);
    if (!empId) return;
    this.assignments.delete(activityKey);
    if ([...this.assignments.values()].includes(empId)) return;
    if (this.streamer?.isDraining(empId)) {
      this.pendingIdle.add(empId);
      return;
    }
    this.setIdle(empId);
  }

  /** Drop a still-queued job (e.g. its parent Task finished before it was ever picked up). */
  cancelQueued(activityKey: string): boolean {
    const before = this.workQueue.length;
    this.workQueue = this.workQueue.filter((j) => j.key !== activityKey);
    if (this.workQueue.length === before) return false;
    this.syncPressure();
    return true;
  }

  employeeFor(activityKey: string): Employee | undefined {
    const id = this.assignments.get(activityKey);
    return this.state.employees.find((e) => e.id === id);
  }

  /** Settings-panel hire: remembered identity if the seat has one, else random; editable afterwards. */
  hireManual(): Employee {
    const employee = this.hire();
    if (employee.name === 'New Hire') {
      const usedNames = new Set(this.state.employees.map((e) => e.name));
      const fresh = HIRE_NAMES.filter((n) => !usedNames.has(n));
      const names = fresh.length ? fresh : HIRE_NAMES;
      employee.name = names[Math.floor(Math.random() * names.length)];
      const usedVariants = new Set([this.state.boss.variant, ...this.state.employees.map((e) => e.variant)]);
      const unusedVariants = this.variantPool.filter((v) => !usedVariants.has(v));
      const variants = unusedVariants.length ? unusedVariants : this.variantPool;
      employee.variant = variants[Math.floor(Math.random() * variants.length)];
      this.remember(employee);
    }
    this.save();
    this.broadcastState();
    return employee;
  }

  private remember(emp: Employee) {
    this.roster.set(emp.seat, { name: emp.name, variant: emp.variant });
  }

  private hire(): Employee {
    // lowest free seat, so an evicted seat's remembered occupant comes back
    const usedSeats = new Set(this.state.employees.map((e) => e.seat));
    let seat = 1;
    while (usedSeats.has(seat)) seat++;
    const remembered = this.roster.get(seat);
    const usedVariants = new Set([this.state.boss.variant, ...this.state.employees.map((e) => e.variant)]);
    const variant =
      remembered?.variant ??
      this.variantPool.find((v) => !usedVariants.has(v)) ??
      this.variantPool[seat % this.variantPool.length];
    const employee: Employee = {
      id: `emp-${Date.now()}-${seat}`,
      name: remembered?.name ?? 'New Hire',
      seat,
      variant,
      hiredAt: new Date().toISOString(),
      status: 'idle',
      task: null,
    };
    this.remember(employee);
    this.state.employees.push(employee);
    this.scheduleIdleTimer(employee.id);
    this.syncPressure();
    this.save();
    return employee;
  }

  rename(id: string, name: string): boolean {
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp) return false;
    emp.name = name;
    this.remember(emp);
    this.save();
    this.broadcastState();
    return true;
  }

  setVariant(id: string, variant: string): boolean {
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp) return false;
    emp.variant = variant;
    this.remember(emp);
    this.save();
    this.broadcastState();
    return true;
  }

  remove(id: string): boolean {
    const before = this.state.employees.length;
    this.state.employees = this.state.employees.filter((e) => e.id !== id);
    for (const [key, empId] of this.assignments) if (empId === id) this.assignments.delete(key);
    if (this.state.employees.length === before) return false;
    this.clearIdleTimer(id);
    this.streamer?.clear(id);
    this.screens.delete(id);
    this.pendingIdle.delete(id);
    this.syncPressure();
    this.save();
    this.broadcastState();
    return true;
  }

  setBoss(cfg: Partial<{ name: string; variant: string }>): void {
    if (typeof cfg.name === 'string') this.state.boss.name = cfg.name;
    if (typeof cfg.variant === 'string') this.state.boss.variant = cfg.variant;
    this.save();
    this.broadcastState();
  }

  setStaffing(cfg: Partial<StaffingSettings>) {
    this.state.staffing = clampStaffing(cfg, this.state.staffing);
    this.syncPressure();
    // re-arm under the new timeout (clears timers when it's 0)
    for (const e of this.state.employees) {
      if (e.status === 'idle') this.scheduleIdleTimer(e.id);
      else this.clearIdleTimer(e.id);
    }
    this.save();
    this.broadcastState();
  }
}
