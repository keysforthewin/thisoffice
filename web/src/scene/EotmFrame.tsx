import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { useStore } from '../store.ts';
import { wallArtTransform } from './wallArtTexture.ts';
import { captionLines, EOTM_W, EOTM_H, EOTM_CAPTION_H } from './eotmTexture.ts';

const CAPTION_PX_W = 512;
const CAPTION_PX_H = 96;

/** The plaque under the photo: repainted only when the winner's name changes. */
function useCaptionTexture(name: string): THREE.CanvasTexture {
  const ref = useRef<{ canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } | null>(null);
  if (!ref.current) {
    const canvas = document.createElement('canvas');
    canvas.width = CAPTION_PX_W;
    canvas.height = CAPTION_PX_H;
    ref.current = { canvas, texture: new THREE.CanvasTexture(canvas) };
  }
  const { canvas, texture } = ref.current;

  useEffect(() => {
    const ctx = canvas.getContext('2d')!;
    const [title, who] = captionLines(name);
    ctx.fillStyle = '#1a1408';
    ctx.fillRect(0, 0, CAPTION_PX_W, CAPTION_PX_H);
    ctx.fillStyle = '#d8b45a';
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(title, CAPTION_PX_W / 2, 32);
    ctx.font = 'bold 38px system-ui, sans-serif';
    ctx.fillText(who, CAPTION_PX_W / 2, 76);
    texture.needsUpdate = true;
  }, [canvas, texture, name]);

  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/**
 * The Employee of the Month photo behind the boss: a live screenshot of the
 * winner taken the moment they won, replaced by the next winner. Unlike the
 * painting beside it this is not clickable — it is earned, not uploaded.
 *
 * The whole frame belongs to the game, so it disappears with it: an office
 * that never plays shows a plain wall rather than an empty award frame.
 */
export function EotmFrame({ position }: { position: [number, number, number] }) {
  const enabled = useStore((s) => s.quiz?.enabled ?? false);
  const photo = useStore((s) => s.quiz?.photo);
  // primitives, not the object: the quiz state arrives as a fresh object on every broadcast
  const v = photo?.v;
  const name = photo?.name ?? '';
  // called before the early returns below to keep hook order stable across
  // enable/disable; the texture is a 512×96 canvas, so holding it while the
  // game is off costs nothing worth branching for
  const caption = useCaptionTexture(name);

  if (!enabled) return null;

  if (!v) {
    // no winner yet: an empty frame, so the wall doesn't have a hole in it
    return (
      <group position={position}>
        <mesh castShadow>
          <boxGeometry args={[EOTM_W + 0.16, EOTM_H + EOTM_CAPTION_H + 0.16, 0.06]} />
          <meshStandardMaterial color="#2b2418" roughness={0.5} />
        </mesh>
        <mesh position={[0, -(EOTM_H + EOTM_CAPTION_H) / 2 + EOTM_CAPTION_H / 2, 0.035]}>
          <planeGeometry args={[EOTM_W, EOTM_CAPTION_H]} />
          <meshStandardMaterial map={caption} roughness={0.8} />
        </mesh>
      </group>
    );
  }
  return <EotmPhotoFrame position={position} v={v} caption={caption} />;
}

/** Split out so `useTexture` (which suspends) never mounts without a photo to load. */
function EotmPhotoFrame({
  position,
  v,
  caption,
}: {
  position: [number, number, number];
  v: number;
  caption: THREE.CanvasTexture;
}) {
  const texture = useTexture(`/api/decor/eotm?v=${v}`);

  useEffect(() => {
    const img = texture.image as { width?: number; height?: number } | undefined;
    if (!img?.width || !img?.height) return;
    // cover-fit, same maths as the painting: a screenshot is never the frame's aspect
    const { repeat, offset } = wallArtTransform(img.width / img.height, EOTM_W / EOTM_H, 1, 0);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
    texture.offset.set(offset[0], offset[1]);
    texture.needsUpdate = true;
  }, [texture]);

  const framePos = useMemo(
    () => [0, (EOTM_H + EOTM_CAPTION_H) / 2 - EOTM_H / 2, 0.035] as [number, number, number],
    [],
  );

  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[EOTM_W + 0.16, EOTM_H + EOTM_CAPTION_H + 0.16, 0.06]} />
        <meshStandardMaterial color="#2b2418" roughness={0.5} />
      </mesh>
      <mesh position={framePos}>
        <planeGeometry args={[EOTM_W, EOTM_H]} />
        <meshStandardMaterial map={texture} roughness={0.9} />
      </mesh>
      <mesh position={[0, -(EOTM_H + EOTM_CAPTION_H) / 2 + EOTM_CAPTION_H / 2, 0.035]}>
        <planeGeometry args={[EOTM_W, EOTM_CAPTION_H]} />
        <meshStandardMaterial map={caption} roughness={0.8} />
      </mesh>
    </group>
  );
}
