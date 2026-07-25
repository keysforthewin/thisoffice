import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { enterFocusMode, useStore, type CameraPose } from '../store.ts';
import { visibleRows, wrapLines } from './monitorScrollback.ts';
import { bossScreenLines } from './bossScreen.ts';

const W = 512;
const H = 320;
const REDRAW_MS = 200;
/** faster redraw while the focus camera is parked on this screen so scrolling feels live */
const FOCUS_REDRAW_MS = 50;
/** hover feedback: texture color multiplier, eased — subtle, just enough to read as "clickable" */
const HOVER_BRIGHTNESS = 1.35;

interface Props {
  /** monitor stream key: 'boss' or employee id */
  target: string;
  working: boolean;
  /** rendered when the target has no stream content (e.g. boss inbox) */
  fallbackTitle?: string;
  width?: number;
  height?: number;
}

/** A desk monitor whose screen is an offscreen canvas rendered as a texture. */
export function MonitorScreen({ target, working, fallbackTitle, width = 1.35, height = 0.85 }: Props) {
  const { canvas, ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { canvas, ctx, texture };
  }, []);

  const drawn = useRef({ version: -1, at: 0, blink: false });
  const img = useRef<{ url: string; el: HTMLImageElement; loaded: boolean } | null>(null);
  const screenMat = useRef<THREE.MeshBasicMaterial>(null);
  const gl = useThree((s) => s.gl);

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime * 1000;
    const st = useStore.getState();
    const focused = st.cameraMode.kind === 'focus' && st.cameraMode.target === target;
    const scroll = focused ? st.focusScroll : 0;

    // hover glow runs every frame (independent of the redraw throttle); a
    // focused screen is already the whole view — no highlight there
    if (screenMat.current) {
      const lit = st.monitorHover === target && !focused;
      const c = THREE.MathUtils.damp(screenMat.current.color.r, lit ? HOVER_BRIGHTNESS : 1, 12, delta);
      screenMat.current.color.setScalar(c);
    }
    if (t - drawn.current.at < (focused ? FOCUS_REDRAW_MS : REDRAW_MS)) return;

    // Load screenshots/images the worker Read (arrives as a data URL in the store).
    const imageUrl = useStore.getState().monitors[target]?.image;
    if (imageUrl !== img.current?.url) {
      if (imageUrl) {
        const el = new Image();
        const entry = { url: imageUrl, el, loaded: false };
        el.onload = () => {
          entry.loaded = true;
          drawn.current.version = -1; // force redraw with the image
        };
        el.src = imageUrl;
        img.current = entry;
      } else {
        img.current = null;
      }
      drawn.current.version = -1;
    }

    const isBoss = target === 'boss';
    const version =
      (useStore.getState().monitorVersion[target] ?? 0) +
      (isBoss ? hashState() : 0) +
      (working && scroll === 0 ? Math.floor(t / 600) : 0) + // cursor blink while working
      scroll * 8191;
    if (version === drawn.current.version) return;
    drawn.current = { version, at: t, blink: !drawn.current.blink };
    if (isBoss) drawBossScreen(ctx, drawn.current.blink, scroll);
    else
      drawToolScreen(
        ctx,
        target,
        working,
        fallbackTitle,
        drawn.current.blink,
        img.current?.loaded ? img.current.el : null,
        scroll
      );
    texture.needsUpdate = true;
  });

  const focusMonitor = (e: ThreeEvent<PointerEvent>) => {
    // while pointer-locked, clicks steer the fly cam — never steal them
    if (document.pointerLockElement) return;
    // in build mode a click on the desk grabs the whole unit, never focuses
    if (useStore.getState().buildMode) return;
    e.stopPropagation();
    const st = useStore.getState();
    const cur = st.cameraMode;
    if (cur.kind === 'focus' && cur.target === target) return;
    const pose: CameraPose = {
      position: e.camera.position.toArray() as [number, number, number],
      quaternion: e.camera.quaternion.toArray() as [number, number, number, number],
    };
    gl.domElement.style.cursor = '';
    st.setCameraMode(enterFocusMode(cur, target, pose));
  };

  const hoverStart = () => {
    if (document.pointerLockElement) return; // crosshair raycast owns hover while flying
    if (useStore.getState().buildMode) return; // build mode's own cursor feedback wins
    useStore.getState().setMonitorHover(target);
    gl.domElement.style.cursor = 'pointer';
  };
  const hoverEnd = () => {
    const st = useStore.getState();
    if (st.monitorHover === target) st.setMonitorHover(null);
    gl.domElement.style.cursor = '';
  };

  return (
    <group>
      {/* bezel */}
      <mesh
        castShadow
        position={[0, 0, 0.02]}
        userData={{ monitorTarget: target }}
        onPointerDown={focusMonitor}
        onPointerEnter={hoverStart}
        onPointerLeave={hoverEnd}
      >
        <boxGeometry args={[width + 0.08, height + 0.08, 0.05]} />
        <meshStandardMaterial color="#1a1a1f" roughness={0.6} />
      </mesh>
      {/* screen (faces -z, toward the seated character) */}
      <mesh
        position={[0, 0, -0.006]}
        rotation={[0, Math.PI, 0]}
        userData={{ monitorTarget: target }}
        onPointerDown={focusMonitor}
        onPointerEnter={hoverStart}
        onPointerLeave={hoverEnd}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial ref={screenMat} map={texture} toneMapped={false} />
      </mesh>
      {/* stand */}
      <mesh castShadow position={[0, -height / 2 - 0.12, 0.02]}>
        <cylinderGeometry args={[0.03, 0.05, 0.24]} />
        <meshStandardMaterial color="#1a1a1f" roughness={0.6} />
      </mesh>
    </group>
  );
}

