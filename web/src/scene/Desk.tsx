import { memo, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeElements, type ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { MonitorScreen } from './MonitorScreen.tsx';
import { Person } from './Person.tsx';
import { deskFootprint, resolveSeat } from './buildLayout.ts';
import { BuildHandle, displayPose } from './build.tsx';
import { useStore } from '../store.ts';
import { catalogEntry } from '../characters/catalog.ts';
import { BEACON_TARGET } from './monitorPicking.ts';

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
  /** highest occupied seat, sizing the room — computed once in Office, not per desk */
  maxSeat: number;
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
// Shared once for the whole room: inline <boxGeometry>/<meshStandardMaterial>
// give every mesh its own geometry and material, so a full office was allocating
// four identical leg geometries and four identical materials per desk — a dozen
// desks meant ~50 redundant GPU buffers and as many shader-uniform sets.
const LEG_GEOMETRY = new THREE.BoxGeometry(0.16, 0.6, 0.16);
const LEG_MATERIAL = new THREE.MeshStandardMaterial({ color: '#d4885f', roughness: 0.9 });
const PLINTH_GEOMETRY = new THREE.BoxGeometry(1.7, 0.6, 1.5);
const PLINTH_MATERIAL = new THREE.MeshStandardMaterial({ color: '#a5664c', roughness: 0.9 });

function ChairLegExtensions({ boss }: { boss?: boolean }) {
  return boss ? (
    <mesh position={[0, -0.31, 0.05]} geometry={PLINTH_GEOMETRY} material={PLINTH_MATERIAL} />
  ) : (
    <>
      {CHAIR_LEG_XZ.map(([x, z]) => (
        <mesh key={`${x},${z}`} position={[x, -0.2, z]} geometry={LEG_GEOMETRY} material={LEG_MATERIAL} />
      ))}
    </>
  );
}

/**
 * Small desk beacon: dark base + red bulb that blinks while a tailed session is
 * waiting for user input. Always part of the desk; dark when idle.
 */
const BEACON_BASE_GEOMETRY = new THREE.CylinderGeometry(0.055, 0.065, 0.04);
const BEACON_BASE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#1a1a1f', roughness: 0.6 });
const BEACON_BULB_GEOMETRY = new THREE.SphereGeometry(0.05, 16, 12);

/**
 * Steady emissive level once the blink has been dismissed: clearly lit, so the
 * session is still visibly blocked, but no longer moving. Muting is meant to
 * stop the nagging, not to hide the fact — the fact belongs to the transcript,
 * and no click in this room can answer the session that is waiting.
 */
const MUTED_EMISSIVE = 1.6;

function WaitingLight({ on }: { on: boolean }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const glow = useRef<THREE.PointLight>(null);
  const muted = useStore((s) => s.beaconMuted);
  const { gl } = useThree();

  useFrame(({ clock }) => {
    // Muted: hold the lit level instead of square-waving through it.
    const lit = on && (muted || Math.sin(clock.elapsedTime * 5) > 0); // blink ~0.8 Hz
    const level = on && muted ? MUTED_EMISSIVE : 4;
    if (mat.current) mat.current.emissiveIntensity = lit ? level : 0.15;
    if (glow.current) glow.current.intensity = lit ? (on && muted ? 0.9 : 2.2) : 0;
  });

  // Only the blinking beacon is clickable — dismissing a dark one would arm a
  // mute against a wait that hasn't happened yet, and the store deliberately has
  // no way to express that.
  const armed = on && !muted;
  const dismiss = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return; // right-drag aims the camera; it must not mute on the way past
    if (document.pointerLockElement) return; // pointer-locked clicks steer the fly cam
    if (useStore.getState().buildMode) return; // build mode drags the desk instead
    if (!armed) return;
    e.stopPropagation(); // the desk behind it would otherwise take the focus click
    gl.domElement.style.cursor = '';
    useStore.getState().muteBeacon();
  };
  const hover = (e: ThreeEvent<PointerEvent>) => {
    if (!armed || useStore.getState().buildMode) return;
    e.stopPropagation();
    gl.domElement.style.cursor = 'pointer';
  };
  const unhover = () => {
    gl.domElement.style.cursor = '';
  };

  // `userData.monitorTarget` is the fly cam's crosshair channel; it is stamped on
  // only while the beacon is armed, so a pointer-locked click at a dark bulb
  // falls through to whatever is behind it rather than arming a mute for a wait
  // that hasn't happened — the same rule `dismiss` follows for the cursor.
  const crosshair = armed ? { monitorTarget: BEACON_TARGET } : {};

  return (
    <group position={[0.7, 1.0, 0.25]} onPointerDown={dismiss} onPointerOver={hover} onPointerOut={unhover}>
      {/* The two existing meshes are the whole click target. A larger invisible
          collider would be easier to hit, but every raycastable mesh also
          occludes nametags (see nametagVisibility.ts) — a hit box bigger than
          the bulb would punch a hole in the tags behind the boss desk. */}
      <mesh
        castShadow
        position={[0, 0.02, 0]}
        geometry={BEACON_BASE_GEOMETRY}
        material={BEACON_BASE_MATERIAL}
        userData={crosshair}
      />
      {/* the bulb material is per-instance: its emissiveIntensity is animated */}
      <mesh position={[0, 0.07, 0]} geometry={BEACON_BULB_GEOMETRY} userData={crosshair}>
        <meshStandardMaterial ref={mat} color="#3a0d0d" emissive="#ff2222" emissiveIntensity={0.15} />
      </mesh>
      {/* Mounted only while actually waiting. An intensity-0 light still counts
          toward NUM_POINT_LIGHTS and is evaluated by every StandardMaterial
          fragment in the room; the shader recompile when it toggles is a
          one-off, and the beacon changes state rarely. */}
      {on && <pointLight ref={glow} position={[0, 0.12, 0]} color="#ff3b30" intensity={0} distance={1.6} />}
    </group>
  );
}

/**
 * A workstation: table + chair + monitor + seated character.
 * Local space: desk faces +z (screen readable from -z, i.e. from behind the chair).
 */
function DeskImpl({ seat, variant, working, monitorTarget, name, fallbackTitle, boss, waiting, maxSeat }: Props) {
  const layout = useStore((s) => s.office?.layout);
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
  // + = toward the desk, − = back into the chair (for rigs that perch on the front edge)
  const chairForward = useStore((s) => catalogEntry(s.catalog, variant)?.chairForward ?? 0);
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
          position={[0, PERSON_LIFT_Y + chairHeight, PERSON_OFFSET_Z + chairForward]}
          rotationY={0}
          name={name}
          accent={boss ? '#d2a8ff' : working ? '#7ee787' : '#8b949e'}
        />
      </group>
    </group>
  );
}

/**
 * All props are primitives, so the default shallow compare is exact. This is
 * what keeps an unrelated status push — which replaces the whole office object —
 * from re-rendering every desk, monitor and character in the room. Desks still
 * re-render on the things they subscribe to directly (layout, build mode,
 * catalog, focus).
 */
export const Desk = memo(DeskImpl);

useGLTF.preload('/models/furniture/table_medium.gltf');
useGLTF.preload('/models/furniture/chair_A.gltf');
useGLTF.preload('/models/furniture/armchair_pillows.gltf');
