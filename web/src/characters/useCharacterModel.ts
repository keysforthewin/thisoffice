import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import type { CharacterEntry } from '../../../shared/types.ts';
import { ANIM_LIB_URLS, characterUrl } from './catalog.ts';

/**
 * Loads a character GLB and returns an independent clone plus its animation clips.
 * Characters with rig 'shared' carry only basic movement clips; the missing clips
 * are merged in from the shared KayKit animation library (embedded clips win).
 * KayKit rigs share bone names, so library clips bind by name without retargeting.
 */
export function useCharacterModel(variant: string, entry?: CharacterEntry) {
  const url = characterUrl(variant, entry);
  const { scene, animations } = useGLTF(url);
  const needsLib = entry?.rig === 'shared';
  // Hook count must stay stable: when no library is needed, re-request the
  // character's own URL (drei caches, so this is free).
  const libs = useGLTF(needsLib ? ANIM_LIB_URLS : ANIM_LIB_URLS.map(() => url));

  const clips = useMemo(() => {
    if (!needsLib) return animations;
    const seen = new Set(animations.map((c) => c.name));
    const extra = [];
    for (const lib of libs) {
      for (const clip of lib.animations) {
        if (seen.has(clip.name)) continue;
        seen.add(clip.name);
        extra.push(normalizeTracks(clip, scene));
      }
    }
    return [...animations, ...extra];
  }, [animations, libs, needsLib, scene]);

  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  return { clone, clips };
}

/**
 * Library clip tracks sometimes carry the library rig's root prefix; strip any
 * node path segment that doesn't exist in the target scene so bindings resolve.
 */
function normalizeTracks(clip: THREE.AnimationClip, target: THREE.Object3D): THREE.AnimationClip {
  const needsFix = clip.tracks.some((t) => {
    const node = t.name.split('.')[0];
    return !target.getObjectByName(node);
  });
  if (!needsFix) return clip;
  const fixed = clip.clone();
  fixed.tracks = fixed.tracks.map((t) => {
    const [node, ...rest] = t.name.split('.');
    if (!target.getObjectByName(node)) {
      // KayKit prefixes look like "Rig_Medium|Bone" or "armature_Bone"; try the last segment
      const candidate = node.split(/[|/]/).pop() ?? node;
      if (target.getObjectByName(candidate)) {
        const renamed = t.clone();
        renamed.name = [candidate, ...rest].join('.');
        return renamed;
      }
    }
    return t;
  });
  return fixed;
}

export function preloadCharacter(variant: string, entry?: CharacterEntry) {
  useGLTF.preload(characterUrl(variant, entry));
}