/* ------------------------- canvas painting ------------------------- */

const FONT = '13px ui-monospace, Menlo, monospace';
const LINE_H = 17;
const MARGIN = 12;
const TITLE_H = 30;
/** wrapped rows / columns per screenful — the scroll unit for focus mode */
export const MONITOR_ROWS = Math.floor((H - TITLE_H - MARGIN) / LINE_H);
export const MONITOR_COLS = 62;
const MAX_ROWS = MONITOR_ROWS;
const MAX_COLS = MONITOR_COLS;

function hashState(): number {
  const s = useStore.getState().office;
  if (!s) return 0;
  // must catch the summarizer rewriting an existing item's text, not just adds
  let h = 0;
  for (const i of s.inbox) {
    h = (h * 31 + i.id.length + i.text.length * 7 + (i.fullText?.length ?? 0) * 13) | 0;
  }
  return h;
}

function base(ctx: CanvasRenderingContext2D, title: string, accent: string) {
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, TITLE_H);
  ctx.fillStyle = '#0b0f14';
  ctx.font = `bold ${FONT}`;
  ctx.fillText(clip(title, MAX_COLS), MARGIN, 20);
  ctx.font = FONT;
}

function drawToolScreen(
  ctx: CanvasRenderingContext2D,
  target: string,
  working: boolean,
  fallbackTitle: string | undefined,
  blink: boolean,
  image: HTMLImageElement | null,
  scroll: number
) {
  const st = useStore.getState();
  const mon = st.monitors[target];
  const title = mon?.title || fallbackTitle || 'idle';
  base(ctx, title, working ? '#7ee787' : '#8b949e');

  if (scroll > 0) {
    // scrolled into history: render the window from the clear-surviving buffer
    const wrapped = wrapLines(st.monitorHistory[target] ?? [], MAX_COLS);
    drawLines(ctx, visibleRows(wrapped, scroll, MAX_ROWS));
    drawScrollIndicator(ctx, scroll, wrapped.length);
    return;
  }

  if (image) {
    drawImageBody(ctx, image, mon?.lines ?? []);
    return;
  }

  const lines = wrapLines(mon?.lines ?? [], MAX_COLS).slice(-MAX_ROWS);
  drawLines(ctx, lines);
  if (working && blink) {
    const y = TITLE_H + LINE_H * (lines.length + 1);
    if (y < H - MARGIN) {
      ctx.fillStyle = '#7ee787';
      ctx.fillRect(MARGIN, y - 11, 8, 13);
    }
  }
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[]) {
  lines.forEach((line, i) => {
    if (line.startsWith('$') || line.startsWith('>')) ctx.fillStyle = '#79c0ff';
    else if (line.startsWith('▸')) ctx.fillStyle = '#d2a8ff'; // boss inbox header
    else if (line.startsWith('✓')) ctx.fillStyle = '#7ee787';
    else if (line.startsWith('✗')) ctx.fillStyle = '#f85149'; // errors / denials / interrupts
    else if (line.startsWith('⚠')) ctx.fillStyle = '#d29922'; // warnings (model fallbacks etc.)
    else if (line.startsWith('──')) ctx.fillStyle = '#8b949e'; // history divider
    else ctx.fillStyle = '#c9d1d9';
    ctx.fillText(line, MARGIN, TITLE_H + LINE_H * (i + 1));
  });
}

