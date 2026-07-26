import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { VISTA_LAYERS } from './vistaLayers.ts';
import { vistaGeometry } from './vistaGeometry.ts';

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
   * The mesh is two quads (see vistaGeometry.ts): the upper one holds the
   * artwork exactly where `w`/`h`/`x`/`y` place it, and the lower one repeats
   * the UV row of the artwork's lowest *opaque* pixel (`trimBottom`) straight
   * down — so each building's window columns continue and the transparent gaps
   * between buildings stay transparent, instead of the whole skyline ending on
   * a hard horizontal line.
   *
   * This used to be done with `repeat.y`/`offset.y` and ClampToEdgeWrapping
   * pinning v < 0 to the image's bottom pixel row. That silently did nothing
   * for the `mid` layers, whose images carry ~15% transparent padding below the
   * artwork: the clamp faithfully repeated the padding. Encoding the trim in the
   * geometry's UVs makes the clamp line the artwork's edge instead of the
   * image's.
   */
  const geos = useMemo(
    () => layers.map((l) => vistaGeometry(l.w, l.h, l.extend ?? 0, l.trimBottom ?? 0)),
    [layers],
  );
  useEffect(() => () => geos.forEach((g) => g.dispose()), [geos]);

  useMemo(() => {
    for (const tex of layerTex) {
      if (!tex) continue;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(1, 1);
      tex.offset.set(0, 0);
      tex.needsUpdate = true;
    }
  }, [layerTex]);

  return (
    <group>
      {layers.map((l, i) => (
        <mesh key={l.url} position={[l.x, l.y, l.z]} geometry={geos[i]}>
          <meshBasicMaterial map={layerTex[i]} alphaTest={0.5} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
