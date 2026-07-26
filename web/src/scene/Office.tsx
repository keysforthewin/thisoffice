import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { pickWallArtImage } from '../wallArt.ts';
import { wallArtTransform } from './wallArtTexture.ts';
import { Desk, FurnitureModel } from './Desk.tsx';
import { Person } from './Person.tsx';
import { Whiteboard, StatusBoard } from './Whiteboard.tsx';
import { WallTV } from './WallTV.tsx';
import { roomDims, whiteboardTransform, statusBoardTransform, BACK_Z } from './layout.ts';
import { resolveFurniture, WALL_ITEMS } from './buildLayout.ts';
import { BuildHandle, WallHandle, displayPose, useWallOffset } from './build.tsx';
import { wallStrips } from './wallOpenings.ts';
import { WindowVista } from './WindowVista.tsx';

const ART_W = 1.84;
const ART_H = 1.38;

/**
 * The framed painting behind the boss. Clicking it uploads a replacement; the
 * wheel reframes it (ctrl = pan). Both are no-ops in build mode, where the
 * click drags the frame along the wall instead (see WallHandle below).
 */
function WallArt({ position }: { position: [number, number, number] }) {
  const art = useStore((s) => s.office?.wallArt);
  // one primitive per dependency: `office.wallArt` is a fresh object on every
  // state broadcast, so depending on the object itself would redo this constantly
  const v = art?.v;
  const zoom = art?.zoom ?? 1;
  const panX = art?.panX ?? 0;
  const url = v ? `/api/decor/wallart?v=${v}` : '/decor/wallart_1.jpg';
  const texture = useTexture(url);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const img = texture.image as { width?: number; height?: number } | undefined;
    if (!img?.width || !img?.height) return;
    const { repeat, offset } = wallArtTransform(img.width / img.height, ART_W / ART_H, zoom, panX);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
    texture.offset.set(offset[0], offset[1]);
    texture.needsUpdate = true;
  }, [texture, zoom, panX]);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (document.pointerLockElement) return; // pointer-locked clicks steer the fly cam
    if (useStore.getState().buildMode) return; // build mode drags the frame instead
    e.stopPropagation();
    gl.domElement.style.cursor = '';
    pickWallArtImage();
  };
  const hoverStart = () => {
    if (document.pointerLockElement) return;
    if (useStore.getState().buildMode) return;
    useStore.getState().setWallArtHover(true);
    gl.domElement.style.cursor = 'pointer';
  };
  const hoverEnd = () => {
    useStore.getState().setWallArtHover(false);
    gl.domElement.style.cursor = '';
  };

  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[2.0, 1.55, 0.06]} />
        <meshStandardMaterial color="#3a3340" roughness={0.5} />
      </mesh>
      <mesh
        position={[0, 0, 0.035]}
        userData={{ monitorTarget: 'wallArt' }}
        onPointerDown={onPointerDown}
        onPointerEnter={hoverStart}
        onPointerLeave={hoverEnd}
      >
        <planeGeometry args={[ART_W, ART_H]} />
        <meshStandardMaterial map={texture} roughness={0.9} />
      </mesh>
    </group>
  );
}

/** A wall plane built from solid strips around a window opening, plus glass + mullions. */
function WallWithWindow({ w, h, ox, oy, ow, oh }: { w: number; h: number; ox: number; oy: number; ow: number; oh: number }) {
  return (
    <group>
      {wallStrips(w, h, ox, oy, ow, oh).map((r, i) => (
        <mesh key={i} receiveShadow position={[r.x, r.y, 0]}>
          <planeGeometry args={[r.w, r.h]} />
          <meshStandardMaterial color="#5c5a68" roughness={1} />
        </mesh>
      ))}
      {/* glass: barely-there tint so the vista reads through */}
      <mesh position={[ox, oy, 0.01]}>
        <planeGeometry args={[ow, oh]} />
        <meshBasicMaterial color="#aac4d8" transparent opacity={0.1} depthWrite={false} />
      </mesh>
      {/* mullions */}
      <mesh position={[ox, oy, 0.02]}>
        <boxGeometry args={[0.08, oh, 0.03]} />
        <meshStandardMaterial color="#4a4450" />
      </mesh>
      <mesh position={[ox, oy, 0.02]}>
        <boxGeometry args={[ow, 0.08, 0.03]} />
        <meshStandardMaterial color="#4a4450" />
      </mesh>
      {/* frame: four border pieces — a single slab here would fill the opening */}
      {[
        [ox, oy + oh / 2 + 0.03, ow + 0.12, 0.06],
        [ox, oy - oh / 2 - 0.03, ow + 0.12, 0.06],
        [ox - ow / 2 - 0.03, oy, 0.06, oh],
        [ox + ow / 2 + 0.03, oy, 0.06, oh],
      ].map(([x, y, fw, fh], i) => (
        <mesh key={`f${i}`} position={[x, y, 0.005]}>
          <boxGeometry args={[fw, fh, 0.02]} />
          <meshStandardMaterial color="#4a4450" />
        </mesh>
      ))}
    </group>
  );
}

