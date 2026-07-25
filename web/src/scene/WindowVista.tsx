import * as THREE from 'three';
import { useTexture } from '@react-three/drei';

/** All positions are in the window opening's local frame: opening center at
 *  the origin, outside = -z. Tuned by eye; adjust freely.
 *
 *  Constraint (do not regress): the back window's layers are shifted +x so no
 *  layer crosses the left wall plane — world x = -7.6, which is local x ≈ -3.8
 *  for that opening — otherwise they'd be visible edge-on through the left
 *  window. Every back layer keeps its left edge at local x ≥ -3.6. Future
 *  movable-windows work must preserve this. The seamless sky behind the layers
 *  is scene-global (DuskSky) and needs no such care. */
interface LayerCfg { url: string; z: number; w: number; h: number; x: number; y: number }

const CFG: Record<'back' | 'left', LayerCfg[]> = {
  back: [
    { url: '/vista/back-skyline.png', z: -18, w: 24, h: 9, x: 8.4, y: -1.2 },
    { url: '/vista/back-mid.png', z: -11, w: 16, h: 9, x: 4.4, y: -2.8 },
    { url: '/vista/back-near.png', z: -4.5, w: 10, h: 6, x: 1.4, y: -2.2 },
  ],
  left: [
    { url: '/vista/left-skyline.png', z: -18, w: 24, h: 9, x: 0, y: -1.2 },
    { url: '/vista/left-mid.png', z: -11, w: 16, h: 9, x: 0, y: -2.8 },
    { url: '/vista/left-near.png', z: -4.5, w: 10, h: 6, x: 0, y: -2.2 },
  ],
};

const srgb = (t: THREE.Texture | THREE.Texture[]) => {
  for (const tex of Array.isArray(t) ? t : [t]) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }
};

/** Alpha-cutout city layers at staggered depths behind a window opening —
 *  perspective gives real parallax against the seamless sky (DuskSky) behind
 *  them. Unlit and fog-free on purpose: the exterior must not pick up office
 *  lights, shadows, or interior fog. */
export function WindowVista({ id }: { id: 'back' | 'left' }) {
  const layers = CFG[id];
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
