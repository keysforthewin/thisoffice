import { create } from 'zustand';
import type { OfficeState, ServerMsg } from '../../shared/types.ts';

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
  applyServerMsg: (msg: ServerMsg) => void;
  setConnected: (v: boolean) => void;
  setCameraMode: (m: CameraMode) => void;
  setSettingsOpen: (v: boolean) => void;
}

export const useStore = create<AppStore>((set, get) => ({
  office: null,
  monitors: {},
  monitorVersion: {},
  connected: false,
  cameraMode: { kind: 'free' },
  settingsOpen: false,

  applyServerMsg: (msg) => {
    if (msg.type === 'state') {
      set({ office: msg.state });
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
}));
