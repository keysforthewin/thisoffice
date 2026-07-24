import { create } from 'zustand';
import type { CharacterCatalog, OfficeState, ServerMsg } from '../../shared/types.ts';

export interface MonitorContent {
  title: string;
  lines: string[];
}

const MONITOR_MAX_LINES = 200;

export type CameraMode = { kind: 'free' } | { kind: 'pov'; index: number };

interface AppStore {
  office: OfficeState | null;
  monitors: Record<string, MonitorContent>;
  /** bumps every time a monitor changes so screens know to redraw */
  monitorVersion: Record<string, number>;
  connected: boolean;
  cameraMode: CameraMode;
  settingsOpen: boolean;
  catalog: CharacterCatalog | null;
  applyServerMsg: (msg: ServerMsg) => void;
  setConnected: (v: boolean) => void;
  setCameraMode: (m: CameraMode) => void;
  setSettingsOpen: (v: boolean) => void;
  setCatalog: (c: CharacterCatalog) => void;
  /** optimistic local patch while the scale slider drags; server broadcast confirms it */
  setCharacterScale: (id: string, scale: number) => void;
}

export const useStore = create<AppStore>((set, get) => ({
  office: null,
  monitors: {},
  monitorVersion: {},
  connected: false,
  cameraMode: { kind: 'free' },
  settingsOpen: false,
  catalog: null,

  applyServerMsg: (msg) => {
    if (msg.type === 'state') {
      set({ office: msg.state });
      return;
    }
    if (msg.type === 'catalog') {
      set({ catalog: msg.catalog });
      return;
    }
    if (msg.type === 'monitor') {
      const monitors = { ...get().monitors };
      const prev = msg.clear ? { title: '', lines: [] } : (monitors[msg.target] ?? { title: '', lines: [] });
      const lines = msg.append
        ? [...prev.lines, ...msg.append.split('\n')].slice(-MONITOR_MAX_LINES)
        : prev.lines;
      monitors[msg.target] = { title: msg.title ?? prev.title, lines };
      const monitorVersion = { ...get().monitorVersion };
      monitorVersion[msg.target] = (monitorVersion[msg.target] ?? 0) + 1;
      set({ monitors, monitorVersion });
    }
  },

  setConnected: (connected) => set({ connected }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
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
