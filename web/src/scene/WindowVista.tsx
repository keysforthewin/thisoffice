import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { VISTA_LAYERS } from './vistaLayers.ts';

const srgb = (t: THREE.Texture | THREE.Texture[]) => {
  for (const tex of Array.isArray(t) ? t : [t]) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }
};

/** Alpha-cutout city layers at staggered depths behind a window opening —
 *  perspective gives real parallax against the seamless sky (DuskSky) behind
 *  them. Placement lives in vistaLayers.ts. Unlit and fog-free on purpose:
 *  the exterior must not pick up office lights, shadows, or interior fog. */
export function WindowVista({ id }: { id: 'back' | 'left' }) {
  const layers = VISTA_LAYERS[id];
  const layerTex = useTexture(layers.map((l) => l.url), srgb);
  return (
    <group>
      {layers.map((l, i) => (
        <mesh key={l.url} position={[l.x, l.y, l.z]}>
          <planeGeometry args={[l.w, l.h]} />
          <meshBasicMaterial map={layerTex[i]} alphaTest={0.5} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