// One set of buffers and materials for all four identical fixtures.
const ROD_GEOMETRY = new THREE.CylinderGeometry(0.02, 0.02, 1.0);
const ROD_MATERIAL = new THREE.MeshStandardMaterial({ color: '#26242c' });
const HOUSING_GEOMETRY = new THREE.BoxGeometry(1.7, 0.1, 0.45);
const HOUSING_MATERIAL = new THREE.MeshStandardMaterial({ color: '#2b2b30', metalness: 0.4, roughness: 0.5 });
const PANEL_GEOMETRY = new THREE.PlaneGeometry(1.6, 0.38);
const PANEL_MATERIAL = new THREE.MeshBasicMaterial({ color: '#fff7e6' });

/** Lit fixtures carry more intensity now that only two of the four emit. */
const CEILING_INTENSITY = 50;

/**
 * Hanging ceiling fixture: rod + housing + emissive panel, and optionally a
 * point light.
 *
 * `light` is separate from the fixture on purpose. Every point light is
 * evaluated per fragment by every StandardMaterial in the room, so four of them
 * is a real cost — but they are also visible objects, and deleting two would
 * leave two bare patches of ceiling. Keeping all four fixtures and lighting two
 * of them diagonally preserves the look at half the shading cost; the emissive
 * panel means an unlit fixture still reads as "on".
 */
function CeilingLight({
  position,
  castShadow = false,
  light = false,
}: {
  position: [number, number, number];
  castShadow?: boolean;
  light?: boolean;
}) {
  return (
    <group position={position}>
      <mesh position={[0, -0.5, 0]} geometry={ROD_GEOMETRY} material={ROD_MATERIAL} />
      <mesh position={[0, -1.05, 0]} castShadow={false} geometry={HOUSING_GEOMETRY} material={HOUSING_MATERIAL} />
      <mesh position={[0, -1.11, 0]} rotation={[Math.PI / 2, 0, 0]} geometry={PANEL_GEOMETRY} material={PANEL_MATERIAL} />
      {light && (
        <pointLight
          color="#f4f1e8"
          intensity={CEILING_INTENSITY}
          distance={20}
          decay={2}
          position={[0, -1.3, 0]}
          castShadow={castShadow}
          {...(castShadow ? { 'shadow-mapSize': [1024, 1024] as [number, number], 'shadow-bias': -0.002 } : {})}
        />
      )}
    </group>
  );
}

