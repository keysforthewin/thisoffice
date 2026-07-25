import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';

/** Static equirect city panorama as the scene background — zero per-frame cost. */
export function Skybox() {
  const scene = useThree((s) => s.scene);
  const tex = useTexture('/skybox/city.jpg');
  useEffect(() => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const prev = scene.background;
    scene.background = tex;
    return () => {
      scene.background = prev;
    };
  }, [scene, tex]);
  return null;
}
