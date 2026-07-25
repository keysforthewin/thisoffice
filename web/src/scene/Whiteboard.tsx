import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { boardContent, type BoardContent } from './whiteboardContent.ts';

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
    const content = boardContent(useStore.getState().office);
    const key = JSON.stringify(content);
    if (key === drawnKey.current) return;
    drawnKey.current = key;
    draw(ctx, content);
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

function drawHeading(ctx: CanvasRenderingContext2D, text: string) {
  ctx.fillStyle = '#1a3c6e';
  ctx.font = 'bold 30px "Segoe Print", "Comic Sans MS", cursive';
  ctx.fillText(text, 30, 48);
  ctx.strokeStyle = '#1a3c6e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(28, 58);
  ctx.lineTo(30 + ctx.measureText(text).width, 58);
  ctx.stroke();
}

function drawProjectLabel(ctx: CanvasRenderingContext2D, project: string) {
  if (!project) return;
  ctx.fillStyle = '#a33';
  ctx.font = 'italic 18px "Segoe Print", "Comic Sans MS", cursive';
  ctx.fillText(project, W - 30 - ctx.measureText(project).width, 42);
}

/** Hard-truncates a single token (e.g. a pasted URL/path) with an ellipsis so it fits maxWidth. */
function truncateToWidth(ctx: CanvasRenderingContext2D, word: string, maxWidth: number): string {
  if (ctx.measureText(word).width <= maxWidth) return word;
  let truncated = word;
  while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

/** Greedily wraps text to fit maxWidth, capped at maxLines (last line gets an ellipsis if truncated). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    // a lone word wider than the line (e.g. a pasted URL/path) never fits alongside
    // other text, so it gets its own hard-truncated line
    if (ctx.measureText(word).width > maxWidth) {
      if (current) {
        lines.push(current);
        current = '';
        if (lines.length === maxLines) break;
      }
      lines.push(truncateToWidth(ctx, word, maxWidth));
      if (lines.length === maxLines) break;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines) {
    // if there's leftover text beyond what fit, mark the last line truncated
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length && !lines[maxLines - 1].endsWith('…')) {
      let last = lines[maxLines - 1];
      while (ctx.measureText(last + '…').width > maxWidth && last.length > 0) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = last + '…';
    }
  }
  return lines;
}

function draw(ctx: CanvasRenderingContext2D, content: BoardContent) {
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, W, H);

  if (content.mode === 'empty') {
    drawHeading(ctx, 'TODO');
    ctx.fillStyle = '#8a8f96';
    ctx.font = 'italic 20px "Segoe Print", "Comic Sans MS", cursive';
    ctx.fillText('(nothing on the board)', 40, 120);
    return;
  }

  if (content.mode === 'synopsis') {
    // "IN PROGRESS" only makes sense while someone's actually working; once
    // everyone's idle again the inbox item is stale, so relabel it as history.
    drawHeading(ctx, content.workers.length > 0 ? 'IN PROGRESS' : 'LAST PROMPT');
    drawProjectLabel(ctx, content.project);

    ctx.fillStyle = '#22262b';
    ctx.font = 'italic 19px "Segoe Print", "Comic Sans MS", cursive';
    const summaryLines = content.summary ? wrapLines(ctx, content.summary, W - 60, 3) : [];
    let y = 90;
    for (const line of summaryLines) {
      ctx.fillText(line, 30, y);
      y += 26;
    }

    y += 6;
    ctx.strokeStyle = '#c9c9bd';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(W - 28, y);
    ctx.stroke();
    y += 30;

    ctx.font = '19px "Segoe Print", "Comic Sans MS", cursive';
    for (const worker of content.workers.slice(0, 7)) {
      if (y > H - 15) break;
      const label = `${worker.name} — ${worker.task}`;
      const text = label.length > 48 ? label.slice(0, 47) + '…' : label;
      ctx.fillStyle = '#a33';
      ctx.fillText(`• ${text}`, 34, y);
      y += 27;
    }
    return;
  }

  // mode === 'todos'
  drawHeading(ctx, 'TODO');
  drawProjectLabel(ctx, content.project);

  ctx.font = '19px "Segoe Print", "Comic Sans MS", cursive';
  let y = 100;
  for (const item of content.items.slice(0, 11)) {
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
