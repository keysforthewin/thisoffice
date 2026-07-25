import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeElements } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { MonitorScreen } from './MonitorScreen.tsx';
import { Person } from './Person.tsx';
import { deskFootprint, resolveSeat } from './buildLayout.ts';
import { BuildHandle, displayPose } from './build.tsx';
import { useStore } from '../store.ts';
import { catalogEntry } from '../characters/catalog.ts';

interface Props {
  seat: number;
  variant: string;
  working: boolean;
  monitorTarget: string; // 'boss' or employee id
  name?: string;
  fallbackTitle?: string;
  boss?: boolean;
  /** blinks the boss desk's red light: a session is waiting for user input */
  waiting?: boolean;
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

/** Seat geometry shared with the character picker preview (CharacterPreview.tsx) so a
 *  future desk-layout change can't silently desync the two. */
export const CHAIR_OFFSET_Z = -1.45;
export const PERSON_OFFSET_Z = -1.15;
export const PERSON_LIFT_Y = 0.02;

/** Leg positions/size measured from chair_A.gltf foot vertices (chunky corner
 *  posts 0.18 wide centered at ±0.23); the boss armchair gets a base plinth. */
const CHAIR_LEG_XZ = [
  [-0.23, -0.23],
  [0.23, -0.23],
  [-0.23, 0.23],
  [0.23, 0.23],
] as const;

/** Continuations of the chair legs that run down through the floor, so a chair
 *  raised via the picker's Chair-height slider still looks planted instead of
 *  floating. Slightly inset so they hide inside the real legs at rest; fully
 *  below the floor when the chair isn't raised. (The picker preview has no
 *  floor, so it intentionally omits these and shows the raw offset.) */
function ChairLegExtensions({ boss }: { boss?: boolean }) {
  return boss ? (
    <mesh position={[0, -0.31, 0.05]}>
      <boxGeometry args={[1.7, 0.6, 1.5]} />
      <meshStandardMaterial color="#a5664c" roughness={0.9} />
    </mesh>
  ) : (
    <>
      {CHAIR_LEG_XZ.map(([x, z]) => (
        <mesh key={`${x},${z}`} position={[x, -0.2, z]}>
          <boxGeometry args={[0.16, 0.6, 0.16]} />
          <meshStandardMaterial color="#d4885f" roughness={0.9} />
        </mesh>
      ))}
    </>
  );
}

/**
 * Small desk beacon: dark base + red bulb that blinks while a tailed session is
 * waiting for user input. Always part of the desk; dark when idle.
 */
function WaitingLight({ on }: { on: boolean }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const glow = useRef<THREE.PointLight>(null);
  useFrame(({ clock }) => {
    const lit = on && Math.sin(clock.elapsedTime * 5) > 0; // square-wave blink ~0.8 Hz
    if (mat.current) mat.current.emissiveIntensity = lit ? 4 : 0.15;
    if (glow.current) glow.current.intensity = lit ? 2.2 : 0;
  });
  return (
    <group position={[0.7, 1.0, 0.25]}>
      <mesh castShadow position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.055, 0.065, 0.04]} />
        <meshStandardMaterial color="#1a1a1f" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.07, 0]}>
        <sphereGeometry args={[0.05, 16, 12]} />
        <meshStandardMaterial ref={mat} color="#3a0d0d" emissive="#ff2222" emissiveIntensity={0.15} />
      </mesh>
      <pointLight ref={glow} position={[0, 0.12, 0]} color="#ff3b30" intensity={0} distance={1.6} />
    </group>
  );
}

/**
 * A workstation: table + chair + monitor + seated character.
 * Local space: desk faces +z (screen readable from -z, i.e. from behind the chair).
 */
export function Desk({ seat, variant, working, monitorTarget, name, fallbackTitle, boss, waiting }: Props) {
  const layout = useStore((s) => s.office?.layout);
  const maxSeat = useStore((s) => Math.max(3, ...(s.office?.employees.map((e) => e.seat) ?? [])));
  const buildMode = useStore((s) => s.buildMode);
  const buildHold = useStore((s) => s.buildHold);
  const resolved = resolveSeat(layout, seat, maxSeat);
  // while this desk is being dragged in build mode, render at the drag ghost
  const pose = displayPose(buildHold, 'seat', seat, {
    x: resolved.position.x,
    z: resolved.position.z,
    rotY: resolved.rotationY,
  });
  const position = [pose.x, 0, pose.z] as [number, number, number];
  const rotationY = pose.rotY;
  const deskScale = boss ? 1.15 : 1;
  const chairHeight = useStore((s) => catalogEntry(s.catalog, variant)?.chairHeight ?? 0);
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
        position={[0, chairHeight, CHAIR_OFFSET_Z]}
        rotation={[0, 0, 0]}
      />
      <group position={[0, chairHeight, CHAIR_OFFSET_Z]}>
        <ChairLegExtensions boss={boss} />
      </group>
      <group position={[0, 1.66, 0.35]}>
        <MonitorScreen target={monitorTarget} working={working} fallbackTitle={fallbackTitle} />
      </group>
      {boss && <WaitingLight on={!!waiting} />}
      {/* whole-unit drag collider: characters are raycast-invisible (NO_RAYCAST), so
          build mode grabs this box instead of individual meshes */}
      {buildMode && <BuildHandle kind="seat" itemKey={seat} pose={pose} footprint={deskFootprint(!!boss)} />}
      {/* key: remount on variant change — the mixer caches PropertyBindings by (root uuid,
          track name), so an in-place model swap leaves the new rig driven by bindings to the
          old clone's bones (T-pose). KayKit rigs share track names, so every swap collides. */}
      {/* visible-toggle (not unmount) so the mixer keeps its bindings — see key comment above */}
      <group visible={!focusedHere}>
        <Person
          key={variant}
          variant={variant}
          working={working}
          position={[0, PERSON_LIFT_Y + chairHeight, PERSON_OFFSET_Z]}
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
