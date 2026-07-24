import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { seatTransform, whiteboardTransform } from './layout.ts';

export interface Pov {
  label: string;
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

/** Over-shoulder POV for a seat: behind the character's head, looking at the screen. */
function seatPov(seat: number, label: string): Pov {
  const { position, rotationY } = seatTransform(seat);
  const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  // character sits at forward*-1.35; hover behind their right shoulder
  const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const camPos = position
    .clone()
    .add(forward.clone().multiplyScalar(-2.6))
    .add(right.multiplyScalar(1.05))
    .add(new THREE.Vector3(0, 3.05, 0));
  const target = position.clone().add(forward.clone().multiplyScalar(0.35)).add(new THREE.Vector3(0, 1.6, 0));
  return { label, position: camPos, lookAt: target };
}

export function usePovList(): Pov[] {
  const office = useStore((s) => s.office);
  return useMemo(() => {
    const povs: Pov[] = [seatPov(0, office?.boss.name ?? 'Boss')];
    for (const e of office?.employees ?? []) povs.push(seatPov(e.seat, e.name));
    const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
    const wb = whiteboardTransform(maxSeat);
    povs.push({ label: 'Whiteboard', position: wb.camera, lookAt: wb.lookAt });
    return povs;
  }, [office]);
}

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyC', 'Space']);
const MODIFIER_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);
const FLY_SPEED = 7; // units/sec
const SLOW_MULTIPLIER = 0.25; // while Shift/Ctrl held
const LOOK_SENSITIVITY = 0.0022; // rad per px of mouse movement
const MAX_PITCH = Math.PI / 2 - 0.01;
// Pointer lock can emit one giant bogus delta when the hidden OS cursor warps
// (WSLg/Wayland screen edge, or right after acquiring the lock). A real flick
// coalesced at ~60Hz stays around 100px/event, so anything past this is noise.
const MAX_LOOK_DELTA = 200;

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

/** FPS-spectator fly camera: click to capture the mouse, WASD to fly, E/Space/C up/down. */
function FreeFlyControls() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const keys = useRef(new Set<string>());
  const velocity = useRef(new THREE.Vector3());
  // Yaw/pitch are the source of truth while flying; deriving them back from the
  // quaternion every event is unstable near straight up/down (yaw snaps).
  const look = useRef({ yaw: 0, pitch: 0 });

  useEffect(() => {
    // sync once from wherever the POV tour (or initial camera) left us
    tmpEuler.setFromQuaternion(camera.quaternion);
    look.current.yaw = tmpEuler.y;
    look.current.pitch = THREE.MathUtils.clamp(tmpEuler.x, -MAX_PITCH, MAX_PITCH);

    const dom = gl.domElement;
    const onPointerDown = () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== dom) return;
      if (Math.abs(e.movementX) > MAX_LOOK_DELTA || Math.abs(e.movementY) > MAX_LOOK_DELTA) {
        console.debug('[fly-cam] discarded pointer-lock spike', e.movementX, e.movementY);
        return;
      }
      look.current.yaw -= e.movementX * LOOK_SENSITIVITY;
      look.current.pitch = THREE.MathUtils.clamp(look.current.pitch - e.movementY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
      tmpEuler.set(look.current.pitch, look.current.yaw, 0);
      camera.quaternion.setFromEuler(tmpEuler);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (MOVE_KEYS.has(e.code)) {
        keys.current.add(e.code);
        e.preventDefault();
      } else if (MODIFIER_KEYS.has(e.code)) {
        keys.current.add(e.code);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onBlur = () => keys.current.clear();
    dom.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      keys.current.clear();
      if (document.pointerLockElement === dom) document.exitPointerLock();
    };
  }, [camera, gl]);

  useFrame((_, delta) => {
    const k = keys.current;
    camera.getWorldDirection(tmpDir);
    tmpRight.crossVectors(tmpDir, UP).normalize();
    tmpWish.set(0, 0, 0);
    if (k.has('KeyW')) tmpWish.add(tmpDir);
    if (k.has('KeyS')) tmpWish.sub(tmpDir);
    if (k.has('KeyD')) tmpWish.add(tmpRight);
    if (k.has('KeyA')) tmpWish.sub(tmpRight);
    if (k.has('KeyE') || k.has('Space')) tmpWish.y += 1;
    if (k.has('KeyC')) tmpWish.y -= 1;
    if (tmpWish.lengthSq() > 0) tmpWish.normalize();
    const slow = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('ControlLeft') || k.has('ControlRight');
    tmpWish.multiplyScalar(FLY_SPEED * (slow ? SLOW_MULTIPLIER : 1));
    // exponential smoothing so starts/stops feel weighty rather than instant
    velocity.current.lerp(tmpWish, 1 - Math.exp(-delta * 12));
    camera.position.addScaledVector(velocity.current, delta);
  });

  return null;
}

export function CameraRig() {
  const mode = useStore((s) => s.cameraMode);
  const povs = usePovList();
  const camera = useThree((s) => s.camera);
  const lookTarget = useRef(new THREE.Vector3(0, 1, 0));

  const free = mode.kind === 'free';

  useFrame((_, delta) => {
    if (free) return;
    const pov = povs[Math.min((mode as { kind: 'pov'; index: number }).index, povs.length - 1)];
    if (!pov) return;
    const k = 1 - Math.exp(-delta * 4.5);
    camera.position.lerp(pov.position, k);
    lookTarget.current.lerp(pov.lookAt, k);
    camera.lookAt(lookTarget.current);
  });

  return free ? <FreeFlyControls /> : null;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpWish = new THREE.Vector3();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
