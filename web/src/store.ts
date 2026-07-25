import { create } from 'zustand';
import { MONITOR_IMAGE_MARKER, type CharacterCatalog, type ItemPose, type OfficeLayout, type OfficeState, type ServerMsg, type UsageStats } from '../../shared/types.ts';
import { boardContent } from './scene/whiteboardContent.ts';
import { activityTtl } from './scene/movieShots.ts';
import { appendHistory } from './scene/monitorScrollback.ts';

export interface MonitorContent {
  title: string;
  lines: string[];
  /** data URL of an image the worker looked at (e.g. Read on a PNG); shown until the next clear */
  image?: string;
}

const MONITOR_MAX_LINES = 200;

/** serializable camera snapshot: world position + orientation quaternion */
export interface CameraPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export type CameraMode =
  | { kind: 'free' }
  | { kind: 'pov'; index: number }
  | { kind: 'movie' }
  /**
   * Camera parked in front of one monitor; `from` is the mode to restore on
   * exit, `returnPose` the free-camera spot to fly back to (unset when entered
   * from pov/movie — those modes reposition the camera themselves).
   */
  | { kind: 'focus'; target: string; from: CameraMode; returnPose?: CameraPose; relock?: boolean };

/**
 * Should a missed click (R3F onPointerMissed) exit focus mode? Only when the
 * gesture started AND ended parked in the very same focus mode. A tap that
 * entered (or switched) focus fires its `click` while the camera is mid-flight
 * — its raycast lands on empty space and must not immediately exit. Mode
 * objects are recreated on every change, so reference equality identifies
 * "nothing happened since pointerdown".
 */
export function shouldExitFocusOnMissedClick(cur: CameraMode, gestureStartMode: CameraMode | null): boolean {
  return cur.kind === 'focus' && cur === gestureStartMode;
}

/**
 * The focus mode a monitor click produces: switching monitors keeps the original
 * exit state. `relock` marks entries made from a pointer-locked first person so
 * the exit can re-acquire the lock instead of dumping the user into cursor mode.
 */
export function enterFocusMode(cur: CameraMode, target: string, pose: CameraPose, relock = false): CameraMode {
  if (cur.kind === 'focus') return { kind: 'focus', target, from: cur.from, returnPose: cur.returnPose, relock: cur.relock };
  return {
    kind: 'focus',
    target,
    from: cur,
    returnPose: cur.kind === 'free' ? pose : undefined,
    relock: relock && cur.kind === 'free' ? true : undefined,
  };
}

/** An object currently being dragged in build mode; the pose is the on-screen ghost. */
export interface BuildHold {
  kind: 'seat' | 'furniture' | 'wall';
  /** seat number, furniture id, or wall-item id */
  key: number | string;
  /** floor items: the ghost pose following the cursor */
  ghost: ItemPose | null;
  /** wall items: the ghost along-wall offset */
  ghostOffset: number | null;
  valid: boolean;
}

