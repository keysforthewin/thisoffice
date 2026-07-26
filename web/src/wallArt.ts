import { WALL_ART_EXTS, type WallArtExt } from '../../shared/types.ts';
import { useStore } from './store.ts';

const MIME_EXT: Record<string, WallArtExt> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

function extFor(file: File): WallArtExt | null {
  const byMime = MIME_EXT[file.type.toLowerCase()];
  if (byMime) return byMime;
  // some browsers report an empty type for files dragged in from odd sources
  const suffix = file.name.split('.').pop()?.toLowerCase();
  if (suffix === 'jpeg') return 'jpg';
  return (WALL_ART_EXTS as readonly string[]).includes(suffix ?? '') ? (suffix as WallArtExt) : null;
}

/**
 * Open a file picker and upload the chosen image as the painting behind the
 * boss. The server broadcasts the new `wallArt` config, so there is nothing to
 * apply locally — the scene picks it up from the state message.
 *
 * Raw-body POST, matching the character-upload route: no multipart parser
 * exists server-side (or is wanted).
 */
export function pickWallArtImage(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const ext = extFor(file);
    if (!ext) {
      alert('Pick a PNG, JPEG or WebP image.');
      return;
    }
    const res = await fetch(`/api/decor/wallart?ext=${ext}`, { method: 'POST', body: file });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Could not hang that picture: ${body.error ?? res.statusText}`);
    }
  };
  input.click();
}

/** Trailing-debounce window for framing PUTs while the wheel is still spinning. */
const FRAMING_SAVE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Reframe the painting: applied locally at once (the gesture has to feel
 * immediate) and persisted on a trailing debounce, so one gesture is one write
 * no matter how many mousemove events it spans.
 */
export function reframeWallArt(patch: { zoom?: number; panX?: number; panY?: number }): void {
  const st = useStore.getState();
  if (!st.office?.wallArt) return;
  st.patchWallArt(patch);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const art = useStore.getState().office?.wallArt;
    if (!art) return;
    fetch('/api/decor/wallart', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoom: art.zoom, panX: art.panX, panY: art.panY }),
    }).catch(() => {});
  }, FRAMING_SAVE_MS);
}
