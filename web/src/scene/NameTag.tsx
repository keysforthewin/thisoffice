import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { NO_RAYCAST, isTagFullyVisible } from './nametagVisibility.ts';

interface Props {
  name: string;
  position?: [number, number, number];
  /** world-space height of the tag */
  height?: number;
  accent?: string;
  /** exempts the owner's body collider from the occlusion check */
  ignore?: (obj: THREE.Object3D) => boolean;
}

const FONT_PX = 64;
const PAD_X = 40;
const PAD_Y = 22;
const FONT = `600 ${FONT_PX}px system-ui, -apple-system, sans-serif`;

/** A floating name pill above a character's head. Sprites always face the camera. */
export function NameTag({ name, position = [0, 0, 0], height = 0.22, accent = '#7ee787', ignore }: Props) {
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

  const scale: [number, number, number] = [height * aspect, height, 1];

  const sprite = useRef<THREE.Sprite>(null);
  const material = useRef<THREE.SpriteMaterial>(null);
  const opacity = useRef(1);
  const center = useMemo(() => new THREE.Vector3(), []);

  // All-or-nothing occlusion: show the tag only when the whole quad has a
  // clear line from the camera past everything except characters (which
  // opt out of raycasting — see NO_RAYCAST in Person.tsx). The material
  // ignores depth, so a visible tag draws through characters in front of it.
  useFrame(({ camera, scene }, delta) => {
    if (!sprite.current || !material.current) return;
    sprite.current.getWorldPosition(center);
    const target = isTagFullyVisible(
      scene,
      camera.getWorldPosition(new THREE.Vector3()),
      camera.getWorldQuaternion(new THREE.Quaternion()),
      center,
      scale[0],
      scale[1],
      ignore
    )
      ? 1
      : 0;
    // Fast fade instead of a hard toggle so borderline angles don't flicker.
    opacity.current = THREE.MathUtils.damp(opacity.current, target, 25, delta);
    material.current.opacity = opacity.current;
    sprite.current.visible = opacity.current > 0.02;
  });

  return (
    <sprite ref={sprite} position={position} scale={scale} renderOrder={10} raycast={NO_RAYCAST}>
      <spriteMaterial
        ref={material}
        map={texture}
        transparent
        toneMapped={false}
        depthTest={false}
        depthWrite={false}
      />
    </sprite>
  );
}
