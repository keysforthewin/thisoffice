import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { enterFocusMode, useStore, type CameraPose } from '../store.ts';
import { whiteboardTransform, statusBoardTransform } from './layout.ts';
import { resolveSeat } from './buildLayout.ts';
import type { OfficeLayout, OfficeState, QuizWinner } from '../../../shared/types.ts';
import { MovieCamera } from './MovieCamera.tsx';
import { clampToRoom, fitDistance, subjectFor } from './movieShots.ts';
import { clampOffset, wrapLines } from './monitorScrollback.ts';
import { pickMonitorTarget } from './monitorPicking.ts';
import { bossScreenLines } from './bossScreen.ts';
import { MONITOR_COLS, MONITOR_ROWS } from './MonitorScreen.tsx';
import { pickWallArtImage, reframeWallArt } from '../wallArt.ts';
import { clampPan, clampZoom } from './wallArtTexture.ts';
import { askerAnchor } from '../quiz/askerAnchor.ts';
import { photoShot } from '../quiz/photoShot.ts';
import { captureCanvas, PHOTO_FLY_MS, PHOTO_HOLD_MS } from '../quiz/capture.ts';
import { uploadEotmPhoto } from '../quiz/quizApi.ts';

export interface Pov {
  label: string;
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

/** Over-shoulder POV for a seat: behind the character's head, looking at the screen. */
function seatPov(seat: number, label: string, layout: OfficeLayout | undefined, maxSeat: number): Pov {
  const { position, rotationY } = resolveSeat(layout, seat, maxSeat);
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

/**
 * Pure list builder — no hooks — so it (and therefore the POV cycle count) can be
 * unit-tested without a React/DOM harness. `usePovList` below is a thin memoized
 * wrapper; App.tsx's Tab/ArrowLeft cycling must derive its modulo from this same
 * list (`usePovList().length`) rather than a hand-maintained count, or an added
 * spot silently becomes unreachable.
 */
export function buildPovList(office: OfficeState | null): Pov[] {
  const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
  const povs: Pov[] = [seatPov(0, office?.boss.name ?? 'Boss', office?.layout, maxSeat)];
  for (const e of office?.employees ?? []) povs.push(seatPov(e.seat, e.name, office?.layout, maxSeat));
  const wb = whiteboardTransform(maxSeat);
  povs.push({ label: 'Whiteboard', position: wb.camera, lookAt: wb.lookAt });
  const sb = statusBoardTransform(maxSeat);
  povs.push({ label: 'Status Board', position: sb.camera, lookAt: sb.lookAt });
  // tv is a draggable wall item, so its spot comes from the same layout-aware
  // subject the movie camera uses rather than a fixed transform.
  const tv = subjectFor('tv', office);
  if (tv) povs.push({ label: 'Stats TV', position: tv.center.clone().addScaledVector(tv.normal, 3.4), lookAt: tv.center.clone() });
  return povs;
}

export function usePovList(): Pov[] {
  const office = useStore((s) => s.office);
  return useMemo(() => buildPovList(office), [office]);
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

interface Glide {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** FPS-spectator fly camera: click to capture the mouse, WASD to fly, E/Space/C up/down. */
function FreeFlyControls({ glide }: { glide: React.MutableRefObject<Glide | null> }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const raycaster = useRef(new THREE.Raycaster());
  const keys = useRef(new Set<string>());
  const velocity = useRef(new THREE.Vector3());
  // what the screen-center crosshair is aimed at while pointer-locked
  const crosshairTarget = () => {
    raycaster.current.setFromCamera(CENTER_NDC, camera);
    return pickMonitorTarget(raycaster.current.intersectObjects(scene.children, true));
  };
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
      const st = useStore.getState();
      // a monitor click may have flipped us into focus mode on this same event
      // (R3F's canvas handler runs first) — don't grab the pointer on the way out
      if (st.cameraMode.kind !== 'free') return;
      if (document.pointerLockElement === dom) {
        // first-person: the crosshair is the cursor
        const target = crosshairTarget();
        if (target === 'wallArt') {
          // the painting isn't a focus subject — a click hangs a new picture,
          // and the file dialog needs the pointer back
          document.exitPointerLock();
          pickWallArtImage();
          return;
        }
        if (target) {
          const pose: CameraPose = {
            position: camera.position.toArray() as [number, number, number],
            quaternion: camera.quaternion.toArray() as [number, number, number, number],
          };
          st.setCameraMode(enterFocusMode(st.cameraMode, target, pose, true));
        }
        return;
      }
      // the return glide (or a focus visit) may have reoriented the camera
      // since mount — resync so the first mouse move continues from this view
      tmpEuler.setFromQuaternion(camera.quaternion);
      look.current.yaw = tmpEuler.y;
      look.current.pitch = THREE.MathUtils.clamp(tmpEuler.x, -MAX_PITCH, MAX_PITCH);
      // Chrome returns a promise that rejects without user activation — harmless, but noisy
      (dom.requestPointerLock() as unknown as Promise<void> | undefined)?.catch(() => {});
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== dom) return;
      if (Math.abs(e.movementX) > MAX_LOOK_DELTA || Math.abs(e.movementY) > MAX_LOOK_DELTA) {
        console.debug('[fly-cam] discarded pointer-lock spike', e.movementX, e.movementY);
        return;
      }
      if (glide.current) {
        // locked mouse-look takes over from a running return glide: pick up
        // from wherever the slerp left the camera instead of snapping back
        glide.current = null;
        tmpEuler.setFromQuaternion(camera.quaternion);
        look.current.yaw = tmpEuler.y;
        look.current.pitch = THREE.MathUtils.clamp(tmpEuler.x, -MAX_PITCH, MAX_PITCH);
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
      useStore.getState().setMonitorHover(null);
    };
  }, [camera, gl]);

  // Focus exit wants first person back (the entry click was pointer-locked).
  // The Escape/click that exited counts as fresh user activation, so the
  // request usually succeeds; if the browser rejects it, the flag stays armed
  // and the next onPointerDown lock clears it via the lockchange listener.
  useEffect(() => {
    const dom = gl.domElement;
    const onLockChange = () => {
      if (document.pointerLockElement === dom) useStore.getState().setPendingRelock(false);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    if (useStore.getState().pendingRelock) {
      tmpEuler.setFromQuaternion(camera.quaternion);
      look.current.yaw = tmpEuler.y;
      look.current.pitch = THREE.MathUtils.clamp(tmpEuler.x, -MAX_PITCH, MAX_PITCH);
      (dom.requestPointerLock() as unknown as Promise<void> | undefined)?.catch(() => {});
    }
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [camera, gl]);

  useFrame((_, delta) => {
    // a winner's photo owns the camera for its fly+hold — don't fight it with WASD motion
    if (useStore.getState().pendingCapture) return;
    // while locked the cursor is hidden — hover tracking moves to the crosshair
    if (document.pointerLockElement === gl.domElement) {
      useStore.getState().setMonitorHover(crosshairTarget());
    }
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
    clampToRoom(camera.position, useStore.getState().office);
  });

  return null;
}

/** Margin for the focus framing: screen nearly fills the frame. */
const FOCUS_FIT_MARGIN = 1.1;
const SCROLL_ROWS_PER_TICK = 3;

/**
 * Wheel → scrollback while the camera is parked on a monitor. Employees scroll
 * their clear-surviving history buffer; the boss scrolls the full inbox log;
 * the stats TV pages through its stat pages (±1 per tick, wrapping).
 */
function FocusControls({ target }: { target: string }) {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    // race guard: entering focus from a pointer-locked fly cam
    if (document.pointerLockElement) document.exitPointerLock();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = useStore.getState();
      if (target === 'tv') {
        // signed page offset — tvContent wraps it, so no clamping
        st.setFocusScroll(st.focusScroll + (e.deltaY > 0 ? 1 : -1));
        return;
      }
      const raw = target === 'boss' ? bossScreenLines(st.office?.inbox ?? []) : (st.monitorHistory[target] ?? []);
      const total = wrapLines(raw, MONITOR_COLS).length;
      const step = e.deltaY < 0 ? SCROLL_ROWS_PER_TICK : -SCROLL_ROWS_PER_TICK;
      st.setFocusScroll(clampOffset(st.focusScroll + step, total, MONITOR_ROWS));
    };
    const dom = gl.domElement;
    dom.addEventListener('wheel', onWheel, { passive: false });
    return () => dom.removeEventListener('wheel', onWheel);
  }, [gl, target]);