interface AppStore {
  office: OfficeState | null;
  stats: UsageStats | null;
  monitors: Record<string, MonitorContent>;
  /** bumps every time a monitor changes so screens know to redraw */
  monitorVersion: Record<string, number>;
  /** scrollback per monitor: raw lines that survive the per-tool clears, with divider lines at each clear */
  monitorHistory: Record<string, string[]>;
  /** focus-mode scroll position in wrapped rows from the bottom; 0 = live tail */
  focusScroll: number;
  /** focus exit wants the fly cam pointer-locked again; cleared once the lock is re-acquired */
  pendingRelock: boolean;
  /** monitor under the cursor (or under the fly-cam crosshair): 'boss' | employee id | null */
  monitorHover: string | null;
  /** subject key ('boss' | employee id | 'whiteboard') → epoch ms of last content change */
  lastActivity: Record<string, number>;
  connected: boolean;
  cameraMode: CameraMode;
  settingsOpen: boolean;
  catalog: CharacterCatalog | null;
  /** B toggles: cursor visible, camera frozen, objects draggable */
  buildMode: boolean;
  buildHold: BuildHold | null;
  applyServerMsg: (msg: ServerMsg) => void;
  setConnected: (v: boolean) => void;
  setCameraMode: (m: CameraMode) => void;
  setFocusScroll: (n: number) => void;
  setPendingRelock: (v: boolean) => void;
  setMonitorHover: (target: string | null) => void;
  setSettingsOpen: (v: boolean) => void;
  setCatalog: (c: CharacterCatalog) => void;
  /** optimistic local patch while an adjustment slider drags; server broadcast confirms it */
  patchCharacter: (id: string, patch: { scale?: number; seatOffset?: number; chairHeight?: number }) => void;
  setBuildMode: (v: boolean) => void;
  setBuildHold: (h: BuildHold | null) => void;
  /** optimistic local merge on drop; the server broadcast confirms it */
  patchLayout: (patch: OfficeLayout) => void;
}

let whiteboardKey: string | null = null;
/** id of the newest inbox item last seen; a new tail id means the boss just received a message */
let inboxKey: string | null = null;
/** id of the newest status item last seen; keyed on id so summarizer text rewrites don't re-stamp */
let statusKey: string | null = null;
/** last-seen stats snapshot key; guards against re-stamping the TV on the connect replay */
let tvStatsKey: string | null = null;

/** stamp `key` as active now, dropping entries that have already fallen outside the movie camera's window */
function stampActivity(lastActivity: Record<string, number>, key: string): Record<string, number> {
  const now = Date.now();
  const next: Record<string, number> = { [key]: now };
  for (const k in lastActivity) {
    if (k !== key && now - lastActivity[k] < activityTtl(k)) next[k] = lastActivity[k];
  }
  return next;
}

