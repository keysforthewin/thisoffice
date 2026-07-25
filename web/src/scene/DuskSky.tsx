import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';

/** Yaw for the panorama so its sun faces the back window (-z heading),
 *  justifying the warm spill light there; the wrap seam lands behind the
 *  front/right walls where no window ever looks. texture.offset is ignored
 *  for scene backgrounds, so this must go through scene.backgroundRotation. */
const SKY_YAW = Math.PI / 2;

/** Seamless equirect dusk panorama as the scene background — zero per-frame
 *  cost, covers zenith to nadir so windows never show a seam or a void. Crisp
 *  building detail comes from the WindowVista parallax layers, not the sky. */
export function DuskSky() {
  const scene = useThree((s) => s.scene);
  const tex = useTexture('/vista/sky.jpg');
  useEffect(() => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const prev = scene.background;
    const prevRot = scene.backgroundRotation.clone();
    scene.background = tex;
    scene.backgroundRotation.set(0, SKY_YAW, 0);
    return () => {
      scene.background = prev;
      scene.backgroundRotation.copy(prevRot);
    };
  }, [scene, tex]);
  return null;
}
