import type { CharacterCatalog, CharacterEntry } from '../../../shared/types.ts';
import { CHARACTER_VARIANTS } from '../../../shared/types.ts';
import type { AnimationAction } from 'three';

/** Shared KayKit animation library (Rig_Medium): Idle_A lives in General, Sit_Chair_Idle in Simulation */
export const ANIM_LIB_URLS = [
  '/models/characters/_lib/Rig_Medium_General.glb',
  '/models/characters/_lib/Rig_Medium_Simulation.glb',
];

export function characterUrl(variant: string, entry?: CharacterEntry) {
  return entry?.url ?? `/models/characters/${variant}.glb`;
}

/** Catalog synthesized from the hardcoded list, used when catalog.json is unavailable. */
function fallbackCatalog(): CharacterCatalog {
  return {
    version: 0,
    generatedAt: '',
    clipAliases: {},
    characters: CHARACTER_VARIANTS.map((id) => ({
      id,
      displayName: id.replace(/_/g, ' '),
      pack: id.startsWith('Skeleton_') ? 'Skeletons 1.0' : 'Adventurers 1.0',
      tags: [],
      rig: 'embedded',
    })),
  };
}

export async function loadCatalog(): Promise<CharacterCatalog> {
  // server catalog includes user-imported characters; static file works when the
  // server is down, hardcoded list when neither is available
  try {
    const res = await fetch('/api/catalog');
    if (res.ok) return (await res.json()) as CharacterCatalog;
  } catch {
    /* server offline */
  }
  try {
    const res = await fetch('/models/characters/catalog.json');
    if (!res.ok) throw new Error(`catalog.json: ${res.status}`);
    return (await res.json()) as CharacterCatalog;
  } catch (err) {
    console.warn('Falling back to built-in character list:', err);
    return fallbackCatalog();
  }
}

export function catalogEntry(catalog: CharacterCatalog | null, variant: string): CharacterEntry | undefined {
  return catalog?.characters.find((c) => c.id === variant);
}

/**
 * A character the user brought in themselves, from Mixamo or Blender — the ones
 * with a stored GLB the seat sliders can tune. The server tags every one of them.
 */
export function isImported(entry?: CharacterEntry): boolean {
  return !!entry?.tags.includes('imported');
}

/**
 * Find an action for a canonical clip name, trying catalog aliases first,
 * then the canonical name itself.
 */
export function resolveClip(
  actions: Record<string, AnimationAction | null>,
  canonical: string,
  aliases?: Record<string, string[]>,
): AnimationAction | null {
  for (const name of aliases?.[canonical] ?? []) {
    const action = actions[name];
    if (action) return action;
  }
  return actions[canonical] ?? null;
}
