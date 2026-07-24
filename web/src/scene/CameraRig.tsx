import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '../store.ts';
import { seatTransform, whiteboardTransform } from './layout.ts';

export interface Pov {
  label: string;
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

/** Over-shoulder POV for a seat: behind the character's head, looking at the screen. */
function seatPov(seat: number, label: string): Pov {
  const { position, rotationY } = seatTransform(seat);
  const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  // character sits at forward*-1.35; hover behind their right shoulder
  const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const camPos = position
    .clone()
    .add(forward.clone().multiplyScalar(-2.6))
    .add(right.multiplyScalar(1.05))
    .add(new THREE.Vector3(0, 3.05, 0));
  const target = position.clone().add(forward.clone().multiplyScalar(0.35)).add(new THREE.Vector3(0, 1.6, 0));
  return { label, position: camPos, lookAt: target };
}

export function usePovList(): Pov[] {
  const office = useStore((s) => s.office);
  return useMemo(() => {
    const povs: Pov[] = [seatPov(0, office?.boss.name ?? 'Boss')];
    for (const e of office?.employees ?? []) povs.push(seatPov(e.seat, e.name));
    const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
    const wb = whiteboardTransform(maxSeat);
    povs.push({ label: 'Whiteboard', position: wb.camera, lookAt: wb.lookAt });
    return povs;
  }, [office]);
}

export function CameraRig() {
  const mode = useStore((s) => s.cameraMode);
  const povs = usePovList();
  const camera = useThree((s) => s.camera);
  const controls = useRef<OrbitControlsImpl>(null);
  const lookTarget = useRef(new THREE.Vector3(0, 1, 0));

  const free = mode.kind === 'free';

  useEffect(() => {
    if (free && controls.current) {
      // resume orbiting from wherever the POV tour left the camera
      camera.getWorldDirection(tmpDir);
      controls.current.target.copy(camera.position).add(tmpDir.multiplyScalar(4));
      controls.current.update();
    }
  }, [free, camera]);

  useFrame((_, delta) => {
    if (free) return;
    const pov = povs[Math.min((mode as { kind: 'pov'; index: number }).index, povs.length - 1)];
    if (!pov) return;
    const k = 1 - Math.exp(-delta * 4.5);
    camera.position.lerp(pov.position, k);
    lookTarget.current.lerp(pov.lookAt, k);
    camera.lookAt(lookTarget.current);
  });

  return <OrbitControls ref={controls} enabled={free} enableDamping dampingFactor={0.08} target={[0, 0.9, -1]} maxPolarAngle={Math.PI / 2 - 0.02} />;
}

const tmpDir = new THREE.Vector3();
