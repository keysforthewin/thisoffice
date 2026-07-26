import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { enterFocusMode, useStore, type CameraPose } from '../store.ts';
import { FurnitureModel } from './Desk.tsx';
import { tvContent, tvPageIndex, TV_PAGE_MS, type TvPage } from './tvContent.ts';

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

/** Screen plane dimensions — shared with movieShots.ts so the wall-board subject
 *  registry can't drift from what's actually rendered. */
export const TV_SCREEN_W = 2.6;
export const TV_SCREEN_H = 1.46;

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
  const gl = useThree((s) => s.gl);
  /** clock page captured when focus on the TV begins; null while unfocused */
  const focusBase = useRef<number | null>(null);

  useFrame(({ clock }) => {
    const autoPage = Math.floor((clock.elapsedTime * 1000) / TV_PAGE_MS);
    const st = useStore.getState();
    const focused = st.cameraMode.kind === 'focus' && st.cameraMode.target === 'tv';
    if (!focused) focusBase.current = null;
    else if (focusBase.current === null) focusBase.current = autoPage;
    const page = tvPageIndex(autoPage, focusBase.current, st.focusScroll);
    const content = tvContent(st.stats, page);
    const key = JSON.stringify(content);
    if (key === drawnKey.current) return;
    drawnKey.current = key;
    drawTvPage(ctx, content.page, content.pageNum, content.pageCount);
    texture.needsUpdate = true;
  });

  const focusTv = (e: ThreeEvent<PointerEvent>) => {
    // while pointer-locked, clicks steer the fly cam — never steal them
    if (document.pointerLockElement) return;
    // in build mode a click drags the TV along the wall, never focuses
    if (useStore.getState().buildMode) return;
    e.stopPropagation();
    const st = useStore.getState();
    const cur = st.cameraMode;
    if (cur.kind === 'focus' && cur.target === 'tv') return;
    const pose: CameraPose = {
      position: e.camera.position.toArray() as [number, number, number],
      quaternion: e.camera.quaternion.toArray() as [number, number, number, number],
    };
    gl.domElement.style.cursor = '';
    st.setCameraMode(enterFocusMode(cur, 'tv', pose));
  };
  const hoverStart = () => {
    if (document.pointerLockElement) return; // crosshair raycast owns hover while flying
    if (useStore.getState().buildMode) return; // build mode's own cursor feedback wins
    useStore.getState().setMonitorHover('tv');
    gl.domElement.style.cursor = 'pointer';
  };
  const hoverEnd = () => {
    const st = useStore.getState();
    if (st.monitorHover === 'tv') st.setMonitorHover(null);
    gl.domElement.style.cursor = '';
  };

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <FurnitureModel
        url="/models/furniture/televisionModern.glb"
        scale={[TV_SCALE, TV_SCALE, TV_SCALE]}
        position={[0, -TV_HALF_HEIGHT, -TV_HALF_DEPTH]}
      />
      {/* screen: 16:9 plane just in front of the (flush-to-wall) panel face */}
      <mesh
        position={[0, 0, 0.03]}
        userData={{ monitorTarget: 'tv' }}
        onPointerDown={focusTv}
        onPointerEnter={hoverStart}
        onPointerLeave={hoverEnd}
      >
        <planeGeometry args={[TV_SCREEN_W, TV_SCREEN_H]} />
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
