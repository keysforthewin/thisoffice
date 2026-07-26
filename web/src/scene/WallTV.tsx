import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { enterFocusMode, useStore, type CameraPose } from '../store.ts';
import { FurnitureModel } from './Desk.tsx';
import { DOW_LABELS, formatTokens, tvContent, tvPageIndex, TV_PAGE_MS, type TvPage } from './tvContent.ts';
import type { UsageStats } from '../../../shared/types.ts';

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
    texture.anisotropy = 4; // the TV is almost always viewed off-axis
    return { ctx, texture };
  }, []);

  const gl = useThree((s) => s.gl);
  /** clock page captured when focus on the TV begins; null while unfocused */
  const focusBase = useRef<number | null>(null);
  // What the canvas currently shows. The TV's only inputs are the page index and
  // the stats object, and `applyServerMsg` replaces stats wholesale, so these two
  // comparisons catch every real change — no need to derive and serialize the
  // page content every frame just to discover it is unchanged.
  const drawnPage = useRef<number | null>(null);
  const drawnStats = useRef<UsageStats | null | undefined>(undefined);

  useFrame(({ clock }) => {
    const autoPage = Math.floor((clock.elapsedTime * 1000) / TV_PAGE_MS);
    const st = useStore.getState();
    const focused = st.cameraMode.kind === 'focus' && st.cameraMode.target === 'tv';
    if (!focused) focusBase.current = null;
    else if (focusBase.current === null) focusBase.current = autoPage;
    const page = tvPageIndex(autoPage, focusBase.current, st.focusScroll);
    if (page === drawnPage.current && st.stats === drawnStats.current) return;
    drawnPage.current = page;
    drawnStats.current = st.stats;
    const content = tvContent(st.stats, page);
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

/** Exported for offscreen rendering (verification/screenshots); WallTV is its only caller in the scene. */
export function drawTvPage(ctx: CanvasRenderingContext2D, page: TvPage, pageNum: number, pageCount: number) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // title: small uppercase, letterspaced, dim
  ctx.fillStyle = TITLE_COLOR;
  ctx.font = '600 20px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  drawLetterspaced(ctx, page.title.toUpperCase(), W / 2, 76, 2.5);

  if (page.chart) {
    // chart pages trade the big value for the plot; the sub line moves up under the title
    if (page.sub) {
      ctx.fillStyle = SUB_COLOR;
      ctx.font = '20px ui-monospace, Menlo, monospace';
      ctx.fillText(page.sub, W / 2, 104);
    }
    if (page.chart.kind === 'dowHours') drawDowHourChart(ctx, page.chart.grid);
    else drawPieChart(ctx, page.chart.slices);
  } else {
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

/** One colour per weekday, in DOW_LABELS order (Mon→Sun). */
const DOW_COLORS = ['#7ee787', '#79c0ff', '#d2a8ff', '#ffa657', '#f778ba', '#ffd866', '#56d4dd'];
const AXIS_COLOR = '#2a2f38';

/** 24 hourly bars, each stacked by weekday, plus an hour axis and a weekday legend. */
function drawDowHourChart(ctx: CanvasRenderingContext2D, grid: number[][]) {
  const left = 48;
  const right = W - 48;
  const baseline = 268;
  const top = 128;
  const pitch = (right - left) / 24;
  const barW = Math.floor(pitch) - 6;

  const hourTotals = Array.from({ length: 24 }, (_, h) => grid.reduce((a, row) => a + (row[h] ?? 0), 0));
  const max = Math.max(...hourTotals);
  if (max <= 0) return;
  const scale = (baseline - top) / max;

  ctx.fillStyle = AXIS_COLOR;
  ctx.fillRect(left, baseline, right - left, 1);

  for (let h = 0; h < 24; h++) {
    const x = Math.round(left + h * pitch + (pitch - barW) / 2);
    let y = baseline;
    for (let d = 0; d < 7; d++) {
      const v = grid[d]?.[h] ?? 0;
      if (v <= 0) continue;
      // every non-zero weekday stays visible, however thin its slice of the hour
      const segH = Math.max(1, v * scale);
      y -= segH;
      ctx.fillStyle = DOW_COLORS[d];
      ctx.fillRect(x, y, barW, segH);
    }
  }

  // hour ticks — only a few, so they stay legible from across the room
  ctx.fillStyle = SUB_COLOR;
  ctx.font = '15px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  for (const h of [0, 6, 12, 18, 23]) {
    ctx.fillText(String(h), left + h * pitch + pitch / 2, baseline + 20);
  }

  // peak-scale hint above the plot, so the bars have a magnitude
  ctx.textAlign = 'left';
  ctx.fillText(formatTokens(max), left, top - 6);

  // legend
  ctx.textAlign = 'left';
  ctx.font = '15px ui-monospace, Menlo, monospace';
  const chip = 9;
  const items = DOW_LABELS.map((label) => ({ label, w: chip + 5 + ctx.measureText(label).width }));
  const gap = 12;
  const totalW = items.reduce((a, it) => a + it.w, 0) + gap * (items.length - 1);
  let x = W / 2 - totalW / 2;
  const y = 306;
  items.forEach((it, d) => {
    ctx.fillStyle = DOW_COLORS[d];
    ctx.fillRect(x, y - chip + 1, chip, chip);
    ctx.fillStyle = SUB_COLOR;
    ctx.fillText(it.label, x + chip + 5, y);
    x += it.w + gap;
  });
  ctx.textAlign = 'center';
}

/**
 * Top-N pie with a name/share legend down the right. The pie sits left of centre so
 * the legend gets a full column — from across the room the names are the payload and
 * the wedges are the ranking, so neither can be squeezed into the middle.
 */
function drawPieChart(ctx: CanvasRenderingContext2D, slices: { label: string; value: number }[]) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return;

  const cx = 168;
  const cy = 224;
  const r = 74;
  let angle = -Math.PI / 2; // 12 o'clock, so the largest wedge starts where the eye lands
  slices.forEach((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = DOW_COLORS[i % DOW_COLORS.length];
    ctx.fill();
    // a hairline of background between wedges keeps adjacent colours from bleeding
    // together at this texture size; a single full-circle slice needs no seam
    if (slices.length > 1) {
      ctx.strokeStyle = '#0d1117';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    angle += sweep;
  });

  ctx.textAlign = 'left';
  ctx.font = '17px ui-monospace, Menlo, monospace';
  const chip = 11;
  const rowH = 28;
  const x = 300;
  let y = cy - ((slices.length - 1) * rowH) / 2 + 6;
  for (const [i, s] of slices.entries()) {
    ctx.fillStyle = DOW_COLORS[i % DOW_COLORS.length];
    ctx.fillRect(x, y - chip, chip, chip);
    const pct = `${Math.round((s.value / total) * 100)}%`;
    ctx.fillStyle = VALUE_COLOR;
    ctx.fillText(clipToWidth(ctx, s.label, 210), x + chip + 8, y);
    ctx.fillStyle = SUB_COLOR;
    ctx.textAlign = 'right';
    ctx.fillText(pct, W - 40, y);
    ctx.textAlign = 'left';
    y += rowH;
  }
  ctx.textAlign = 'center';
}

/** Truncate with an ellipsis so a long hire name can't run into the percentage column. */
function clipToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
  return out + '…';
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