  return null;
}

/**
 * Runs only when the server asked THIS client for the winner's photo: fly to the
 * group shot, hold a beat, shoot, upload, fly back. Failure is silent by design —
 * the server's photo timeout credits the win regardless.
 *
 * Office state is read once via `useStore.getState()` rather than subscribed to:
 * a subscription would re-run this effect (and restart the fly-in) on every
 * unrelated broadcast that arrives during the ~1.6s capture window.
 */
function PhotoControls({ winner, maxSeat }: { winner: QuizWinner; maxSeat: number }) {
  const { camera, gl, scene } = useThree();

  useEffect(() => {
    const office = useStore.getState().office;
    const employee = office?.employees.find((e) => e.name === winner.name);
    const askerId = office?.boss.name === winner.name ? 'boss' : employee ? employee.id : 'catPerson';
    const seat = employee ? employee.seat : null;
    const anchor = office ? askerAnchor(askerId, seat, { layout: office.layout }, maxSeat) : null;
    if (!anchor) {
      useStore.getState().clearPendingCapture();
      return;
    }
    const subject = new THREE.Vector3(anchor[0], 0, anchor[2]);
    const shot = photoShot(subject, maxSeat);
    const from = camera.position.clone();
    const fromQuat = camera.quaternion.clone();
    const perspective = camera as THREE.PerspectiveCamera;
    const baseFov = perspective.fov;

    // target orientation, computed once by parking a scratch camera at the shot
    const scratch = perspective.clone();
    scratch.position.copy(shot.position);
    scratch.lookAt(shot.lookAt);
    const toQuat = scratch.quaternion.clone();

    let raf = 0;
    let holdTimer = 0;
    const t0 = performance.now();
    let shooting = false;
    // guards the hold-timer callback: setTimeout isn't cancelled by unmount
    // the way rAF is, so without this an unmount during the hold beat (the
    // server's timeout or another tab finishing first) would still fire the
    // capture/upload against whatever the camera looks at post-restore
    let cancelled = false;

    const restore = () => {
      camera.position.copy(from);
      camera.quaternion.copy(fromQuat);
      perspective.fov = baseFov;
      perspective.updateProjectionMatrix();
    };

    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / PHOTO_FLY_MS);
      const e = t * t * (3 - 2 * t); // smoothstep
      camera.position.lerpVectors(from, shot.position, e);
      camera.quaternion.slerpQuaternions(fromQuat, toQuat, e);
      perspective.fov = THREE.MathUtils.lerp(baseFov, shot.fov, e);
      perspective.updateProjectionMatrix();
      if (t < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (shooting) return;
      shooting = true;
      holdTimer = window.setTimeout(() => {
        if (cancelled) return;
        void captureCanvas(gl, scene, camera)
          .then(uploadEotmPhoto)
          .catch(() => {})
          .finally(() => {
            if (cancelled) return;
            restore();
            useStore.getState().clearPendingCapture();
          });
      }, PHOTO_HOLD_MS);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(holdTimer);
      // covers unmount mid-flight or mid-hold (pendingCapture cleared
      // externally) as well as the normal capture-then-clear path above —
      // restoring twice there is harmless.
      restore();
    };
    // one effect per capture request; `winner` identity is the trigger
  }, [winner, maxSeat, camera, gl, scene]);

  return null;
}

