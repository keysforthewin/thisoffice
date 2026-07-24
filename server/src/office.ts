import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Employee, OfficeState, InboxItem, TodoItem, ServerMsg, WorkerStatus } from '../../shared/types.ts';
import { CHARACTER_VARIANTS } from '../../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'office.json');

const INBOX_MAX = 8;

interface PersistedState {
  boss: { name: string; variant: string };
  employees: Array<Pick<Employee, 'id' | 'name' | 'seat' | 'variant' | 'hiredAt'>>;
}

type Listener = (msg: ServerMsg) => void;

const DEFAULT_EMPLOYEE_NAMES = ['Pat Chindexer', 'Sam Greppleton', 'Dee Bugger'];

export class Office {
  private state: OfficeState;
  private listeners = new Set<Listener>();
  /** activityKey (sessionId:toolUseId) -> employeeId */
  private assignments = new Map<string, string>();
  private inboxSeq = 0;

  constructor() {
    this.state = this.load();
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
          variant: CHARACTER_VARIANTS[(i + 1) % CHARACTER_VARIANTS.length],
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
    };
  }

  save() {
    const persisted: PersistedState = {
      boss: this.state.boss,
      employees: this.state.employees.map(({ id, name, seat, variant, hiredAt }) => ({ id, name, seat, variant, hiredAt })),
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
   * Assign the activity to an idle employee, hiring a new one if the office is full.
   * Returns the employee. New hires get a placeholder name; caller may rename async.
   */
  assign(activityKey: string, task: string): { employee: Employee; hired: boolean } {
    const existing = this.assignments.get(activityKey);
    if (existing) {
      const emp = this.state.employees.find((e) => e.id === existing)!;
      return { employee: emp, hired: false };
    }
    let employee = this.state.employees
      .filter((e) => e.status === 'idle')
      .sort((a, b) => a.seat - b.seat)[0];
    let hired = false;
    if (!employee) {
      employee = this.hire();
      hired = true;
    }
    employee.status = 'working';
    employee.task = task;
    this.assignments.set(activityKey, employee.id);
    this.broadcastState();
    return { employee, hired };
  }

  /** Mark the activity done; employee goes idle (screen keeps last output client-side). */
  finish(activityKey: string) {
    const empId = this.assignments.get(activityKey);
    if (!empId) return;
    this.assignments.delete(activityKey);
    const emp = this.state.employees.find((e) => e.id === empId);
    if (emp && ![...this.assignments.values()].includes(empId)) {
      emp.status = 'idle';
      emp.task = null;
    }
    this.broadcastState();
  }

  employeeFor(activityKey: string): Employee | undefined {
    const id = this.assignments.get(activityKey);
    return this.state.employees.find((e) => e.id === id);
  }

  private hire(): Employee {
    const seat = Math.max(0, ...this.state.employees.map((e) => e.seat)) + 1;
    const usedVariants = new Set([this.state.boss.variant, ...this.state.employees.map((e) => e.variant)]);
    const variant =
      CHARACTER_VARIANTS.find((v) => !usedVariants.has(v)) ??
      CHARACTER_VARIANTS[seat % CHARACTER_VARIANTS.length];
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
}
