import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store.ts';

const W = 640;
const H = 400;

interface Props {
  position: [number, number, number];
  rotationY?: number;
}

export function Whiteboard({ position, rotationY = 0 }: Props) {
  const { ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { ctx, texture };
  }, []);

  const drawnKey = useRef('');

  useFrame(() => {
    const todos = useStore.getState().office?.todos;
    const key = JSON.stringify(todos ?? null);
    if (key === drawnKey.current) return;
    drawnKey.current = key;
    draw(ctx, todos);
    texture.needsUpdate = true;
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* frame */}
      <mesh castShadow>
        <boxGeometry args={[3.4, 2.15, 0.06]} />
        <meshStandardMaterial color="#b8bcc2" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0, 0.035]}>
        <planeGeometry args={[3.2, 1.95]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {/* marker tray */}
      <mesh castShadow position={[0, -1.12, 0.08]}>
        <boxGeometry args={[1.6, 0.05, 0.12]} />
        <meshStandardMaterial color="#b8bcc2" roughness={0.4} metalness={0.3} />
      </mesh>
    </group>
  );
}

function draw(ctx: CanvasRenderingContext2D, todos: { project: string; items: any[] } | null | undefined) {
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#1a3c6e';
  ctx.font = 'bold 30px "Segoe Print", "Comic Sans MS", cursive';
  ctx.fillText('TODO', 30, 48);
  ctx.strokeStyle = '#1a3c6e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(28, 58);
  ctx.lineTo(130, 58);
  ctx.stroke();

  if (todos?.project) {
    ctx.fillStyle = '#a33';
    ctx.font = 'italic 18px "Segoe Print", "Comic Sans MS", cursive';
    ctx.fillText(todos.project, W - 30 - ctx.measureText(todos.project).width, 42);
  }

  const items = todos?.items ?? [];
  if (items.length === 0) {
    ctx.fillStyle = '#8a8f96';
    ctx.font = 'italic 20px "Segoe Print", "Comic Sans MS", cursive';
    ctx.fillText('(nothing on the board)', 40, 120);
    return;
  }

  ctx.font = '19px "Segoe Print", "Comic Sans MS", cursive';
  let y = 100;
  for (const item of items.slice(0, 11)) {
    if (y > H - 20) break;
    const active = item.status === 'in_progress';
    const done = item.status === 'completed';
    // checkbox
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.strokeRect(34, y - 15, 16, 16);
    if (done) {
      ctx.strokeStyle = '#2c7a3f';
      ctx.beginPath();
      ctx.moveTo(36, y - 8);
      ctx.lineTo(41, y - 2);
      ctx.lineTo(50, y - 14);
      ctx.stroke();
    }
    const text = item.content.length > 48 ? item.content.slice(0, 47) + '…' : item.content;
    ctx.fillStyle = done ? '#8a8f96' : active ? '#a33' : '#22262b';
    ctx.fillText(text, 62, y);
    if (done) {
      ctx.strokeStyle = '#8a8f96';
      ctx.beginPath();
      ctx.moveTo(60, y - 6);
      ctx.lineTo(62 + ctx.measureText(text).width, y - 6);
      ctx.stroke();
    }
    if (active) ctx.fillText('◀', 62 + ctx.measureText(text).width + 10, y);
    y += 27;
  }
}
