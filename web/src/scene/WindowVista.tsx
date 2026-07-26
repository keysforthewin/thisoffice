import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import { VISTA_LAYERS } from './vistaLayers.ts';
import { vistaGeometry, type SkirtData } from './vistaGeometry.ts';

/** `/vista/back-mid.png` → `/vista/back-mid.skirt.json` (baked by `npm run vista`). */
const skirtUrl = (imageUrl: string) => imageUrl.replace(/\.png$/, '.skirt.json');

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
  // suspends alongside the textures, so a layer never renders with a stale or
  // missing skirt — a bad JSON degrades to the old full-width skirt, not a crash
  const skirtJson = useLoader(THREE.FileLoader, layers.map((l) => skirtUrl(l.url))) as unknown as string[];
  const skirts = useMemo(
    () =>
      skirtJson.map((raw, i) => {
        try {
          return JSON.parse(raw) as SkirtData;
        } catch {
          console.warn(`vista: unreadable skirt data for ${layers[i].url} — run \`npm run vista\``);
          return undefined;
        }
      }),
    [skirtJson, layers],
  );

  /**
   * Grow each plane downward by `extend` without moving or stretching the
   * artwork: the artwork quad sits exactly where `w`/`h`/`x`/`y` put it, and
   * below it hangs one skirt quad per run of columns, each repeating its own
   * building's lowest pixels down to a common floor. See vistaGeometry.ts for
   * why the skirt has to be per-column and not one held row.
   */
  const geos = useMemo(
    () => layers.map((l, i) => vistaGeometry(l.w, l.h, l.extend ?? 0, skirts[i])),
    [layers, skirts],
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