export function Office() {
  const office = useStore((s) => s.office);

  const maxSeat = useMemo(
    () => Math.max(3, ...(office?.employees.map((e) => e.seat) ?? [])),
    [office]
  );
  const { width, depth, centerZ, height } = roomDims(maxSeat);
  const backZ = BACK_Z;
  const layout = office?.layout;
  const buildMode = useStore((s) => s.buildMode);
  const buildHold = useStore((s) => s.buildHold);
  // layout keeps its reference across unrelated state messages (see stableLayout
  // in store.ts), so this recomputes only when the layout or desk count changes
  const furniture = useMemo(() => resolveFurniture(layout, maxSeat), [layout, maxSeat]);
  const backOx = useWallOffset('windowBack', maxSeat);
  const leftOx = useWallOffset('windowLeft', maxSeat);
  const artOx = useWallOffset('wallArt', maxSeat);
  const tvOx = useWallOffset('tv', maxSeat);
  const wallItem = (id: string) => WALL_ITEMS.find((w) => w.id === id)!;

  return (
    <group>
      {/* floor */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, centerZ]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#8a6f52" roughness={0.85} />
      </mesh>
      {/* back wall (behind the boss), with a window onto its own layered city vista */}
      <group position={[0, height / 2, backZ]}>
        <WallWithWindow w={width} h={height} ox={backOx} oy={2.1 - height / 2} ow={3.6} oh={1.9} />
        <group position={[backOx, 2.1 - height / 2, 0]}>
          <WindowVista id="back" />
        </group>
        {buildMode && (
          <WallHandle id="windowBack" wall="back" ox={backOx} oy={2.1 - height / 2} w={3.8} h={2.1} />
        )}
      </group>
      {/* warm spill through the back window (kept from the old fake window) */}
      <pointLight color="#ffd9a0" intensity={14} distance={12} decay={2} position={[backOx, 2.1, backZ + 1]} />

      {/* left wall, with a window onto its own layered city vista (windows face outward like before) */}
      <group position={[-width / 2, height / 2, centerZ]} rotation={[0, Math.PI / 2, 0]}>
        <WallWithWindow w={depth} h={height} ox={leftOx} oy={2.1 - height / 2} ow={3.6} oh={1.9} />
        <group position={[leftOx, 2.1 - height / 2, 0]}>
          <WindowVista id="left" />
        </group>
        {buildMode && (
          <WallHandle id="windowLeft" wall="left" ox={leftOx} oy={2.1 - height / 2} w={3.8} h={2.1} />
        )}
        {buildMode && <WallHandle id="tv" wall="left" ox={tvOx} oy={2.2 - height / 2} w={3.0} h={1.8} />}
      </group>
      <WallTV position={[-width / 2 + 0.07, 2.2, centerZ - tvOx]} rotationY={Math.PI / 2} />
      {/* right wall (whiteboard wall) */}
      <mesh receiveShadow position={[width / 2, height / 2, centerZ]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#665f6e" roughness={1} />
      </mesh>
      {/* front wall (the one the boss faces); front-side only, so the intro
          camera outside the room still sees in before clampToRoom pulls it inside */}
      <mesh receiveShadow position={[0, height / 2, centerZ + depth / 2]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial color="#5f5a68" roughness={1} />
      </mesh>

      {/* ceiling: unlit material so the downward fixtures can't splash light onto it */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, height, centerZ]}>
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial color="#2a2731" />
      </mesh>
      {/* four fixtures, two of them lit on the diagonal: same ceiling, half the
          per-fragment light loop (see the CeilingLight comment) */}
      <CeilingLight position={[-width / 4, height, centerZ - depth / 4]} light castShadow />
      <CeilingLight position={[width / 4, height, centerZ - depth / 4]} />
      <CeilingLight position={[-width / 4, height, centerZ + depth / 4]} />
      <CeilingLight position={[width / 4, height, centerZ + depth / 4]} light />

      {/* decor — same KayKit furniture set, positions resolved through the build-mode layout */}
      {furniture.map((f) => {
        const pose = displayPose(buildHold, 'furniture', f.id, f.pose);
        return (
          <group key={f.id} position={[pose.x, f.y, pose.z]} rotation={[0, pose.rotY, 0]}>
            {f.character ? (
              <Person
                variant={f.character.variant}
                clip={f.character.clip}
                name={f.character.name}
                working={false}
                accent="#f0b3d0"
              />
            ) : (
              <FurnitureModel url={f.url} scale={f.scale} />
            )}
            {f.light && (
              <pointLight
                color={f.light.color}
                intensity={f.light.intensity}
                distance={f.light.distance}
                decay={2}
                position={f.light.offset}
              />
            )}
            {buildMode && (
              <BuildHandle kind="furniture" itemKey={f.id} pose={pose} footprint={f.footprint} height={f.handleH} />
            )}
          </group>
        );
      })}
      <WallArt position={[artOx, 2.15, backZ + 0.05]} />
      {buildMode && (
        <group position={[0, 0, backZ]}>
          <WallHandle id="wallArt" wall="back" ox={artOx} oy={2.15} w={wallItem('wallArt').halfW * 2} h={1.7} />
        </group>
      )}

      <Whiteboard
        position={whiteboardTransform(maxSeat).position.toArray() as [number, number, number]}
        rotationY={whiteboardTransform(maxSeat).rotationY}
      />
      <StatusBoard
        position={statusBoardTransform(maxSeat).position.toArray() as [number, number, number]}
        rotationY={statusBoardTransform(maxSeat).rotationY}
      />

      {/* boss */}
      {office && (
        <Desk
          seat={0}
          variant={office.boss.variant}
          working={office.bossStatus === 'working'}
          monitorTarget="boss"
          name={office.boss.name}
          boss
          waiting={office.waitingForInput}
          maxSeat={maxSeat}
        />
      )}
      {/* employees */}
      {office?.employees.map((e) => (
        <Desk
          key={e.id}
          seat={e.seat}
          variant={e.variant}
          working={e.status === 'working'}
          monitorTarget={e.id}
          name={e.name}
          fallbackTitle={`${e.name} · idle`}
          maxSeat={maxSeat}
        />
      ))}
    </group>
  );
}
