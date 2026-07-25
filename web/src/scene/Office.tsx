import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import { useStore } from '../store.ts';
import { Desk, FurnitureModel } from './Desk.tsx';
import { Whiteboard } from './Whiteboard.tsx';
import { roomDims, whiteboardTransform, BACK_Z } from './layout.ts';
import { resolveFurniture, WALL_ITEMS } from './buildLayout.ts';
import { BuildHandle, WallHandle, displayPose, useWallOffset } from './build.tsx';
import { wallStrips } from './wallOpenings.ts';
import { WindowVista } from './WindowVista.tsx';

function WallArt({ url, position }: { url: string; position: [number, number, number] }) {
  const texture = useTexture(url);
  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[2.0, 1.55, 0.06]} />
        <meshStandardMaterial color="#3a3340" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, 0.035]}>
        <planeGeometry args={[1.84, 1.38]} />
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

/** Hanging ceiling fixture: rod + housing + emissive panel + point light. */
function CeilingLight({ position, castShadow = false }: { position: [number, number, number]; castShadow?: boolean }) {
  return (
    <group position={position}>
      <mesh position={[0, -0.5, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 1.0]} />
        <meshStandardMaterial color="#26242c" />
      </mesh>
      <mesh position={[0, -1.05, 0]} castShadow={false}>
        <boxGeometry args={[1.7, 0.1, 0.45]} />
        <meshStandardMaterial color="#2b2b30" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[0, -1.11, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.6, 0.38]} />
        <meshBasicMaterial color="#fff7e6" />
      </mesh>
      <pointLight
        color="#f4f1e8"
        intensity={32}
        distance={20}
        decay={2}
        position={[0, -1.3, 0]}
        castShadow={castShadow}
        {...(castShadow ? { 'shadow-mapSize': [1024, 1024] as [number, number], 'shadow-bias': -0.002 } : {})}
      />
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
  const furniture = resolveFurniture(layout, maxSeat);
  const backOx = useWallOffset('windowBack', maxSeat);
  const leftOx = useWallOffset('windowLeft', maxSeat);
  const artOx = useWallOffset('wallArt', maxSeat);
  const frameOx = useWallOffset('pictureFrame', maxSeat);
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
      </group>
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
      {/* hanging fixtures: one shadow-caster, three fill */}
      <CeilingLight position={[-width / 4, height, centerZ - depth / 4]} castShadow />
      <CeilingLight position={[width / 4, height, centerZ - depth / 4]} />
      <CeilingLight position={[-width / 4, height, centerZ + depth / 4]} />
      <CeilingLight position={[width / 4, height, centerZ + depth / 4]} />

      {/* decor — same KayKit furniture set, positions resolved through the build-mode layout */}
      {furniture.map((f) => {
        const pose = displayPose(buildHold, 'furniture', f.id, f.pose);
        return (
          <group key={f.id} position={[pose.x, f.y, pose.z]} rotation={[0, pose.rotY, 0]}>
            <FurnitureModel url={f.url} scale={f.scale} />
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
      <WallArt url="/decor/wallart_1.jpg" position={[artOx, 2.15, backZ + 0.05]} />
      <FurnitureModel url="/models/furniture/pictureframe_medium.gltf" position={[frameOx, 2.25, backZ + 0.04]} />
      {buildMode && (
        <group position={[0, 0, backZ]}>
          <WallHandle id="wallArt" wall="back" ox={artOx} oy={2.15} w={wallItem('wallArt').halfW * 2} h={1.7} />
          <WallHandle id="pictureFrame" wall="back" ox={frameOx} oy={2.25} w={wallItem('pictureFrame').halfW * 2} h={1.0} />
        </group>
      )}

      <Whiteboard
        position={whiteboardTransform(maxSeat).position.toArray() as [number, number, number]}
        rotationY={whiteboardTransform(maxSeat).rotationY}
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
        />
      ))}
    </group>
  );
}
