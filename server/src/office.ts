import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterCatalog, Employee, OfficeState, InboxItem, ItemPose, OfficeLayout, PendingAsk, StatusItem, TodoItem, ServerMsg, WallArtConfig, WallArtExt, WallPlacement, WorkerStatus, StaffingSettings } from '../../shared/types.ts';
import { CHARACTER_VARIANTS, MONITOR_IMAGE_MARKER, WALL_ART_EXTS, WALL_SIDES, WALL_ART_ZOOM_MAX, WALL_ART_ZOOM_MIN } from '../../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'office.json');

const INBOX_MAX = 8;
const STATUS_MAX = 10;
/** Status lines stay one readable sentence; anything longer is truncated. */
const STATUS_TEXT_MAX = 120;

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

const DEFAULT_OFFICE_NAME = 'This Office';
const OFFICE_NAME_MAX = 60;

interface PersistedState {
  /** HUD title; absent in legacy files → default */
  officeName?: string;
  boss: { name: string; variant: string; bio?: string };
  employees: Array<Pick<Employee, 'id' | 'name' | 'seat' | 'variant' | 'hiredAt'>>;
  staffing?: StaffingSettings;
  /** office cat; absent in legacy files → she stays */
  katPerson?: boolean;
  /** per-seat identity memory: an evicted seat's occupant returns with the same name/model/bio */
  roster?: Array<{ seat: number; name: string; variant: string; bio?: string }>;
  /** boss monitor messages; survive server restarts so the boss screen isn't wiped */
  inbox?: InboxItem[];
  /** whiteboard todo list; survives server restarts like the inbox */
  todos?: { project: string; items: TodoItem[]; at?: string } | null;
  /** status whiteboard feed; survives server restarts like the inbox */
  status?: StatusItem[];
  /** build-mode layout overrides; absent = default layout */
  layout?: OfficeLayout;
  /** uploaded painting + its framing; the image itself lives in data/decor/ */
  wallArt?: WallArtConfig;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Merge a (possibly hostile, possibly hand-edited) wall-art patch. Returns
 * undefined unless the result names a stored image, so a framing-only patch can
 * never resurrect a painting that isn't on disk.
 */
export function mergeWallArt(base: WallArtConfig | undefined, patch: Partial<WallArtConfig>): WallArtConfig | undefined {
  const ext = patch.ext ?? base?.ext;
  const v = Number.isFinite(patch.v) ? patch.v! : base?.v;
  if (!ext || !(WALL_ART_EXTS as readonly string[]).includes(ext) || v === undefined) return undefined;
  const zoom = Number.isFinite(patch.zoom) ? patch.zoom! : base?.zoom ?? 1;
  const panX = Number.isFinite(patch.panX) ? patch.panX! : base?.panX ?? 0;
  // panY is absent from paintings framed before vertical panning existed
  const panY = Number.isFinite(patch.panY) ? patch.panY! : base?.panY ?? 0;
  return {
    v,
    ext: ext as WallArtExt,
    zoom: clamp(zoom, WALL_ART_ZOOM_MIN, WALL_ART_ZOOM_MAX),
    panX: clamp(panX, -1, 1),
    panY: clamp(panY, -1, 1),
  };
}

/** Per-map key cap: a layout only ever holds a few dozen items; this is a garbage guard. */
const LAYOUT_MAX_KEYS = 200;

function isPose(p: unknown): p is ItemPose {
  const o = p as ItemPose;
  return !!o && Number.isFinite(o.x) && Number.isFinite(o.z) && Number.isFinite(o.rotY);
}

function isWallPlacement(v: unknown): v is WallPlacement {
  const o = v as WallPlacement;
  return (
    !!o &&
    typeof o === 'object' &&
    (WALL_SIDES as readonly string[]).includes(o.wall) &&
    Number.isFinite(o.ox) &&
    Number.isFinite(o.oy)
  );
}

/** Merge a (possibly hostile) layout patch into `base`, keeping only well-formed entries. */
export function mergeLayout(base: OfficeLayout | undefined, patch: OfficeLayout): OfficeLayout {
  const out: OfficeLayout = { ...base };
  const cap = <T>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).slice(-LAYOUT_MAX_KEYS)) as Record<string, T>;
  if (patch.seats && typeof patch.seats === 'object') {
    const merged: Record<number, ItemPose> = { ...out.seats };
    for (const [k, v] of Object.entries(patch.seats)) {
      if (Number.isInteger(Number(k)) && Number(k) >= 0 && isPose(v)) {
        merged[Number(k)] = { x: v.x, z: v.z, rotY: v.rotY };
      }
    }
    out.seats = cap(merged);
  }
  if (patch.furniture && typeof patch.furniture === 'object') {
    const merged: Record<string, ItemPose> = { ...out.furniture };
    for (const [k, v] of Object.entries(patch.furniture)) {
      if (isPose(v)) merged[k] = { x: v.x, z: v.z, rotY: v.rotY };
    }
    out.furniture = cap(merged);
  }
  if (patch.wallItems && typeof patch.wallItems === 'object') {
    const merged: Record<string, WallPlacement | number> = { ...out.wallItems };
    for (const [k, v] of Object.entries(patch.wallItems)) {
      // a bare number is the legacy along-wall-offset-only shape; still accepted
      // so an office saved before walls were movable keeps its arrangement
      if (Number.isFinite(v)) merged[k] = v as number;
      else if (isWallPlacement(v)) merged[k] = { wall: v.wall, ox: v.ox, oy: v.oy };
    }
    out.wallItems = cap(merged);
  }
  return out;
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

