import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import { useStore } from '../store.ts';
import { Desk, FurnitureModel } from './Desk.tsx';
import { Whiteboard } from './Whiteboard.tsx';
import { roomDims, whiteboardTransform, BACK_Z } from './layout.ts';

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

export function Office() {
  const office = useStore((s) => s.office);

  const maxSeat = useMemo(
    () => Math.max(3, ...(office?.employees.map((e) => e.seat) ?? [])),
    [office]
  );
  const { width, depth, centerZ } = roomDims(maxSeat);
  const backZ = BACK_Z;
  const wallH = 4.2;

  return (
    <group>
      {/* floor */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, centerZ]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#8a6f52" roughness={0.85} />
      </mesh>
      {/* back wall (behind the boss) */}
      <mesh receiveShadow position={[0, wallH / 2, backZ]}>
        <planeGeometry args={[width, wallH]} />
        <meshStandardMaterial color="#5c5a68" roughness={1} />
      </mesh>
      {/* side walls */}
      <mesh receiveShadow position={[-width / 2, wallH / 2, centerZ]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[depth, wallH]} />
        <meshStandardMaterial color="#665f6e" roughness={1} />
      </mesh>
      <mesh receiveShadow position={[width / 2, wallH / 2, centerZ]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[depth, wallH]} />
        <meshStandardMaterial color="#665f6e" roughness={1} />
      </mesh>
      {/* window on the back wall: dusk sky + warm spill light */}
      <group position={[-width / 4, 2.1, backZ + 0.03]}>
        <mesh>
          <planeGeometry args={[3.6, 1.9]} />
          <meshBasicMaterial color="#ffc98a" />
        </mesh>
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[3.3, 1.6]} />
          <meshBasicMaterial color="#ffe7c2" />
        </mesh>
        {/* mullions */}
        <mesh position={[0, 0, 0.02]}>
          <boxGeometry args={[0.08, 1.9, 0.03]} />
          <meshStandardMaterial color="#4a4450" />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <boxGeometry args={[3.6, 0.08, 0.03]} />
          <meshStandardMaterial color="#4a4450" />
        </mesh>
        <pointLight color="#ffd9a0" intensity={14} distance={12} decay={2} position={[0, 0, 1]} />
      </group>

      {/* decor — same KayKit furniture set */}
      <FurnitureModel url="/models/furniture/rug_rectangle_A.gltf" position={[0, 0.005, centerZ + 0.5]} scale={[2.2, 1, 2.2]} />
      <FurnitureModel url="/models/furniture/lamp_standing.gltf" position={[width / 2 - 1, 0, backZ + 0.9]} rotation={[0, -Math.PI / 4, 0]} />
      <pointLight color="#ffcf96" intensity={10} distance={9} decay={2} position={[width / 2 - 1, 2.4, backZ + 1]} />
      <FurnitureModel url="/models/furniture/shelf_A_big.gltf" position={[width / 2 - 0.4, 0, centerZ + 3.2]} rotation={[0, -Math.PI / 2, 0]} />
      <FurnitureModel url="/models/furniture/cactus_medium_A.gltf" position={[-width / 2 + 0.8, 0, backZ + 0.8]} />
      <FurnitureModel url="/models/furniture/cactus_small_A.gltf" position={[-width / 2 + 0.6, 0, centerZ + 2]} />
      <FurnitureModel url="/models/furniture/couch_pillows.gltf" position={[-width / 2 + 0.9, 0, centerZ + 0.6]} rotation={[0, Math.PI / 2, 0]} />
      <WallArt url="/decor/wallart_1.jpg" position={[width / 4 + 0.5, 2.15, backZ + 0.05]} />
      <FurnitureModel url="/models/furniture/pictureframe_medium.gltf" position={[0, 2.25, backZ + 0.04]} />

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
          boss
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
          fallbackTitle={`${e.name} · idle`}
        />
      ))}
    </group>
  );
}
