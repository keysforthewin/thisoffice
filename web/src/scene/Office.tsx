import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { WALL_ART_TARGET } from './monitorPicking.ts';
import { useStore } from '../store.ts';
import { pickWallArtImage } from '../wallArt.ts';
import { wallArtTransform } from './wallArtTexture.ts';
import { Desk, FurnitureModel } from './Desk.tsx';
import { Person } from './Person.tsx';
import { Whiteboard, StatusBoard } from './Whiteboard.tsx';
import { WallTV } from './WallTV.tsx';
import { WALL_SIDES, type WallPlacement, type WallSide } from '../../../shared/types.ts';
import { roomDims } from './layout.ts';
import { resolveFurniture, WALL_ITEMS } from './buildLayout.ts';
import { wallFrame, wallToWorld } from './walls.ts';
import { BuildHandle, WallHandle, displayPose, useWallItems } from './build.tsx';
import { EotmFrame } from './EotmFrame.tsx';
import { wallStrips } from './wallOpenings.ts';
import { WindowVista } from './WindowVista.tsx';
import { SpeechBubble } from '../quiz/SpeechBubble.tsx';

/** How far the painting stands off the wall plane (its old +z offset). */
const ART_STANDOFF = 0.05;
const ART_W = 1.84;
const ART_H = 1.38;

/**
 * The framed painting behind the boss. Clicking it uploads a replacement; the
 * wheel reframes it (ctrl = pan). Both are no-ops in build mode, where the
 * click drags the frame along the wall instead (see WallHandle below).
 */
function WallArt() {
  const art = useStore((s) => s.office?.wallArt);
  // one primitive per dependency: `office.wallArt` is a fresh object on every
  // state broadcast, so depending on the object itself would redo this constantly
  const v = art?.v;
  const zoom = art?.zoom ?? 1;
  const panX = art?.panX ?? 0;
  const panY = art?.panY ?? 0;
  const url = v ? `/api/decor/wallart?v=${v}` : '/decor/wallart_1.jpg';
  const texture = useTexture(url);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const img = texture.image as { width?: number; height?: number } | undefined;
    if (!img?.width || !img?.height) return;
    const { repeat, offset } = wallArtTransform(img.width / img.height, ART_W / ART_H, zoom, panX, panY);
    // `needsUpdate` re-uploads the whole image to the GPU, so it must be set only
    // when the wrap modes actually change — never per reframe. Panning now runs
    // off mousemove, and re-uploading a multi-megapixel texture 60+ times a
    // second visibly stalls the room. repeat/offset need no flag: they feed the
    // texture matrix, which three.js recomputes every frame on its own.
    if (texture.wrapS !== THREE.ClampToEdgeWrapping || texture.wrapT !== THREE.ClampToEdgeWrapping) {
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
    }
    texture.repeat.set(repeat[0], repeat[1]);
    texture.offset.set(offset[0], offset[1]);
  }, [texture, zoom, panX, panY]);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return; // right-drag aims the camera; no file dialog mid-look
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
    <group position={[0, 0, ART_STANDOFF]}>
      <mesh castShadow>
        <boxGeometry args={[2.0, 1.55, 0.06]} />
        <meshStandardMaterial color="#3a3340" roughness={0.5} />
      </mesh>
      <mesh
        position={[0, 0, 0.035]}
        userData={{ monitorTarget: WALL_ART_TARGET }}
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

/**
 * Places a wall item at its resolved placement, and carries its drag handle.
 *
 * Children render in the wall's local frame: origin at the item's centre, +z
 * pointing into the room. That is the whole reason an item can change walls —
 * nothing it draws knows which wall it is on.
 */
function WallMounted({
  id,
  placement,
  maxSeat,
  handle,
  w,
  h,
  children,
}: {
  id: string;
  placement: WallPlacement;
  maxSeat: number;
  /** show the build-mode drag collider */
  handle: boolean;
  /** handle size (the grabbable patch, a little larger than the art) */
  w: number;
  h: number;
  children?: React.ReactNode;
}) {
  const frame = wallFrame(placement.wall, maxSeat);
  const pos = wallToWorld(placement.wall, placement.ox, placement.oy, maxSeat);
  return (
    <group position={[pos.x, pos.y, pos.z]} rotation={[0, frame.rotationY, 0]}>
      {children}
      {handle && <WallHandle id={id} placement={placement} w={w} h={h} />}
    </group>
  );
}

/** Window opening size — the hole in the wall, not the item's collision box. */
const WINDOW_W = 3.6;
const WINDOW_H = 1.9;
/** Per-wall colour, as each was authored before they were built from one component. */
const WALL_COLOR = '#5c5a68';
const WALL_COLORS: Record<WallSide, string> = {
  back: WALL_COLOR,
  left: WALL_COLOR,
  right: '#665f6e',
  front: '#5f5a68',
};