export function CameraRig() {
  const mode = useStore((s) => s.cameraMode);
  const buildMode = useStore((s) => s.buildMode);
  const wallArtHover = useStore((s) => s.wallArtHover);
  const pendingCapture = useStore((s) => s.pendingCapture);
  const povs = usePovList();
  const office = useStore((s) => s.office);
  const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const lookTarget = useRef(new THREE.Vector3(0, 1, 0));
  const prevMode = useRef(mode);
  /** while set, the free camera is flying back to where it was before a monitor click */
  const glide = useRef<Glide | null>(null);

  const free = mode.kind === 'free';

  useEffect(() => {
    const prev = prevMode.current;
    prevMode.current = mode;
    if (prev.kind === 'focus' && mode.kind === 'free' && prev.returnPose) {
      glide.current = {
        position: new THREE.Vector3().fromArray(prev.returnPose.position),
        quaternion: new THREE.Quaternion().fromArray(prev.returnPose.quaternion),
      };
    } else if (mode.kind !== 'free') {
      glide.current = null;
    }
  }, [mode]);

  // the glide is a convenience, never a cage: any deliberate input takes over
  useEffect(() => {
    const cancel = () => (glide.current = null);
    window.addEventListener('pointerdown', cancel);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('keydown', cancel);
    };
  }, []);

  const focusPose = useMemo(() => {
    if (mode.kind !== 'focus') return null;
    const subject = subjectFor(mode.target, office);
    if (!subject) return null;
    const fovY = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
    const dist = fitDistance(subject.width, subject.height, fovY, size.width / size.height, FOCUS_FIT_MARGIN);
    const position = clampToRoom(subject.center.clone().addScaledVector(subject.normal, dist), office);
    return { position, lookAt: subject.center };
  }, [mode, office, camera, size]);

  // focused employee evicted mid-view → fall back to wherever we came from
  useEffect(() => {
    if (mode.kind === 'focus' && !focusPose) useStore.getState().setCameraMode(mode.from);
  }, [mode, focusPose]);

  useFrame((_, delta) => {
    // a winner's photo owns the camera for its fly+hold: freeze pov/focus/glide
    // lerps in place rather than fighting PhotoControls' own rAF writes for the
    // same camera object. Nothing here needs unwinding on resume — lerping
    // toward the same `pose`/`glide` target just continues where it left off.
    if (pendingCapture) return;
    if (mode.kind === 'free' && glide.current) {
      const g = glide.current;
      const k = 1 - Math.exp(-delta * 4.5);
      camera.position.lerp(g.position, k);
      camera.quaternion.slerp(g.quaternion, k);
      if (camera.position.distanceTo(g.position) < 0.02 && camera.quaternion.angleTo(g.quaternion) < 0.005) {
        camera.position.copy(g.position);
        camera.quaternion.copy(g.quaternion);
        glide.current = null;
      }
      return;
    }
    let pose: { position: THREE.Vector3; lookAt: THREE.Vector3 } | null = null;
    if (mode.kind === 'pov') {
      pose = povs[Math.min(mode.index, povs.length - 1)] ?? null;
    } else if (mode.kind === 'focus') {
      pose = focusPose;
    }
    if (!pose) return;
    const k = 1 - Math.exp(-delta * 4.5);
    camera.position.lerp(pose.position, k);
    lookTarget.current.lerp(pose.lookAt, k);
    camera.lookAt(lookTarget.current);
  });

  const controls =
    mode.kind === 'movie' ? (
      <MovieCamera />
    ) : mode.kind === 'focus' ? (
      <FocusControls target={mode.target} />
    ) : // build mode: camera holds still, cursor drags objects — unmounting the fly
    // controls also releases any pointer lock via their cleanup
    free && !buildMode ? (
      <FreeFlyControls glide={glide} />
    ) : null;

  return (
    <>
      {wallArtHover && <WallArtControls />}
      {pendingCapture && <PhotoControls winner={pendingCapture} maxSeat={maxSeat} />}
      {controls}
    </>
  );
}

