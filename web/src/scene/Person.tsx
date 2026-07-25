import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useAnimations } from '@react-three/drei';
import { useStore } from '../store.ts';
import { catalogEntry, resolveClip } from '../characters/catalog.ts';
import { useCharacterModel, preloadCharacter } from '../characters/useCharacterModel.ts';

interface Props {
  variant: string;
  working: boolean;
  position?: [number, number, number];
  rotationY?: number;
}

export function Person({ variant, working, position = [0, 0, 0], rotationY = 0 }: Props) {
  const catalog = useStore((s) => s.catalog);
  const entry = catalogEntry(catalog, variant);
  const { clone, clips } = useCharacterModel(variant, entry);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(clips, group);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.frustumCulled = false; // skinned mesh bounds don't follow the sit pose

        // Write a stencil bit on every character material so NameTag's second
        // pass can punch through characters (but nothing else). clone(true)
        // shares materials across character clones, so this applies once per
        // material and affects all characters — that's the intent.
        const mat = (child as THREE.Mesh).material;
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const m of mats) {
          m.stencilWrite = true;
          m.stencilRef = 1;
          m.stencilFunc = THREE.AlwaysStencilFunc;
          m.stencilZPass = THREE.ReplaceStencilOp;
        }
      }
    });
  }, [clone]);

  // Resolve in an effect, not render: drei's `actions` getters return null until
  // the group ref mounts, and a render-time memo would cache that null forever.
  const [sit, setSit] = useState<THREE.AnimationAction | null>(null);
  useEffect(() => {
    setSit(resolveClip(actions, 'Sit_Chair_Idle', catalog?.clipAliases));
  }, [actions, catalog]);

  useEffect(() => {
    if (!sit) return;
    sit.reset().play();
    sit.time = Math.random() * (sit.getClip().duration || 1); // desync from neighbors
    return () => {
      sit.stop();
    };
  }, [sit]);

  useEffect(() => {
    if (sit) sit.timeScale = working ? 2.2 : 0.6;
  }, [sit, working]);

  return (
    <group ref={group} position={position} rotation={[0, rotationY, 0]}>
      <primitive object={clone} scale={entry?.scale ?? 1} />
    </group>
  );
}

export function preloadVariant(variant: string) {
  preloadCharacter(variant);
}