/** Glass, mullions and frame for one opening, in the wall's local frame. */
function WindowFurniture({ ox, oy }: { ox: number; oy: number }) {
  const ow = WINDOW_W;
  const oh = WINDOW_H;
  return (
    <group>
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

/**
 * One wall of the room, with whichever windows currently hang on it.
 *
 * Every wall is built the same way now that windows move between them: the
 * plane is the solid remainder around its openings, and each opening carries
 * its own glass, frame, parallax vista and light spill. A wall with no windows
 * falls out of the same code as a single full-height strip.
 *
 * `color` differs for the right wall only, which was authored a shade darker.
 */
function Wall({
  side,
  windows,
  maxSeat,
  color = WALL_COLOR,
  children,
}: {
  side: WallSide;
  windows: Array<{ id: string; ox: number; oy: number }>;
  maxSeat: number;
  color?: string;
  children?: React.ReactNode;
}) {
  const frame = wallFrame(side, maxSeat);
  const { height } = roomDims(maxSeat);
  // the wall group is centred at mid-height, so world oy becomes local oy - height/2
  const openings = windows.map((win) => ({ x: win.ox, y: win.oy - height / 2, w: WINDOW_W, h: WINDOW_H }));
  return (
    <group position={[frame.origin.x, height / 2, frame.origin.z]} rotation={[0, frame.rotationY, 0]}>
      {wallStrips(frame.span, height, openings).map((r, i) => (
        <mesh key={i} receiveShadow position={[r.x, r.y, 0]}>
          <planeGeometry args={[r.w, r.h]} />
          <meshStandardMaterial color={color} roughness={1} />
        </mesh>
      ))}
      {windows.map((win) => (
        <group key={win.id}>
          <WindowFurniture ox={win.ox} oy={win.oy - height / 2} />
          <group position={[win.ox, win.oy - height / 2, 0]}>
            <WindowVista id={win.id === 'windowLeft' ? 'left' : 'back'} />
          </group>
          {/* warm spill through the glass, just inside the room */}
          <pointLight color="#ffd9a0" intensity={14} distance={12} decay={2} position={[win.ox, win.oy - height / 2, 1]} />
        </group>
      ))}
      {children}
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
  const layout = office?.layout;
  const buildMode = useStore((s) => s.buildMode);
  const buildHold = useStore((s) => s.buildHold);
  // layout keeps its reference across unrelated state messages (see stableLayout
  // in store.ts), so this recomputes only when the layout or desk count changes
  const katPerson = office?.katPerson !== false;
  const furniture = useMemo(() => resolveFurniture(layout, maxSeat, katPerson), [layout, maxSeat, katPerson]);
  const quizEnabled = useStore((s) => s.quiz?.enabled ?? false);
  // every wall item's live placement, ghost-aware so a drag previews in place
  const placements = useWallItems(maxSeat);
  const windowsOn = (side: WallSide) =>
    WALL_ITEMS.filter((item) => item.window && placements[item.id].wall === side).map((item) => ({
      id: item.id,
      ox: placements[item.id].ox,
      oy: placements[item.id].oy,
    }));

  return (
    <group>
      {/* floor */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, centerZ]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#8a6f52" roughness={0.85} />
      </mesh>
      {/* The four walls, each carrying whichever windows currently hang on it.
          The front wall is front-side only, so the intro camera outside the room
          still sees in before clampToRoom pulls it inside. */}
      {WALL_SIDES.map((side) => (
        <Wall
          key={side}
          side={side}
          maxSeat={maxSeat}
          color={WALL_COLORS[side]}
          windows={windowsOn(side)}
        />
      ))}

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
      {/* Wall hangings. Each renders in its wall's local frame — the standoff is
          the little +z push off the wall plane each one always had. */}
      <WallMounted id="wallArt" placement={placements.wallArt} maxSeat={maxSeat} handle={buildMode} w={2.0} h={1.7}>
        <WallArt />
      </WallMounted>
      <WallMounted
        id="eotm"
        placement={placements.eotm}
        maxSeat={maxSeat}
        /* no handle for a frame that isn't hung — the game owns it */
        handle={buildMode && quizEnabled}
        w={1.6}
        h={1.3}
      >
        <EotmFrame />
      </WallMounted>
      <WallMounted id="tv" placement={placements.tv} maxSeat={maxSeat} handle={buildMode} w={3.0} h={1.8}>
        <WallTV />
      </WallMounted>
      <WallMounted id="todoBoard" placement={placements.todoBoard} maxSeat={maxSeat} handle={buildMode} w={3.4} h={2.15}>
        <Whiteboard />
      </WallMounted>
      <WallMounted
        id="statusBoard"
        placement={placements.statusBoard}
        maxSeat={maxSeat}
        handle={buildMode}
        w={3.4}
        h={2.15}
      >
        <StatusBoard />
      </WallMounted>
      {/* the windows draw with their wall; these carry only their drag handles */}
      {buildMode &&
        WALL_ITEMS.filter((item) => item.window).map((item) => (
          <WallMounted
            key={item.id}
            id={item.id}
            placement={placements[item.id]}
            maxSeat={maxSeat}
            handle
            w={3.8}
            h={2.1}
          />
        ))}
      <SpeechBubble maxSeat={maxSeat} />

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