/**
 * Names for every hire — the settings-panel button and the auto-hire that fires
 * when a new tool call finds no idle desk.
 *
 * Sized past `maxEmployees` (12) with room to spare so a full office never has
 * to repeat, and so the "unused names" pool is still large when most of the
 * roster is occupied. Auto-hire used to ask Haiku to invent a name per hire;
 * this list replaced that, so it also has to carry the whole range of pun
 * energy on its own.
 */
const HIRE_NAMES = [
  'Anna Lyzer',
  'Barb Wire',
  'Bea Yaml',
  'Cash Money',
  'Cliff Hanger',
  'Dot Enviro',
  'Ed Gecase',
  'Faye Talerror',
  'Gil Blameless',
  'Hugh Mergeconflict',
  'Ida Klarative',
  'Jay Sonparse',
  'Kay Oss',
  'Lin Terror',
  'Manny Festfile',
  'Mona Torlogs',
  'Nell Pointer',
  'Otto Complete',
  'Paige Fault',
  'Perl Scriptor',
  'Polly Fill',
  'Quinn Tessence',
  'Rachel Basecase',
  'Rex Ecutable',
  'Ruby Onrails',
  'Sara Bellum',
  'Stan Dupmeeting',
  'Tab Completion',
  'Terra Form',
  'Vi Malcolm',
  'Webb Hooke',
  'Yui Component',
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
  private statusSeq = 0;
  private variantPool: string[];
  private streamer: ScreenStream | null = null;
  /** employees whose activity finished but whose screen is still streaming */
  private pendingIdle = new Set<string>();
  /** activities waiting for a free employee (at max headcount) */
  private workQueue: Array<{ key: string; label: string }> = [];
  private assignCb: ((key: string, employee: Employee) => void) | null = null;
  private idleTimers = new Map<string, NodeJS.Timeout>();
  /** seat -> remembered identity; survives idle-eviction so rehires come back as the same person */
  private roster = new Map<number, { name: string; variant: string; bio?: string }>();
  /** rich free-text backstory; stored outside OfficeState so 8KB bios never ride the broadcasts */
  private bossBio = '';
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
    this.bossBio = typeof persisted.boss.bio === 'string' ? persisted.boss.bio : '';
    for (const r of persisted.roster ?? []) {
      if (Number.isInteger(r.seat) && r.seat > 0 && r.name && r.variant) {
        this.roster.set(r.seat, {
          name: r.name,
          variant: r.variant,
          ...(typeof r.bio === 'string' ? { bio: r.bio } : {}),
        });
      }
    }
    // current occupants are the freshest identity for their seat (also seeds legacy
    // files); merge so a roster-loaded bio survives the name/variant refresh
    for (const e of persisted.employees) {
      this.roster.set(e.seat, { ...this.roster.get(e.seat), name: e.name, variant: e.variant });
    }
    const inbox = (persisted.inbox ?? [])
      .filter((i) => i && i.id && typeof i.text === 'string')
      .map(({ fullText, ...rest }) => (typeof fullText === 'string' ? { ...rest, fullText } : rest))
      .slice(-INBOX_MAX);
    // resume the id sequence past restored items so new ids never collide
    this.inboxSeq = inbox.reduce((max, i) => Math.max(max, parseInt(i.id.replace('inbox-', ''), 10) || 0), 0);
    const status = (persisted.status ?? [])
      .filter((s) => s && s.id && typeof s.text === 'string')
      .slice(-STATUS_MAX);
    this.statusSeq = status.reduce((max, s) => Math.max(max, parseInt(s.id.replace('status-', ''), 10) || 0), 0);
    return {
      officeName:
        typeof persisted.officeName === 'string' && persisted.officeName.trim()
          ? persisted.officeName.trim().slice(0, OFFICE_NAME_MAX)
          : DEFAULT_OFFICE_NAME,
      // bio deliberately stripped: it lives in bossBio, never in the broadcast state
      boss: { name: persisted.boss.name, variant: persisted.boss.variant },
      bossStatus: 'idle',
      waitingForInput: false,
      employees: persisted.employees.map((e) => ({ ...e, status: 'idle' as WorkerStatus, task: null })),
      inbox,
      // legacy todos without a timestamp restore as epoch-0: an all-completed
      // list persisted before this field existed is treated as stale immediately
      todos:
        persisted.todos && Array.isArray(persisted.todos.items)
          ? { ...persisted.todos, at: persisted.todos.at ?? new Date(0).toISOString() }
          : null,
      status,
      staffing: clampStaffing(persisted.staffing),
      katPerson: persisted.katPerson !== false,
      // re-sanitize on load: office.json may have been hand-edited
      ...(persisted.layout ? { layout: mergeLayout(undefined, persisted.layout) } : {}),
      ...(() => {
        const art = persisted.wallArt ? mergeWallArt(undefined, persisted.wallArt) : undefined;
        return art ? { wallArt: art } : {};
      })(),
    };
  }

  save() {
    const persisted: PersistedState = {
      officeName: this.state.officeName,
      boss: { ...this.state.boss, ...(this.bossBio ? { bio: this.bossBio } : {}) },
      employees: this.state.employees.map(({ id, name, seat, variant, hiredAt }) => ({ id, name, seat, variant, hiredAt })),
      staffing: this.state.staffing,
      katPerson: this.state.katPerson,
      roster: [...this.roster.entries()]
        .sort(([a], [b]) => a - b)
        .map(([seat, r]) => ({ seat, ...r })),
      inbox: this.state.inbox,
      todos: this.state.todos,
      status: this.state.status,
      ...(this.state.layout ? { layout: this.state.layout } : {}),
      ...(this.state.wallArt ? { wallArt: this.state.wallArt } : {}),
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
        if (l.startsWith(MONITOR_IMAGE_MARKER + 'data:image/') || l.startsWith(MONITOR_IMAGE_MARKER + 'http')) snap.image = l;
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

  pushInbox(project: string, text: string, fullText?: string) {
    const item: InboxItem = {
      id: `inbox-${++this.inboxSeq}`,
      project,
      text,
      ...(fullText ? { fullText } : {}),
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
    this.state.todos = { project, items, at: new Date().toISOString() };
    this.save();
    this.broadcastState();
  }

  pushStatus(kind: StatusItem['kind'], text: string) {
    // an identical consecutive event (e.g. a session re-titled the same way)
    // refreshes the tail instead of stacking duplicates on the board
    const last = this.state.status.at(-1);
    if (last && last.kind === kind && last.text === text.slice(0, STATUS_TEXT_MAX)) {
      last.at = new Date().toISOString();
      this.save();
      this.broadcastState();
      return;
    }
    const item: StatusItem = {
      id: `status-${++this.statusSeq}`,
      at: new Date().toISOString(),
      text: text.slice(0, STATUS_TEXT_MAX),
      kind,
    };
    this.state.status = [...this.state.status, item].slice(-STATUS_MAX);
    this.save();
    this.broadcastState();
  }

  updateStatusText(id: string, text: string) {
    const item = this.state.status.find((s) => s.id === id);
    if (!item) return;
    item.text = text.slice(0, STATUS_TEXT_MAX);
    this.save();
    this.broadcastState();
  }

  get lastStatusId(): string {
    return `status-${this.statusSeq}`;
  }

  setBossStatus(status: WorkerStatus) {
    if (this.state.bossStatus === status) return;
    this.state.bossStatus = status;
    this.broadcastState();
  }

  /** Ephemeral (never persisted): some tailed session finished its turn and awaits the user. */
  setWaitingForInput(on: boolean) {
    // pendingAsk must never outlive the beacon, so going dark clears it in the
    // same broadcast — that covers every clear path the transcript already has
    // (user line, sibling eviction, stale sweep) with no extra bookkeeping.
    const dropAsk = !on && !!this.state.pendingAsk;
    if (this.state.waitingForInput === on && !dropAsk) return;
    this.state.waitingForInput = on;
    if (!on) delete this.state.pendingAsk;
    this.broadcastState();
  }

  /** Ephemeral: the plan-approval / question menu the session is blocked on. */
  setPendingAsk(ask: PendingAsk) {
    if (this.state.pendingAsk?.id === ask.id) return;
    this.state.pendingAsk = ask;
    this.broadcastState();
  }

  getBossBio(): string {
    return this.bossBio;
  }

  setBossBio(bio: string) {
    this.bossBio = bio;
    this.save();
  }

  getEmployeeBio(id: string): string | null {
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp) return null;
    return this.roster.get(emp.seat)?.bio ?? '';
  }

  setEmployeeBio(id: string, bio: string): boolean {
    const emp = this.state.employees.find((e) => e.id === id);
    if (!emp) return false;
    this.roster.set(emp.seat, { name: emp.name, variant: emp.variant, ...this.roster.get(emp.seat), bio });
    this.save();
    return true;
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

  /**
   * A hire name nobody in the office is using, or a random one if all 32 are
   * somehow taken. Synchronous by design — auto-hire previously shelled out to
   * the `claude` CLI for a generated name, which meant the employee sat at their
   * desk labelled "New Hire" until the call returned.
   */
  pickHireName(): string {
    const usedNames = new Set(this.state.employees.map((e) => e.name));
    const fresh = HIRE_NAMES.filter((n) => !usedNames.has(n));
    const names = fresh.length ? fresh : HIRE_NAMES;
    return names[Math.floor(Math.random() * names.length)];
  }

  /** Settings-panel hire: remembered identity if the seat has one, else random; editable afterwards. */
  hireManual(): Employee {
    const employee = this.hire();
    if (employee.name === 'New Hire') {
      employee.name = this.pickHireName();
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
    // merge: rename/setVariant must not clobber a stored bio
    this.roster.set(emp.seat, { ...this.roster.get(emp.seat), name: emp.name, variant: emp.variant });
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

  /** HUD title. Empty/whitespace resets to the default; capped at 60 chars. */
  setOfficeName(name: string) {
    this.state.officeName = name.trim().slice(0, OFFICE_NAME_MAX) || DEFAULT_OFFICE_NAME;
    this.save();
    this.broadcastState();
  }

  setBoss(cfg: Partial<{ name: string; variant: string }>): void {
    if (typeof cfg.name === 'string') this.state.boss.name = cfg.name;
    if (typeof cfg.variant === 'string') this.state.boss.variant = cfg.variant;
    this.save();
    this.broadcastState();
  }

  /** Build mode drops an item: merge the (usually single-key) patch into the stored layout. */
  setLayout(patch: OfficeLayout) {
    this.state.layout = mergeLayout(this.state.layout, patch);
    this.save();
    this.broadcastState();
  }

  /** Settings-panel reset: everything returns to the built-in default layout.
   *  The uploaded painting is a wall hanging too, so it goes back to the
   *  built-in artwork — deleting the stored image is the caller's job (the
   *  route owns the filesystem side; see index.ts). */
  resetLayout() {
    delete this.state.layout;
    delete this.state.wallArt;
    this.save();
    this.broadcastState();
  }

  /** A new upload (`v` + `ext`) or a framing change (`zoom`/`panX`) for the painting. */
  setWallArt(patch: Partial<WallArtConfig>) {
    const next = mergeWallArt(this.state.wallArt, patch);
    if (!next) return;
    this.state.wallArt = next;
    this.save();
    this.broadcastState();
  }

  /** Back to the built-in artwork. */
  clearWallArt() {
    if (!this.state.wallArt) return;
    delete this.state.wallArt;
    this.save();
    this.broadcastState();
  }

  setKatPerson(show: boolean) {
    this.state.katPerson = show;
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
