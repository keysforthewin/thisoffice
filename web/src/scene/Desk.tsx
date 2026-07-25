import { useMemo } from 'react';
import * as THREE from 'three';
import type { ThreeElements } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { MonitorScreen } from './MonitorScreen.tsx';
import { Person } from './Person.tsx';
import { seatTransform } from './layout.ts';
import { useStore } from '../store.ts';

interface Props {
  seat: number;
  variant: string;
  working: boolean;
  monitorTarget: string; // 'boss' or employee id
  name?: string;
  fallbackTitle?: string;
  boss?: boolean;
}

export function FurnitureModel({ url, ...props }: { url: string } & ThreeElements['group']) {
  const { scene } = useGLTF(url);
  const clone = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return c;
  }, [scene]);
  return (
    <group {...props}>
      <primitive object={clone} />
    </group>
  );
}

/**
 * A workstation: table + chair + monitor + seated character.
 * Local space: desk faces +z (screen readable from -z, i.e. from behind the chair).
 */
export function Desk({ seat, variant, working, monitorTarget, name, fallbackTitle, boss }: Props) {
  const { position, rotationY } = seatTransform(seat);
  const deskScale = boss ? 1.15 : 1;
  // the focus camera parks where this character's head is — hide them while viewing
  const focusedHere = useStore(
    (s) => s.cameraMode.kind === 'focus' && s.cameraMode.target === monitorTarget,
  );

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <FurnitureModel
        url="/models/furniture/table_medium.gltf"
        scale={[deskScale, 1, 1]}
      />
      <FurnitureModel
        url={boss ? '/models/furniture/armchair_pillows.gltf' : '/models/furniture/chair_A.gltf'}
        position={[0, 0, -1.45]}
        rotation={[0, 0, 0]}
      />
      <group position={[0, 1.66, 0.35]}>
        <MonitorScreen target={monitorTarget} working={working} fallbackTitle={fallbackTitle} />
      </group>
      {/* key: remount on variant change — the mixer caches PropertyBindings by (root uuid,
          track name), so an in-place model swap leaves the new rig driven by bindings to the
          old clone's bones (T-pose). KayKit rigs share track names, so every swap collides. */}
      {/* visible-toggle (not unmount) so the mixer keeps its bindings — see key comment above */}
      <group visible={!focusedHere}>
        <Person
          key={variant}
          variant={variant}
          working={working}
          position={[0, 0.02, -1.15]}
          rotationY={0}
          name={name}
          accent={boss ? '#d2a8ff' : working ? '#7ee787' : '#8b949e'}
        />
      </group>
    </group>
  );
}

useGLTF.preload('/models/furniture/table_medium.gltf');
useGLTF.preload('/models/furniture/chair_A.gltf');
useGLTF.preload('/models/furniture/armchair_pillows.gltf');
