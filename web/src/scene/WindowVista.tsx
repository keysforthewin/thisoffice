import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { vistaBoxFaces } from './vistaGeometry.ts';

/** All positions are in the window opening's local frame: opening center at the
 *  origin, outside = -z. Tuned by eye; adjust freely. `cy` drops the whole box
 *  so the city extends below the sill (we're high in an office tower). */
interface LayerCfg { url: string; z: number; w: number; h: number; x: number; y: number }
interface VistaCfg {
  box: { w: number; h: number; d: number; cx: number; cy: number };
  faceColors: { top: string; bottom: string };
  far: string;
  layers: LayerCfg[];
}

const CFG: Record<'back' | 'left', VistaCfg> = {
  // The back box and its layers are shifted +x (cx / layer x) so that no part of
  // this vista crosses the left wall plane — world x = -7.6, which is local
  // x ≈ -3.8 for this opening (opening centre is at world x = -3.8). The left
  // window's own box occupies everything outboard of that plane, so the two
  // boxes must never interpenetrate: if they did, each box's faces and layers
  // would be visible through the *other* window. Every back-vista element here
  // stays at local x ≥ -3.7 (world x ≥ -7.5). Future movable-window work must
  // preserve this invariant.
  back: {
    box: { w: 32, h: 20, d: 24, cx: 12.3, cy: 0 },
    faceColors: { top: '#8b87ba', bottom: '#16121a' },
    far: '/vista/back-far.jpg',
    layers: [
      { url: '/vista/back-mid.png', z: -11, w: 16, h: 9, x: 4.4, y: -2.8 },
      { url: '/vista/back-near.png', z: -4.5, w: 10, h: 6, x: 1.4, y: -2.2 },
    ],
  },
  left: {
    box: { w: 32, h: 20, d: 24, cx: 0, cy: 0 },
    faceColors: { top: '#8b87ba', bottom: '#16121a' },
    far: '/vista/left-far.jpg',
    layers: [
      { url: '/vista/left-mid.png', z: -11, w: 16, h: 9, x: 0, y: -2.8 },
      { url: '/vista/left-near.png', z: -4.5, w: 10, h: 6, x: 0, y: -2.2 },
    ],
  },
};

const srgb = (t: THREE.Texture | THREE.Texture[]) => {
  for (const tex of Array.isArray(t) ? t : [t]) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }
};

/** Layered-cityscape diorama box behind a window opening. Unlit and fog-free on
 *  purpose: the exterior must not pick up office lights, shadows, or interior fog. */
export function WindowVista({ id }: { id: 'back' | 'left' }) {
  const cfg = CFG[id];
  const far = useTexture(cfg.far, srgb);
  const layerTex = useTexture(cfg.layers.map((l) => l.url), srgb);
  // Side walls of the box reuse the far texture mirrored horizontally: at each
  // back corner the mirrored image meets the back face's matching edge, so
  // grazing views read as continuous hazy city instead of a flat painted wall.
  const farMirror = useMemo(() => {
    const t = far.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1;
    t.needsUpdate = true;
    return t;
  }, [far]);
  useEffect(() => () => farMirror.dispose(), [farMirror]);
  return (
    <group position={[0, cfg.box.cy, 0]}>
      {vistaBoxFaces(cfg.box.w, cfg.box.h, cfg.box.d, cfg.box.cx).map((f) => (
        <mesh key={f.kind} position={f.position} rotation={f.rotation}>
          <planeGeometry args={f.size} />
          {f.kind === 'back' ? (
            <meshBasicMaterial map={far} fog={false} />
          ) : f.kind === 'left' || f.kind === 'right' ? (
            <meshBasicMaterial map={farMirror} fog={false} />
          ) : (
            <meshBasicMaterial color={cfg.faceColors[f.kind]} fog={false} />
          )}
        </mesh>
      ))}
      {cfg.layers.map((l, i) => (
        <mesh key={l.url} position={[l.x, l.y, l.z]}>
          <planeGeometry args={[l.w, l.h]} />
          <meshBasicMaterial map={layerTex[i]} alphaTest={0.5} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