/** "▲ history" tag in the title bar plus a thin proportional scrollbar at the right edge. */
function drawScrollIndicator(ctx: CanvasRenderingContext2D, scroll: number, totalRows: number) {
  ctx.fillStyle = '#0b0f14';
  ctx.textAlign = 'right';
  ctx.fillText('▲ history', W - MARGIN, 20);
  ctx.textAlign = 'left';

  const maxOffset = Math.max(1, totalRows - MAX_ROWS);
  const trackY = TITLE_H + 4;
  const trackH = H - trackY - 4;
  const thumbH = Math.max(20, trackH * Math.min(1, MAX_ROWS / totalRows));
  const thumbY = trackY + (1 - scroll / maxOffset) * (trackH - thumbH);
  ctx.fillStyle = 'rgba(139, 148, 158, 0.25)';
  ctx.fillRect(W - 6, trackY, 4, trackH);
  ctx.fillStyle = '#8b949e';
  ctx.fillRect(W - 6, thumbY, 4, thumbH);
}

/** Contain-fit the Read image below the title bar, latest activity in a strip at the bottom. */
function drawImageBody(ctx: CanvasRenderingContext2D, image: HTMLImageElement, lines: string[]) {
  const areaY = TITLE_H;
  const areaH = H - TITLE_H;
  const scale = Math.min(W / image.width, areaH / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, (W - w) / 2, areaY + (areaH - h) / 2, w, h);

  const recent = lines.filter((l) => l.trim()).slice(-2);
  if (recent.length) {
    const stripH = LINE_H * recent.length + 8;
    ctx.fillStyle = 'rgba(11, 15, 20, 0.75)';
    ctx.fillRect(0, H - stripH, W, stripH);
    ctx.fillStyle = '#c9d1d9';
    recent.forEach((line, i) => {
      ctx.fillText(clip(line, MAX_COLS), MARGIN, H - stripH + LINE_H * (i + 1) - 3);
    });
  }
}

function drawBossScreen(ctx: CanvasRenderingContext2D, blink: boolean, scroll: number) {
  const office = useStore.getState().office;
  base(ctx, `INBOX — ${office?.boss.name ?? 'Boss'}`, '#d2a8ff');
  const items = office?.inbox ?? [];
  if (items.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.fillText('No new messages…', MARGIN, TITLE_H + LINE_H * 2);
    return;
  }
  const wrapped = wrapLines(bossScreenLines(items), MAX_COLS);
  drawLines(ctx, visibleRows(wrapped, scroll, MAX_ROWS));
  if (scroll > 0) drawScrollIndicator(ctx, scroll, wrapped.length);
  else if (blink) {
    ctx.fillStyle = '#d2a8ff';
    ctx.fillRect(W - 24, 8, 10, 14);
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
