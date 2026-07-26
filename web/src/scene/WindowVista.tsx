import { useMemo } from 'react';
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

  /**
   * Grow each plane downward by `extend` without moving or stretching the
   * artwork.
   *
   * The plane becomes `h + extend` tall with its TOP edge unchanged, and V is
   * rescaled so the image still occupies exactly `h` at the top: with
   * `repeat.y = k` and `offset.y = 1 - k` (k = (h + extend) / h), the plane's
   * top samples v = 1 and the artwork's original bottom lands at v = 0. Below
   * that v goes negative, and ClampToEdgeWrapping pins it to the image's bottom
   * pixel row — so each building's window columns continue straight down and the
   * transparent gaps between buildings stay transparent, instead of the whole
   * skyline ending on a hard horizontal line.
   *
   * Each URL appears exactly once across both vistas, so mutating the cached
   * texture here can't bleed into another layer.
   */
  useMemo(() => {
    layers.forEach((l, i) => {
      const tex = layerTex[i];
      if (!tex) return;
      const k = (l.h + (l.extend ?? 0)) / l.h;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.y = k;
      tex.offset.y = 1 - k;
      tex.needsUpdate = true;
    });
  }, [layers, layerTex]);

  return (
    <group>
      {layers.map((l, i) => {
        const ext = l.extend ?? 0;
        return (
          <mesh key={l.url} position={[l.x, l.y - ext / 2, l.z]}>
            <planeGeometry args={[l.w, l.h + ext]} />
            <meshBasicMaterial map={layerTex[i]} alphaTest={0.5} fog={false} />
          </mesh>
        );
      })}
    </group>
  );
}
