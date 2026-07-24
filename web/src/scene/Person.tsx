import { useEffect, useMemo, useRef } from 'react';
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
      }
    });
  }, [clone]);

  const sit = useMemo(() => resolveClip(actions, 'Sit_Chair_Idle', catalog?.clipAliases), [actions, catalog]);

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
