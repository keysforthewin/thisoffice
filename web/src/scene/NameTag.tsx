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

/**
 * Occlusion is the most expensive thing in the scene — nine raycasts per tag —
 * and it does not need to run at frame rate: the opacity damp below still runs
 * every frame, so a result that lands up to CHECK_MS late fades in smoothly
 * rather than popping. Each tag also starts at a random phase so a roomful of
 * them doesn't spike the same frame.
 */
const CHECK_MS = 100;
/** Past this the pill is a couple of pixels tall; skip the check and hide it. */
const MAX_TAG_DISTANCE = 26;

const _camPos = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
/** One frustum build per frame shared by every tag, not one per tag. */
let _frustumFrame = -1;

function cameraFrustum(camera: THREE.Camera, frame: number): THREE.Frustum {
  if (frame !== _frustumFrame) {
    _frustumFrame = frame;
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
  }
  return _frustum;
}

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
  // last occlusion result, held between checks; the fade reads this every frame
  const shown = useRef(1);
  const nextCheck = useRef(Math.random() * CHECK_MS);

  // All-or-nothing occlusion: show the tag only when the whole quad has a
  // clear line from the camera past everything except characters (which
  // opt out of raycasting — see NO_RAYCAST in Person.tsx). The material
  // ignores depth, so a visible tag draws through characters in front of it.
  useFrame(({ camera, scene, clock }, delta) => {
    if (!sprite.current || !material.current) return;

    nextCheck.current -= delta * 1000;
    if (nextCheck.current <= 0) {
      nextCheck.current += CHECK_MS;
      sprite.current.getWorldPosition(center);
      camera.getWorldPosition(_camPos);

      // Cheap rejects before the raycasts: a tag that is off-screen or far
      // enough to be illegible never needs an occlusion test.
      const frame = clock.elapsedTime;
      if (
        center.distanceTo(_camPos) > MAX_TAG_DISTANCE ||
        !cameraFrustum(camera, frame).containsPoint(center)
      ) {
        shown.current = 0;
      } else {
        camera.getWorldQuaternion(_camQuat);
        shown.current = isTagFullyVisible(
          scene,
          _camPos,
          _camQuat,
          center,
          scale[0],
          scale[1],
          ignore,
          clock.elapsedTime * 1000
        )
          ? 1
          : 0;
      }
    }

    // Fast fade instead of a hard toggle so borderline angles don't flicker.
    opacity.current = THREE.MathUtils.damp(opacity.current, shown.current, 25, delta);
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
