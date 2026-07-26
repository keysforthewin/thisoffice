import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { boardContent, type BoardContent } from './whiteboardContent.ts';
import { statusBoardContent, type StatusBoardContent } from './statusBoardContent.ts';
import { BOARD_POLL_MS, shouldRecheck } from './redrawGate.ts';
import type { OfficeState } from '../../../shared/types.ts';

const W = 640;
const H = 400;

interface Props {
  position: [number, number, number];
  rotationY?: number;
}

interface BoardMeshProps<T> extends Props {
  /** projection from office state to board content; redrawn only when its JSON changes */
  content: (office: OfficeState | null) => T;
  draw: (ctx: CanvasRenderingContext2D, content: T) => void;
}

/** Shared wall-board shell: frame, marker tray, and a canvas texture redrawn on content change. */
function BoardMesh<T>({ position, rotationY = 0, content, draw }: BoardMeshProps<T>) {
  const { ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4; // boards are read at a glancing angle from most seats
    return { ctx, texture };
  }, []);

  const drawnKey = useRef('');
  // gate state: only re-derive content when the office object changed or the
  // poll elapsed, instead of stringifying the whole board every frame
  const lastOffice = useRef<OfficeState | null | undefined>(undefined);
  const lastCheck = useRef(0);

  useFrame(({ clock }) => {
    const office = useStore.getState().office;
    const now = clock.elapsedTime * 1000;
    if (!shouldRecheck(now, lastCheck.current, BOARD_POLL_MS, office, lastOffice.current)) return;
    lastCheck.current = now;
    lastOffice.current = office;

    const c = content(office);
    const key = JSON.stringify(c);
    if (key === drawnKey.current) return;
    drawnKey.current = key;
    draw(ctx, c);
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

export function Whiteboard(props: Props) {
  return <BoardMesh {...props} content={(office) => boardContent(office)} draw={drawTodos} />;
}

export function StatusBoard(props: Props) {
  return <BoardMesh {...props} content={statusBoardContent} draw={drawStatus} />;
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

function drawTodos(ctx: CanvasRenderingContext2D, content: BoardContent) {
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, W, H);
  drawHeading(ctx, 'TODO');

  if (content.mode === 'empty') {
    ctx.fillStyle = '#8a8f96';
    ctx.font = 'italic 20px "Segoe Print", "Comic Sans MS", cursive';
    ctx.fillText('(nothing on the board)', 40, 120);
    return;
  }

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

function drawStatus(ctx: CanvasRenderingContext2D, content: StatusBoardContent) {
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, W, H);
  drawHeading(ctx, 'STATUS');

  if (content.items.length === 0 && content.workers.length === 0) {
    ctx.fillStyle = '#8a8f96';
    ctx.font = 'italic 20px "Segoe Print", "Comic Sans MS", cursive';
    ctx.fillText('(all quiet)', 40, 120);
    return;
  }

  ctx.font = '19px "Segoe Print", "Comic Sans MS", cursive';
  let y = 90;
  for (const item of content.items) {
    if (y > H - 40) break;
    ctx.fillStyle = item.kind === 'boss' ? '#a33' : '#22262b';
    const lines = wrapLines(ctx, item.text, W - 90, 2);
    ctx.fillText('•', 34, y);
    for (const l of lines) {
      ctx.fillText(l, 54, y);
      y += 25;
    }
    y += 4;
  }

  if (content.workers.length > 0) {
    y += 4;
    ctx.strokeStyle = '#c9c9bd';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(W - 28, y);
    ctx.stroke();
    y += 28;
    ctx.font = 'italic 18px "Segoe Print", "Comic Sans MS", cursive';
    for (const worker of content.workers.slice(0, 4)) {
      if (y > H - 12) break;
      const label = `${worker.name} — ${worker.task}`;
      const text = label.length > 52 ? label.slice(0, 51) + '…' : label;
      ctx.fillStyle = '#1a6e3c';
      ctx.fillText(`▸ ${text}`, 34, y);
      y += 25;
    }
  }
}
