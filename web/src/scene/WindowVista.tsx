import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { vistaBoxFaces, type FaceKind } from './vistaGeometry.ts';

/** All positions are in the window opening's local frame: opening center at the
 *  origin, outside = -z. Tuned by eye; adjust freely. `cy` drops the whole box
 *  so the city extends below the sill (we're high in an office tower). */
interface LayerCfg { url: string; z: number; w: number; h: number; y: number }
interface VistaCfg {
  box: { w: number; h: number; d: number; cy: number };
  faceColors: Record<Exclude<FaceKind, 'back'>, string>;
  far: string;
  layers: LayerCfg[];
}

const CFG: Record<'back' | 'left', VistaCfg> = {
  back: {
    box: { w: 14, h: 10, d: 24, cy: -1.5 },
    faceColors: { top: '#3d3050', bottom: '#241b22', left: '#9c7258', right: '#9c7258' },
    far: '/vista/back-far.jpg',
    layers: [
      { url: '/vista/back-mid.png', z: -11, w: 10, h: 6, y: -1.4 },
      { url: '/vista/back-near.png', z: -4.5, w: 7, h: 4.2, y: -1.6 },
    ],
  },
  left: {
    box: { w: 14, h: 10, d: 24, cy: -1.5 },
    faceColors: { top: '#3d3050', bottom: '#241b22', left: '#7d6270', right: '#b57e56' },
    far: '/vista/left-far.jpg',
    layers: [
      { url: '/vista/left-mid.png', z: -11, w: 10, h: 6, y: -1.4 },
      { url: '/vista/left-near.png', z: -4.5, w: 7, h: 4.2, y: -1.6 },
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
  return (
    <group position={[0, cfg.box.cy, 0]}>
      {vistaBoxFaces(cfg.box.w, cfg.box.h, cfg.box.d).map((f) => (
        <mesh key={f.kind} position={f.position} rotation={f.rotation}>
          <planeGeometry args={f.size} />
          {f.kind === 'back' ? (
            <meshBasicMaterial map={far} fog={false} />
          ) : (
            <meshBasicMaterial color={cfg.faceColors[f.kind]} fog={false} />
          )}
        </mesh>
      ))}
      {cfg.layers.map((l, i) => (
        <mesh key={l.url} position={[0, l.y, l.z]}>
          <planeGeometry args={[l.w, l.h]} />
          <meshBasicMaterial map={layerTex[i]} alphaTest={0.5} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
