import { create } from 'zustand';
import { MONITOR_IMAGE_MARKER, type CharacterCatalog, type OfficeState, type ServerMsg } from '../../shared/types.ts';
import { boardContent } from './scene/whiteboardContent.ts';
import { ACTIVE_WINDOW_MS } from './scene/movieShots.ts';
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
  | { kind: 'focus'; target: string; from: CameraMode; returnPose?: CameraPose };

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

/** The focus mode a monitor click produces: switching monitors keeps the original exit state. */
export function enterFocusMode(cur: CameraMode, target: string, pose: CameraPose): CameraMode {
  if (cur.kind === 'focus') return { kind: 'focus', target, from: cur.from, returnPose: cur.returnPose };
  return { kind: 'focus', target, from: cur, returnPose: cur.kind === 'free' ? pose : undefined };
}

interface AppStore {
  office: OfficeState | null;
  monitors: Record<string, MonitorContent>;
  /** bumps every time a monitor changes so screens know to redraw */
  monitorVersion: Record<string, number>;
  /** scrollback per monitor: raw lines that survive the per-tool clears, with divider lines at each clear */
  monitorHistory: Record<string, string[]>;
  /** focus-mode scroll position in wrapped rows from the bottom; 0 = live tail */
  focusScroll: number;
  /** monitor under the cursor (or under the fly-cam crosshair): 'boss' | employee id | null */
  monitorHover: string | null;
  /** subject key ('boss' | employee id | 'whiteboard') → epoch ms of last content change */
  lastActivity: Record<string, number>;
  connected: boolean;
  cameraMode: CameraMode;
  settingsOpen: boolean;
  catalog: CharacterCatalog | null;
  applyServerMsg: (msg: ServerMsg) => void;
  setConnected: (v: boolean) => void;
  setCameraMode: (m: CameraMode) => void;
  setFocusScroll: (n: number) => void;
  setMonitorHover: (target: string | null) => void;
  setSettingsOpen: (v: boolean) => void;
  setCatalog: (c: CharacterCatalog) => void;
  /** optimistic local patch while the scale slider drags; server broadcast confirms it */
  setCharacterScale: (id: string, scale: number) => void;
}

let whiteboardKey: string | null = null;

/** stamp `key` as active now, dropping entries that have already fallen outside the movie camera's window */
function stampActivity(lastActivity: Record<string, number>, key: string): Record<string, number> {
  const now = Date.now();
  const next: Record<string, number> = { [key]: now };
  for (const k in lastActivity) {
    if (k !== key && now - lastActivity[k] < ACTIVE_WINDOW_MS) next[k] = lastActivity[k];
  }
  return next;
}

export const useStore = create<AppStore>((set, get) => ({
  office: null,
  monitors: {},
  monitorVersion: {},
  monitorHistory: {},
  focusScroll: 0,
  monitorHover: null,
  lastActivity: {},
  connected: false,
  cameraMode: { kind: 'free' },
  settingsOpen: false,
  catalog: null,

  applyServerMsg: (msg) => {
    if (msg.type === 'state') {
      const key = JSON.stringify(boardContent(msg.state));
      const prevKey = whiteboardKey;
      whiteboardKey = key;
      if (prevKey !== null && prevKey !== key) {
        set({ office: msg.state, lastActivity: stampActivity(get().lastActivity, 'whiteboard') });
      } else {
        set({ office: msg.state });
      }
      return;
    }
    if (msg.type === 'catalog') {
      set({ catalog: msg.catalog });
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
          if (!l.startsWith(MONITOR_IMAGE_MARKER + 'data:image/')) return true;
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
  setCameraMode: (cameraMode) => set({ cameraMode, focusScroll: 0 }),
  setFocusScroll: (focusScroll) => set({ focusScroll }),
  // called per-frame from the fly-cam crosshair raycast — skip no-op updates
  setMonitorHover: (monitorHover) =>
    get().monitorHover === monitorHover ? undefined : set({ monitorHover }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setCatalog: (catalog) => set({ catalog }),
  setCharacterScale: (id, scale) =>
    set((s) =>
      s.catalog
        ? {
            catalog: {
              ...s.catalog,
              characters: s.catalog.characters.map((c) => (c.id === id ? { ...c, scale } : c)),
            },
          }
        : {},
    ),
}));

/** test-only: forget the cached whiteboard key so the next state msg counts as "first" */
export function resetWhiteboardKeyForTest() {
  whiteboardKey = null;
}
