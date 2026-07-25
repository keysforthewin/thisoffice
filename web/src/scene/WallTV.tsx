import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { FurnitureModel } from './Desk.tsx';
import { tvContent, TV_PAGE_MS, type TvPage } from './tvContent.ts';

const W = 640;
const H = 360;

/**
 * Kenney `televisionModern.glb` body dims, measured once via a Box3 read of the
 * committed GLB (min [-0.3424, 0, -0.0642], max [0.3424, 0.45475, 0.0642] — a
 * flat panel with a small stand foot at its bottom). Scaled by TV_SCALE so the
 * panel is ~2.6 wide (matching the screen plane below); the model is then
 * recentered vertically and pushed back in z so its front face lands at local
 * z = 0 (flush with the wall) with the foot/back bulk hidden behind the wall
 * plane. Perfect flushness is a visual call verified against a screenshot.
 */
const TV_SCALE = 3.8;
const TV_HALF_HEIGHT = (0.45475 * TV_SCALE) / 2;
const TV_HALF_DEPTH = 0.0642 * TV_SCALE;

interface Props {
  position: [number, number, number];
  rotationY?: number;
}

/** Wall-mounted TV: Kenney furniture body + a canvas screen cycling stat pages every TV_PAGE_MS. */
export function WallTV({ position, rotationY = 0 }: Props) {
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

  useFrame(({ clock }) => {
    const page = Math.floor((clock.elapsedTime * 1000) / TV_PAGE_MS);
    const content = tvContent(useStore.getState().stats, page);
    const key = JSON.stringify(content);
    if (key === drawnKey.current) return;
    drawnKey.current = key;
    drawTvPage(ctx, content.page, content.pageNum, content.pageCount);
    texture.needsUpdate = true;
  });

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <FurnitureModel
        url="/models/furniture/televisionModern.glb"
        scale={[TV_SCALE, TV_SCALE, TV_SCALE]}
        position={[0, -TV_HALF_HEIGHT, -TV_HALF_DEPTH]}
      />
      {/* screen: 16:9 plane just in front of the (flush-to-wall) panel face */}
      <mesh position={[0, 0, 0.03]}>
        <planeGeometry args={[2.6, 1.46]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

const TITLE_COLOR = '#5a6472';
const VALUE_COLOR = '#e6edf3';
const SUB_COLOR = '#8b949e';
const DOT_ACTIVE = '#7ee787';
const DOT_INACTIVE = '#2a2f38';

function drawTvPage(ctx: CanvasRenderingContext2D, page: TvPage, pageNum: number, pageCount: number) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // title: small uppercase, letterspaced, dim
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = '600 20px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  drawLetterspaced(ctx, page.title.toUpperCase(), W / 2, 76, 2.5);

  // value: huge centered, shrink-to-fit if wider than the canvas
  const maxValueWidth = W - 60;
  let valueSize = 88;
  ctx.font = `bold ${valueSize}px ui-monospace, Menlo, monospace`;
  while (ctx.measureText(page.value).width > maxValueWidth && valueSize > 32) {
    valueSize -= 4;
    ctx.font = `bold ${valueSize}px ui-monospace, Menlo, monospace`;
  }
  ctx.fillStyle = VALUE_COLOR;
  ctx.fillText(page.value, W / 2, H / 2 + valueSize * 0.32);

  // sub line
  if (page.sub) {
    ctx.fillStyle = SUB_COLOR;
    ctx.font = '28px ui-monospace, Menlo, monospace';
    ctx.fillText(page.sub, W / 2, H / 2 + 62);
  }

  // page dots
  if (pageCount > 1 && pageCount <= 20) {
    const dotR = 4;
    const gap = 16;
    const totalW = (pageCount - 1) * gap;
    const startX = W / 2 - totalW / 2;
    const y = H - 22;
    for (let i = 0; i < pageCount; i++) {
      ctx.beginPath();
      ctx.arc(startX + i * gap, y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = i === pageNum - 1 ? DOT_ACTIVE : DOT_INACTIVE;
      ctx.fill();
    }
  }

  ctx.textAlign = 'left';
}

function drawLetterspaced(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, spacing: number) {
  const widths = [...text].map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let x = cx - total / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  [...text].forEach((c, i) => {
    ctx.fillText(c, x, y);
    x += widths[i] + spacing;
  });
  ctx.textAlign = prevAlign;
}
