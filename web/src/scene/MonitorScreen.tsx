import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store.ts';

const W = 512;
const H = 320;
const REDRAW_MS = 200;

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

  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 1000;
    if (t - drawn.current.at < REDRAW_MS) return;

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
      (working ? Math.floor(t / 600) : 0); // cursor blink while working
    if (version === drawn.current.version) return;
    drawn.current = { version, at: t, blink: !drawn.current.blink };
    if (isBoss) drawBossScreen(ctx, drawn.current.blink);
    else
      drawToolScreen(
        ctx,
        target,
        working,
        fallbackTitle,
        drawn.current.blink,
        img.current?.loaded ? img.current.el : null
      );
    texture.needsUpdate = true;
  });

  return (
    <group>
      {/* bezel */}
      <mesh castShadow position={[0, 0, 0.02]}>
        <boxGeometry args={[width + 0.08, height + 0.08, 0.05]} />
        <meshStandardMaterial color="#1a1a1f" roughness={0.6} />
      </mesh>
      {/* screen (faces -z, toward the seated character) */}
      <mesh position={[0, 0, -0.006]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
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
const MAX_ROWS = Math.floor((H - TITLE_H - MARGIN) / LINE_H);
const MAX_COLS = 62;

function hashState(): number {
  const s = useStore.getState().office;
  return s ? s.inbox.length * 31 + (s.inbox[s.inbox.length - 1]?.id.length ?? 0) : 0;
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
  image: HTMLImageElement | null
) {
  const mon = useStore.getState().monitors[target];
  const title = mon?.title || fallbackTitle || 'idle';
  base(ctx, title, working ? '#7ee787' : '#8b949e');

  if (image) {
    drawImageBody(ctx, image, mon?.lines ?? []);
    return;
  }

  const lines = wrap(mon?.lines ?? [], MAX_COLS).slice(-MAX_ROWS);
  ctx.fillStyle = '#c9d1d9';
  lines.forEach((line, i) => {
    if (line.startsWith('$') || line.startsWith('>')) ctx.fillStyle = '#79c0ff';
    else if (line.startsWith('✓')) ctx.fillStyle = '#7ee787';
    else ctx.fillStyle = '#c9d1d9';
    ctx.fillText(line, MARGIN, TITLE_H + LINE_H * (i + 1));
  });
  if (working && blink) {
    const y = TITLE_H + LINE_H * (lines.length + 1);
    if (y < H - MARGIN) {
      ctx.fillStyle = '#7ee787';
      ctx.fillRect(MARGIN, y - 11, 8, 13);
    }
  }
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

function drawBossScreen(ctx: CanvasRenderingContext2D, blink: boolean) {
  const office = useStore.getState().office;
  base(ctx, `INBOX — ${office?.boss.name ?? 'Boss'}`, '#d2a8ff');
  const items = office?.inbox ?? [];
  if (items.length === 0) {
    ctx.fillStyle = '#8b949e';
    ctx.fillText('No new messages…', MARGIN, TITLE_H + LINE_H * 2);
  }
  let row = 0;
  for (const item of items.slice(-5).reverse()) {
    if (row >= MAX_ROWS - 1) break;
    ctx.fillStyle = '#d2a8ff';
    const time = item.at.slice(11, 16);
    ctx.fillText(clip(`▸ [${item.project}] ${time}`, MAX_COLS), MARGIN, TITLE_H + LINE_H * (row + 1));
    row++;
    ctx.fillStyle = '#c9d1d9';
    for (const l of wrap([item.text], MAX_COLS - 2).slice(0, 2)) {
      if (row >= MAX_ROWS) break;
      ctx.fillText('  ' + l, MARGIN, TITLE_H + LINE_H * (row + 1));
      row++;
    }
  }
  if (blink) {
    ctx.fillStyle = '#d2a8ff';
    ctx.fillRect(W - 24, 8, 10, 14);
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function wrap(lines: string[], cols: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= cols) out.push(line);
    else for (let i = 0; i < line.length; i += cols) out.push(line.slice(i, i + cols));
  }
  return out;
}
