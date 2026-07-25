import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

interface Props {
  name: string;
  position?: [number, number, number];
  /** world-space height of the tag */
  height?: number;
  accent?: string;
}

const FONT_PX = 64;
const PAD_X = 40;
const PAD_Y = 22;
const FONT = `600 ${FONT_PX}px system-ui, -apple-system, sans-serif`;

/** A floating name pill above a character's head. Sprites always face the camera. */
export function NameTag({ name, position = [0, 0, 0], height = 0.22, accent = '#7ee787' }: Props) {
  const { texture, aspect } = useMemo(() => {
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = FONT;
    const textW = Math.ceil(measure.measureText(name).width);

    const canvas = document.createElement('canvas');
    canvas.width = textW + PAD_X * 2;
    canvas.height = FONT_PX + PAD_Y * 2;
    const ctx = canvas.getContext('2d')!;

    const w = canvas.width;
    const h = canvas.height;
    const r = h / 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, r);
    ctx.fillStyle = 'rgba(11, 15, 20, 0.82)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    ctx.stroke();

    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(name, w / 2, h / 2 + FONT_PX * 0.05);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { texture, aspect: w / h };
  }, [name, accent]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    // depthTest off + late renderOrder: labels stay readable over monitors,
    // chairs, and oversized character meshes (some variants are ~2.3u tall)
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={999}>
      <spriteMaterial map={texture} transparent toneMapped={false} depthTest={false} />
    </sprite>
  );
}
