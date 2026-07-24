import { create } from 'zustand';
import { sanitizeCharacterId } from '../../../shared/characterId.ts';
import type { ParsedFbx } from './convert.ts';

/** FBXLoader + GLTFExporter are heavy; load them only when an import starts. */
const converter = () => import('./convert.ts');

export type AnimSlot = 'sit' | 'idle';

export type ImportStage =
  | 'queued'
  | 'parsing'
  | 'needs-slot' // animation FBX whose slot couldn't be inferred from the filename
  | 'installing-anim'
  | 'converting'
  | 'uploading'
  | 'conflict' // id collides with a builtin character; user picks a new name
  | 'done'
  | 'error';

export interface ImportItem {
  key: string;
  fileName: string;
  id: string;
  displayName: string;
  kind?: 'character' | 'animation';
  slot?: AnimSlot;
  stage: ImportStage;
  detail?: string;
  warnings: string[];
}

interface ImportStore {
  items: ImportItem[];
  animStatus: Record<AnimSlot, boolean> | null;
  refreshAnimStatus: () => Promise<void>;
  addFiles: (files: File[]) => void;
  assignSlot: (key: string, slot: AnimSlot) => void;
  renameAndRetry: (key: string, newName: string) => void;
  clearFinished: () => void;
}

/** Heavy parse results stay out of zustand state (non-reactive). */
const parsedCache = new Map<string, { parsed: ParsedFbx; buffer: ArrayBuffer }>();
let seq = 0;
let queue: Promise<void> = Promise.resolve();

const ANIMS_MISSING_MSG =
  'Install the animations first: on Mixamo, download "Sitting Idle" and "Idle" (Format: FBX, Skin: Without Skin) and drop both files here. Then drop this character again.';

function patch(key: string, changes: Partial<ImportItem>) {
  useImportStore.setState((s) => ({
    items: s.items.map((it) => (it.key === key ? { ...it, ...changes } : it)),
  }));
}

function inferSlot(fileName: string): AnimSlot | undefined {
  if (/sit/i.test(fileName)) return 'sit';
  if (/idle/i.test(fileName)) return 'idle';
  return undefined;
}

async function fetchServerAnim(slot: AnimSlot): Promise<ParsedFbx> {
  const res = await fetch(`/api/anims/${slot}`);
  if (!res.ok) throw new Error(ANIMS_MISSING_MSG);
  return (await converter()).parseFbx(await res.arrayBuffer());
}

async function uploadAnim(key: string, slot: AnimSlot, buffer: ArrayBuffer) {
  patch(key, { stage: 'installing-anim', slot });
  const res = await fetch(`/api/anims/${slot}`, { method: 'POST', body: buffer });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `upload failed (${res.status})`);
  await useImportStore.getState().refreshAnimStatus();
  patch(key, {
    stage: 'done',
    detail: slot === 'sit' ? 'Sitting animation installed' : 'Idle animation installed',
  });
  parsedCache.delete(key);
}

async function importCharacter(key: string, id: string, displayName: string, parsed: ParsedFbx) {
  const status = useImportStore.getState().animStatus;
  if (!status?.sit || !status?.idle) {
    // re-check the server in case another tab installed them
    await useImportStore.getState().refreshAnimStatus();
    const fresh = useImportStore.getState().animStatus;
    if (!fresh?.sit || !fresh?.idle) throw new Error(ANIMS_MISSING_MSG);
  }

  patch(key, { stage: 'converting' });
  const [sit, idle] = await Promise.all([fetchServerAnim('sit'), fetchServerAnim('idle')]);
  const { glb, warnings } = await (await converter()).convertCharacter(parsed, sit, idle, id);

  patch(key, { stage: 'uploading', warnings });
  const res = await fetch(`/api/characters/${id}?displayName=${encodeURIComponent(displayName)}`, {
    method: 'POST',
    body: glb,
  });
  if (res.status === 409) {
    patch(key, { stage: 'conflict', detail: `"${id}" is a built-in character — give it a new name:` });
    return; // parsed stays cached for renameAndRetry
  }
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `upload failed (${res.status})`);
  patch(key, { stage: 'done', detail: 'Added to the office' });
  parsedCache.delete(key);
}

async function processFile(key: string, file: File) {
  try {
    patch(key, { stage: 'parsing' });
    if (!/\.fbx$/i.test(file.name)) {
      throw new Error('Not an FBX file — download characters and animations from Mixamo as FBX.');
    }
    const buffer = await file.arrayBuffer();
    const parsed = await (await converter()).parseFbx(buffer);
    parsedCache.set(key, { parsed, buffer });

    if (parsed.kind === 'animation') {
      const slot = inferSlot(file.name);
      if (!slot) {
        patch(key, { stage: 'needs-slot', kind: 'animation', detail: 'Which animation is this?' });
        return;
      }
      await uploadAnim(key, slot, buffer);
      return;
    }

    const item = useImportStore.getState().items.find((i) => i.key === key);
    patch(key, { kind: 'character' });
    await importCharacter(key, item!.id, item!.displayName, parsed);
  } catch (e) {
    patch(key, { stage: 'error', detail: e instanceof Error ? e.message : String(e) });
    parsedCache.delete(key);
  }
}

export const useImportStore = create<ImportStore>((set, get) => ({
  items: [],
  animStatus: null,

  refreshAnimStatus: async () => {
    try {
      const res = await fetch('/api/anims');
      if (res.ok) set({ animStatus: await res.json() });
    } catch {
      /* server offline; character imports will surface the error */
    }
  },

  addFiles: (files) => {
    for (const file of files) {
      const id = sanitizeCharacterId(file.name) ?? `character_${++seq}`;
      const key = `import-${++seq}-${Date.now()}`;
      const displayName = file.name.replace(/\.(fbx|glb)$/i, '').replace(/[_-]+/g, ' ').trim() || id;
      set((s) => ({
        items: [...s.items, { key, fileName: file.name, id, displayName, stage: 'queued', warnings: [] }],
      }));
      // sequential queue: conversions are heavy, and anim installs must land
      // before a character in the same drop batch starts converting
      queue = queue.then(() => processFile(key, file));
    }
  },

  assignSlot: (key, slot) => {
    const cached = parsedCache.get(key);
    if (!cached) {
      patch(key, { stage: 'error', detail: 'File no longer in memory — drop it again.' });
      return;
    }
    queue = queue.then(() => uploadAnim(key, slot, cached.buffer).catch((e) => patch(key, { stage: 'error', detail: String(e?.message ?? e) })));
  },

  renameAndRetry: (key, newName) => {
    const cached = parsedCache.get(key);
    const id = sanitizeCharacterId(newName);
    if (!id) {
      patch(key, { detail: 'Name must contain letters or numbers — try again:' });
      return;
    }
    if (!cached) {
      patch(key, { stage: 'error', detail: 'File no longer in memory — drop it again.' });
      return;
    }
    patch(key, { id, displayName: newName.trim() });
    queue = queue.then(() =>
      importCharacter(key, id, newName.trim(), cached.parsed).catch((e) =>
        patch(key, { stage: 'error', detail: String(e?.message ?? e) }),
      ),
    );
  },

  clearFinished: () =>
    set((s) => ({ items: s.items.filter((it) => it.stage !== 'done' && it.stage !== 'error') })),
}));