export const useStore = create<AppStore>((set, get) => ({
  office: null,
  stats: null,
  monitors: {},
  monitorVersion: {},
  monitorHistory: {},
  focusScroll: 0,
  pendingRelock: false,
  monitorHover: null,
  lastActivity: {},
  connected: false,
  cameraMode: { kind: 'free' },
  settingsOpen: false,
  catalog: null,
  buildMode: false,
  buildHold: null,

  applyServerMsg: (msg) => {
    if (msg.type === 'state') {
      const key = JSON.stringify(boardContent(msg.state));
      const prevKey = whiteboardKey;
      whiteboardKey = key;
      // keyed on the tail id (not text) so the summarizer's later rewrite doesn't re-stamp
      const tailId = msg.state.inbox.at(-1)?.id ?? '';
      const prevInboxKey = inboxKey;
      inboxKey = tailId;
      // `?? []` guards against an older server without the status field
      const statusTailId = (msg.state.status ?? []).at(-1)?.id ?? '';
      const prevStatusKey = statusKey;
      statusKey = statusTailId;
      let lastActivity = get().lastActivity;
      if (prevKey !== null && prevKey !== key) lastActivity = stampActivity(lastActivity, 'whiteboard');
      if (prevInboxKey !== null && prevInboxKey !== tailId) lastActivity = stampActivity(lastActivity, 'boss');
      if (prevStatusKey !== null && prevStatusKey !== statusTailId) lastActivity = stampActivity(lastActivity, 'statusboard');
      set({ office: msg.state, lastActivity });
      return;
    }
    if (msg.type === 'catalog') {
      set({ catalog: msg.catalog });
      return;
    }
    if (msg.type === 'stats') {
      const key = JSON.stringify(msg.stats);
      const prevKey = tvStatsKey;
      tvStatsKey = key;
      const lastActivity = prevKey !== null && prevKey !== key ? stampActivity(get().lastActivity, 'tv') : get().lastActivity;
      set({ stats: msg.stats, lastActivity });
      return;
    }
    if (msg.type === 'monitor') {
      const monitors = { ...get().monitors };
      const prev: MonitorContent = msg.clear
        ? { title: '', lines: [] }
        : (monitors[msg.target] ?? { title: '', lines: [] });
      let image = prev.image;
      let lines = prev.lines;
      let appended: string[] = [];
      if (msg.append) {
        appended = msg.append.split('\n').filter((l) => {
          // require a real image payload: session text ABOUT the marker (e.g. this
          // very feature being discussed on a monitor) must not hijack the screen
          if (!l.startsWith(MONITOR_IMAGE_MARKER + 'data:image/') && !l.startsWith(MONITOR_IMAGE_MARKER + 'http')) return true;
          image = l.slice(MONITOR_IMAGE_MARKER.length);
          return false;
        });
        lines = [...prev.lines, ...appended].slice(-MONITOR_MAX_LINES);
      }
      monitors[msg.target] = { title: msg.title ?? prev.title, lines, image };
      const monitorHistory = { ...get().monitorHistory };
      monitorHistory[msg.target] = appendHistory(
        monitorHistory[msg.target] ?? [],
        appended,
        !!msg.clear,
        msg.title,
      );
      const monitorVersion = { ...get().monitorVersion };
      monitorVersion[msg.target] = (monitorVersion[msg.target] ?? 0) + 1;
      const lastActivity = msg.append
        ? stampActivity(get().lastActivity, msg.target)
        : get().lastActivity;
      set({ monitors, monitorVersion, monitorHistory, lastActivity });
    }
  },

  setConnected: (connected) => set({ connected }),
  // any mode change lands on the live tail: entering focus starts unscrolled,
  // and exiting mid-history must not leave a stale offset for the next visit
  setCameraMode: (cameraMode) =>
    // a pending relock only makes sense heading back into the fly cam;
    // build mode only exists in the free camera — any other mode ends it
    set({
      cameraMode,
      focusScroll: 0,
      ...(cameraMode.kind !== 'free' ? { pendingRelock: false, buildMode: false, buildHold: null } : {}),
    }),
  setFocusScroll: (focusScroll) => set({ focusScroll }),
  setPendingRelock: (pendingRelock) => set({ pendingRelock }),
  // called per-frame from the fly-cam crosshair raycast — skip no-op updates
  setMonitorHover: (monitorHover) =>
    get().monitorHover === monitorHover ? undefined : set({ monitorHover }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCatalog: (catalog) => set({ catalog }),
  patchCharacter: (id, patch) =>
    set((s) =>
      s.catalog
        ? {
            catalog: {
              ...s.catalog,
              characters: s.catalog.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)),
            },
          }
        : {},
    ),
  setBuildMode: (buildMode) => set({ buildMode, buildHold: null }),
  setBuildHold: (buildHold) => set({ buildHold }),
  patchLayout: (patch) =>
    set((s) => {
      if (!s.office) return {};
      const cur = s.office.layout;
      const layout: OfficeLayout = {
        ...cur,
        ...(patch.seats ? { seats: { ...cur?.seats, ...patch.seats } } : {}),
        ...(patch.furniture ? { furniture: { ...cur?.furniture, ...patch.furniture } } : {}),
        ...(patch.wallItems ? { wallItems: { ...cur?.wallItems, ...patch.wallItems } } : {}),
      };
      return { office: { ...s.office, layout } };
    }),
}));

/** test-only: forget the cached whiteboard key so the next state msg counts as "first" */
export function resetWhiteboardKeyForTest() {
  whiteboardKey = null;
}

/** test-only: forget the cached inbox tail id so the next state msg counts as "first" */
export function resetInboxKeyForTest() {
  inboxKey = null;
}

/** test-only: forget the cached status tail id so the next state msg counts as "first" */
export function resetStatusKeyForTest() {
  statusKey = null;
}

/** test-only: forget the cached stats key so the next stats msg counts as "first" */
export function resetTvStatsKeyForTest() {
  tvStatsKey = null;
}
