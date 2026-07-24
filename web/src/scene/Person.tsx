import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useGLTF, useAnimations } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';

interface Props {
  variant: string;
  working: boolean;
  position?: [number, number, number];
  rotationY?: number;
}

export function Person({ variant, working, position = [0, 0, 0], rotationY = 0 }: Props) {
  const url = `/models/characters/${variant}.glb`;
  const { scene, animations } = useGLTF(url);
  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.frustumCulled = false; // skinned mesh bounds don't follow the sit pose
      }
    });
  }, [clone]);

  useEffect(() => {
    const sit = actions['Sit_Chair_Idle'];
    if (!sit) return;
    sit.reset().play();
    sit.time = Math.random() * (sit.getClip().duration || 1); // desync from neighbors
    return () => {
      sit.stop();
    };
  }, [actions]);

  useEffect(() => {
    const sit = actions['Sit_Chair_Idle'];
    if (sit) sit.timeScale = working ? 2.2 : 0.6;
  }, [actions, working]);

  return (
    <group ref={group} position={position} rotation={[0, rotationY, 0]}>
      <primitive object={clone} />
    </group>
  );
}

export function preloadVariant(variant: string) {
  useGLTF.preload(`/models/characters/${variant}.glb`);
}
