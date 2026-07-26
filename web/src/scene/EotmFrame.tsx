import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { enterFocusMode, useStore, type CameraPose } from '../store.ts';
import { wallArtTransform } from './wallArtTexture.ts';
import { captionLines, EOTM_KEY, EOTM_W, EOTM_H, EOTM_CAPTION_H } from './eotmTexture.ts';

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
    // sized to fill the plaque: from across the room this is a 1.42 × 0.26 u
    // strip, so every spare pixel of glyph height is legibility
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillText(title, CAPTION_PX_W / 2, 30);
    ctx.font = 'bold 46px system-ui, sans-serif';
    ctx.fillText(who, CAPTION_PX_W / 2, 82);
    texture.needsUpdate = true;
  }, [canvas, texture, name]);

  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/**
 * Click-to-focus, the same gesture the monitors and the TV use: the camera flies
 * out to frame the whole frame — photo and plaque — and the next click anywhere
 * glides it back. Unlike the painting beside it, a click never *changes* this
 * one: the photo is earned, not uploaded.
 */
function useFocusFrame() {
  const gl = useThree((s) => s.gl);

  const focus = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (e.button !== 0) return; // right-drag aims the camera; it must not park it here
      // while pointer-locked, clicks steer the fly cam — never steal them
      if (document.pointerLockElement) return;
      // in build mode a click drags the frame along the wall, never focuses
      if (useStore.getState().buildMode) return;
      e.stopPropagation();
      const st = useStore.getState();
      const cur = st.cameraMode;
      if (cur.kind === 'focus' && cur.target === EOTM_KEY) return;
      const pose: CameraPose = {
        position: e.camera.position.toArray() as [number, number, number],
        quaternion: e.camera.quaternion.toArray() as [number, number, number, number],
      };
      gl.domElement.style.cursor = '';
      st.setCameraMode(enterFocusMode(cur, EOTM_KEY, pose));
    },
    [gl],
  );

  const hoverStart = useCallback(() => {
    if (document.pointerLockElement) return; // crosshair raycast owns hover while flying
    if (useStore.getState().buildMode) return; // build mode's own cursor feedback wins
    useStore.getState().setMonitorHover(EOTM_KEY);
    gl.domElement.style.cursor = 'pointer';
  }, [gl]);

  const hoverEnd = useCallback(() => {
    const st = useStore.getState();
    if (st.monitorHover === EOTM_KEY) st.setMonitorHover(null);
    gl.domElement.style.cursor = '';
  }, [gl]);

  // `userData.monitorTarget` is what the fly cam's crosshair raycast picks up
  // (pickMonitorTarget), so the frame is clickable in first person too.
  return {
    userData: { monitorTarget: EOTM_KEY },
    onPointerDown: focus,
    onPointerEnter: hoverStart,
    onPointerLeave: hoverEnd,
  };
}

/**
 * The Employee of the Month photo behind the boss: a live screenshot of the
 * winner taken the moment they won, under a plaque naming them, replaced by the
 * next winner.
 *
 * The whole frame belongs to the game, so it disappears with it: an office
 * that never plays shows a plain wall rather than an empty award frame.
 */
/** How far the frame stands off the wall plane (its old +z offset). */
const EOTM_STANDOFF = 0.05;
/** Plaque centre, measured down from the middle of the whole frame. */
const CAPTION_Y = -(EOTM_H + EOTM_CAPTION_H) / 2 + EOTM_CAPTION_H / 2;

export function EotmFrame() {
  const enabled = useStore((s) => s.quiz?.enabled ?? false);
  const photo = useStore((s) => s.quiz?.photo);
  // primitives, not the object: the quiz state arrives as a fresh object on every broadcast
  const v = photo?.v;
  const name = photo?.name ?? '';
  // called before the early returns below to keep hook order stable across
  // enable/disable; the texture is a 512×96 canvas, so holding it while the
  // game is off costs nothing worth branching for
  const caption = useCaptionTexture(name);
  const handlers = useFocusFrame();

  if (!enabled) return null;

  if (!v) {
    // no winner yet: an empty frame, so the wall doesn't have a hole in it
    return (
      <group position={[0, 0, EOTM_STANDOFF]}>
        <mesh castShadow {...handlers}>
          <boxGeometry args={[EOTM_W + 0.16, EOTM_H + EOTM_CAPTION_H + 0.16, 0.06]} />
          <meshStandardMaterial color="#2b2418" roughness={0.5} />
        </mesh>
        <mesh position={[0, CAPTION_Y, 0.035]} {...handlers}>
          <planeGeometry args={[EOTM_W, EOTM_CAPTION_H]} />
          <meshStandardMaterial map={caption} roughness={0.8} />
        </mesh>
      </group>
    );
  }
  return <EotmPhotoFrame v={v} caption={caption} handlers={handlers} />;
}

/** Split out so `useTexture` (which suspends) never mounts without a photo to load. */
function EotmPhotoFrame({
  v,
  caption,
  handlers,
}: {
  v: number;
  caption: THREE.CanvasTexture;
  handlers: ReturnType<typeof useFocusFrame>;
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
    <group position={[0, 0, EOTM_STANDOFF]}>
      <mesh castShadow {...handlers}>
        <boxGeometry args={[EOTM_W + 0.16, EOTM_H + EOTM_CAPTION_H + 0.16, 0.06]} />
        <meshStandardMaterial color="#2b2418" roughness={0.5} />
      </mesh>
      <mesh position={framePos} {...handlers}>
        <planeGeometry args={[EOTM_W, EOTM_H]} />
        <meshStandardMaterial map={texture} roughness={0.9} />
      </mesh>
      <mesh position={[0, CAPTION_Y, 0.035]} {...handlers}>
        <planeGeometry args={[EOTM_W, EOTM_CAPTION_H]} />
        <meshStandardMaterial map={caption} roughness={0.8} />
      </mesh>
    </group>
  );
}
