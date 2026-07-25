import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterCatalog, Employee, OfficeState, InboxItem, TodoItem, ServerMsg, WorkerStatus, StaffingSettings } from '../../shared/types.ts';
import { CHARACTER_VARIANTS } from '../../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'office.json');

const INBOX_MAX = 8;

const DEFAULT_STAFFING: StaffingSettings = { minEmployees: 3, maxEmployees: 12 };

const IDLE_FIRE_MS = 60_000;

interface PersistedState {
  boss: { name: string; variant: string };
  employees: Array<Pick<Employee, 'id' | 'name' | 'seat' | 'variant' | 'hiredAt'>>;
  staffing?: StaffingSettings;
}

type Listener = (msg: ServerMsg) => void;

/** Narrow view of ScreenStreamer so Office never imports it (avoids a cycle). */
export interface ScreenStream {
  isDraining(id: string): boolean;
  clear(id: string): void;
  setPressure(n: number): void;
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

  constructor(
    variantPoolProvider?: () => string[],
    private idleFireMs = IDLE_FIRE_MS,
  ) {
    this.variantPool = variantPoolProvider?.() ?? loadVariantPool();
    if (!this.variantPool.length) this.variantPool = loadVariantPool();
    this.state = this.load();
    for (const e of this.state.employees) this.scheduleIdleTimer(e.id);
  }

  private scheduleIdleTimer(id: string) {
    this.clearIdleTimer(id);
    const t = setTimeout(() => this.fireIfIdle(id), this.idleFireMs);
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
    if (this.state.employees.length <= this.state.staffing.minEmployees) return;
    const protectedIds = [...this.state.employees]
      .sort((a, b) => a.seat - b.seat)
      .slice(0, this.state.staffing.minEmployees)
      .map((e) => e.id);
    if (protectedIds.includes(id)) return;
    this.remove(id);
  }

  /** Refresh the pool of variants used for auto-assigning new hires. */
  setVariantPool(ids: string[]) {
    if (ids.length) this.variantPool = ids;
  }

  attachStreamer(s: ScreenStream) {
    this.streamer = s;
  }

  /** Transcripts registers to replay buffered content when a queued job is picked up. */
  onAssign(cb: (key: string, employee: Employee) => void) {
    this.assignCb = cb;
  }

  private syncPressure() {
    this.streamer?.setPressure(this.workQueue.length);
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
      persisted = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
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
    return {
      boss: persisted.boss,
      bossStatus: 'idle',
      employees: persisted.employees.map((e) => ({ ...e, status: 'idle' as WorkerStatus, task: null })),
      inbox: [],
      todos: null,
      staffing: { ...DEFAULT_STAFFING, ...persisted.staffing },
    };
  }

  save() {
    const persisted: PersistedState = {
      boss: this.state.boss,
      employees: this.state.employees.map(({ id, name, seat, variant, hiredAt }) => ({ id, name, seat, variant, hiredAt })),
      staffing: this.state.staffing,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(persisted, null, 2));
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
    this.emit({ type: 'monitor', target, ...opts });
  }

  pushInbox(project: string, text: string) {
    const item: InboxItem = {
      id: `inbox-${++this.inboxSeq}`,
      project,
      text,
      at: new Date().toISOString(),
    };
    this.state.inbox = [...this.state.inbox, item].slice(-INBOX_MAX);
    this.broadcastState();
  }

  updateInboxText(id: string, text: string) {
    const item = this.state.inbox.find((i) => i.id === id);
    if (!item) return;
    item.text = text;
    this.broadcastState();
  }

  get lastInboxId(): string {
    return `inbox-${this.inboxSeq}`;
  }

  setTodos(project: string, items: TodoItem[]) {
    this.state.todos = { project, items };
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

  employeeFor(activityKey: string): Employee | undefined {
    const id = this.assignments.get(activityKey);
    return this.state.employees.find((e) => e.id === id);
  }

  /** Settings-panel hire: random name + random character; editable afterwards. */
  hireManual(): Employee {
    const usedNames = new Set(this.state.employees.map((e) => e.name));
    const fresh = HIRE_NAMES.filter((n) => !usedNames.has(n));
    const names = fresh.length ? fresh : HIRE_NAMES;
    const employee = this.hire();
    employee.name = names[Math.floor(Math.random() * names.length)];
    const usedVariants = new Set([this.state.boss.variant, ...this.state.employees.map((e) => e.variant)]);
    const unusedVariants = this.variantPool.filter((v) => !usedVariants.has(v));
    const variants = unusedVariants.length ? unusedVariants : this.variantPool;
    employee.variant = variants[Math.floor(Math.random() * variants.length)];
    this.save();
    this.broadcastState();
    return employee;
  }

  private hire(): Employee {
    const seat = Math.max(0, ...this.state.employees.map((e) => e.seat)) + 1;
    const usedVariants = new Set([this.state.boss.variant, ...this.state.employees.map((e) => e.variant)]);
    const variant =
      this.variantPool.find((v) => !usedVariants.has(v)) ??
      this.variantPool[seat % this.variantPool.length];
    const employee: Employee = {
      id: `emp-${Date.now()}-${seat}`,
      name: 'New Hire',
      seat,
      variant,
      hiredAt: new Date().toISOString(),
      status: 'idle',
      task: null,
    };
    this.state.employees.push(employee);
    this.scheduleIdleTimer(employee.id);
    this.save();
    return employee;
  }

  rename(id: string, name: string): boolean {
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp) return false;
    emp.name = name;
    this.save();
    this.broadcastState();
    return true;
  }

  setVariant(id: string, variant: string): boolean {
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp) return false;
    emp.variant = variant;
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
    this.pendingIdle.delete(id);
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
    const s = { ...this.state.staffing };
    if (Number.isInteger(cfg.minEmployees)) s.minEmployees = Math.max(1, cfg.minEmployees!);
    if (Number.isInteger(cfg.maxEmployees)) s.maxEmployees = Math.max(1, cfg.maxEmployees!);
    if (s.minEmployees > s.maxEmployees) s.minEmployees = s.maxEmployees;
    this.state.staffing = s;
    this.save();
    this.broadcastState();
  }
}
