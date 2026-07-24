import { create } from 'zustand';

/** dataURL thumbnails per variant id, filled progressively by the snapshot queue */
interface ThumbStore {
  thumbs: Record<string, string>;
  setThumb: (id: string, dataUrl: string) => void;
}

export const useThumbStore = create<ThumbStore>((set) => ({
  thumbs: {},
  setThumb: (id, dataUrl) => set((s) => ({ thumbs: { ...s.thumbs, [id]: dataUrl } })),
}));

const HUES = [18, 42, 96, 152, 200, 258, 312];

export function initialsFor(displayName: string) {
  const words = displayName.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

export function hueFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