/**
 * Wheel → reframe the painting, while the cursor is over it. Mounted only on
 * hover, so it never competes with FocusControls' own wheel listener.
 *
 * This has to be a native non-passive listener rather than an R3F `onWheel`
 * prop: ctrl+wheel is the browser's page-zoom gesture, and only
 * `preventDefault` on a non-passive listener suppresses it.
 */
function WallArtControls() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const art = useStore.getState().office?.wallArt;
      if (!art) return; // the built-in artwork has no framing to change
      e.preventDefault();
      if (e.ctrlKey) {
        reframeWallArt({ panX: clampPan(art.panX + (e.deltaY > 0 ? PAN_PER_TICK : -PAN_PER_TICK)) });
      } else {
        reframeWallArt({ zoom: clampZoom(art.zoom * (e.deltaY > 0 ? 1 / ZOOM_PER_TICK : ZOOM_PER_TICK)) });
      }
    };
    const dom = gl.domElement;
    dom.addEventListener('wheel', onWheel, { passive: false });
    return () => dom.removeEventListener('wheel', onWheel);
  }, [gl]);

  return null;
}

const ZOOM_PER_TICK = 1.12;
const PAN_PER_TICK = 0.08;

const UP = new THREE.Vector3(0, 1, 0);
const CENTER_NDC = new THREE.Vector2(0, 0);
const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpWish = new THREE.Vector3();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
