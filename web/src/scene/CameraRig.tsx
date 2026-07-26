import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { enterFocusMode, useStore, type CameraPose } from '../store.ts';
import { resolveSeat } from './buildLayout.ts';
import type { OfficeLayout, OfficeState, QuizWinner } from '../../../shared/types.ts';
import { MovieCamera } from './MovieCamera.tsx';
import { clampToRoom, fitDistance, subjectFor } from './movieShots.ts';
import { clampOffset, wrapLines } from './monitorScrollback.ts';
import { pickMonitorTarget } from './monitorPicking.ts';
import { bossScreenLines } from './bossScreen.ts';
import { MONITOR_COLS, MONITOR_ROWS } from './MonitorScreen.tsx';
import { EOTM_KEY } from './eotmTexture.ts';
import { pickWallArtImage, reframeWallArt } from '../wallArt.ts';
import { clampPan, clampZoom } from './wallArtTexture.ts';
import { askerAnchor, askerPose } from '../quiz/askerAnchor.ts';
import { photoShot } from '../quiz/photoShot.ts';
import { facePoint } from '../quiz/facePoint.ts';
import { captureCanvas, PHOTO_FLY_MS, PHOTO_HOLD_MS, PHOTO_LINGER_MS } from '../quiz/capture.ts';
import { uploadEotmPhoto } from '../quiz/quizApi.ts';
import { applyLook, modeForDragLook, MAX_LOOK_DELTA, MAX_PITCH, type Look } from './dragLook.ts';

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
  // Every wall surface is draggable — to any wall, at any height — so all three
  // spots come from the same layout-aware subject the movie camera uses. A fixed
  // transform would keep aiming at the wall a board used to hang on.
  for (const [key, label, back] of [
    ['whiteboard', 'Whiteboard', 4.2],
    ['statusboard', 'Status Board', 4.2],
    ['tv', 'Stats TV', 3.4],
  ] as const) {
    const s = subjectFor(key, office);
    if (s) povs.push({ label, position: s.center.clone().addScaledVector(s.normal, back), lookAt: s.center.clone() });
  }
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

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

interface Glide {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Read the camera's current aim back into yaw/pitch, for a look gesture starting now. */
function readLook(camera: THREE.Camera): Look {
  tmpEuler.setFromQuaternion(camera.quaternion);
  return { yaw: tmpEuler.y, pitch: THREE.MathUtils.clamp(tmpEuler.x, -MAX_PITCH, MAX_PITCH) };
}

function aimCamera(camera: THREE.Camera, look: Look) {
  tmpEuler.set(look.pitch, look.yaw, 0);
  camera.quaternion.setFromEuler(tmpEuler);
}

/**
 * WASD/E/C flight, independent of how the view is being *aimed* — the
 * pointer-locked fly cam and build mode's right-drag look share it, so
 * flying around while rearranging furniture works the same as outside it.
 */
function useFlyMotion() {
  const camera = useThree((s) => s.camera);
  const keys = useRef(new Set<string>());
  const velocity = useRef(new THREE.Vector3());

  useEffect(() => {
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      keys.current.clear();
    };
  }, []);

  useFrame((_, delta) => {
    // a winner's photo owns the camera for its fly+hold — don't fight it with WASD motion
    if (useStore.getState().pendingCapture) return;
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
}

/** Build mode: the cursor belongs to the furniture, so flight loses its mouse-look
 *  (right-drag covers that) but keeps the keyboard. */
function BuildFlyControls() {
  useFlyMotion();
  return null;
}

/** FPS-spectator fly camera: click to capture the mouse, WASD to fly, E/Space/C up/down. */
function FreeFlyControls({ glide }: { glide: React.MutableRefObject<Glide | null> }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const raycaster = useRef(new THREE.Raycaster());
  // what the screen-center crosshair is aimed at while pointer-locked
  const crosshairTarget = () => {
    raycaster.current.setFromCamera(CENTER_NDC, camera);
    return pickMonitorTarget(raycaster.current.intersectObjects(scene.children, true));
  };
  const look = useRef<Look>({ yaw: 0, pitch: 0 });
  useFlyMotion();

  useEffect(() => {
    // sync once from wherever the POV tour (or initial camera) left us
    look.current = readLook(camera);

    const dom = gl.domElement;
    const onPointerDown = (e: PointerEvent) => {
      // right-drag is DragLookControls' gesture; grabbing the pointer lock here
      // would hide the cursor mid-drag and double up on the mouse-look
      if (e.button !== 0) return;
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
      look.current = readLook(camera);
      // Chrome returns a promise that rejects without user activation — harmless, but noisy
      (dom.requestPointerLock() as unknown as Promise<void> | undefined)?.catch(() => {});
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== dom) return;
      // a winner's photo owns the camera for its fly+hold — don't fight it with mouse-look
      if (useStore.getState().pendingCapture) return;
      if (Math.abs(e.movementX) > MAX_LOOK_DELTA || Math.abs(e.movementY) > MAX_LOOK_DELTA) {
        console.debug('[fly-cam] discarded pointer-lock spike', e.movementX, e.movementY);
        return;
      }
      if (glide.current) {
        // locked mouse-look takes over from a running return glide: pick up
        // from wherever the slerp left the camera instead of snapping back
        glide.current = null;
        look.current = readLook(camera);
      }
      look.current = applyLook(look.current, e.movementX, e.movementY);
      aimCamera(camera, look.current);
    };
    dom.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousemove', onMouseMove);
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
      if (document.pointerLockElement !== dom) return;
      useStore.getState().setPendingRelock(false);
      // the request is async: a right-drag can keep aiming the camera between
      // asking for the lock and getting it, so pick up the view as it is now
      // rather than snapping back to where the request was made
      look.current = readLook(camera);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    if (useStore.getState().pendingRelock) {
      look.current = readLook(camera);
      (dom.requestPointerLock() as unknown as Promise<void> | undefined)?.catch(() => {});
    }
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [camera, gl]);

  useFrame(() => {
    if (useStore.getState().pendingCapture) return;
    // while locked the cursor is hidden — hover tracking moves to the crosshair
    if (document.pointerLockElement === gl.domElement) {
      useStore.getState().setMonitorHover(crosshairTarget());
    }
  });

  return null;
}

/**
 * Right-drag aims the camera, everywhere. This is the only way to look around in
 * build mode (where the cursor belongs to the furniture, so there is no pointer
 * lock), and in pov/focus/movie mode it first drops the camera into free mode at
 * the pose it already holds — otherwise those modes' per-frame lerp toward a
 * computed pose would fight the drag.
 *
 * Mounted unconditionally, because the gesture has to survive the mode change it
 * causes: a component that only mounted for non-free modes would unmount on its
 * own pointerdown and lose the drag.
 */
function DragLookControls({
  glide,
  dragging,
}: {
  glide: React.MutableRefObject<Glide | null>;
  dragging: React.MutableRefObject<boolean>;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const dom = gl.domElement;
    const look = { yaw: 0, pitch: 0 } as Look;
    let pointerId: number | null = null;

    const end = () => {
      if (pointerId !== null) {
        try {
          dom.releasePointerCapture(pointerId);
        } catch {
          /* pointer already gone */
        }
      }
      pointerId = null;
      dragging.current = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 || pointerId !== null) return;
      // pointer-locked mouse-look already owns the mouse; two handlers turning
      // the same deltas into yaw would double the sensitivity
      if (document.pointerLockElement === dom) return;
      // a winner's photo owns the camera for its fly+hold
      if (useStore.getState().pendingCapture) return;
      e.preventDefault();
      pointerId = e.pointerId;
      // set BEFORE the mode change flushes: CameraRig's mode effect reads this to
      // skip the focus→free return glide, which would otherwise fly the camera
      // away from the view being aimed
      dragging.current = true;
      glide.current = null;
      const st = useStore.getState();
      const next = modeForDragLook(st.cameraMode);
      if (next) {
        // land in first person, not one click short of it: the flag is read by
        // FreeFlyControls' mount effect, which grabs the pointer lock on this
        // same gesture's user activation. Set BEFORE the mode change, since
        // that is what mounts the component that reads it.
        st.setPendingRelock(true);
        st.setCameraMode(next);
      }
      const from = readLook(camera);
      look.yaw = from.yaw;
      look.pitch = from.pitch;
      try {
        dom.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic event */
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      // the lock landed mid-drag — first-person mouse-look owns the deltas now,
      // and applying them here too would double the sensitivity
      if (document.pointerLockElement === dom) return;
      if (useStore.getState().pendingCapture) return;
      if (Math.abs(e.movementX) > MAX_LOOK_DELTA || Math.abs(e.movementY) > MAX_LOOK_DELTA) return;
      const next = applyLook(look, e.movementX, e.movementY);
      look.yaw = next.yaw;
      look.pitch = next.pitch;
      aimCamera(camera, look);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId === pointerId) end();
    };
    // the drag itself would otherwise finish by popping the browser menu
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    // the lock hides the cursor, so there is no drag left to run — hand off
    const onLockChange = () => {
      if (document.pointerLockElement === dom) end();
    };

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointercancel', onPointerUp);
    dom.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('blur', end);
    return () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      dom.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('blur', end);
      end();
    };
  }, [camera, gl, glide, dragging]);

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
      // a photo has nothing to scroll: leave the wheel alone rather than
      // swallowing it and driving focusScroll against an empty history
      if (target === EOTM_KEY) return;
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

/** Face height to shoot at when the winner's head bone can't be found in the scene. */
const FALLBACK_FACE_Y = 1.85;
/** How far behind their desk a seated character sits (see PERSON_OFFSET_Z in Desk). */
const SEAT_FACE_BACK = 1.15;

/**
 * Runs only when the server asked THIS client for the winner's photo: fly round
 * to the front of the winner's face, hold a beat, shoot, upload, then linger on
 * them for {@link PHOTO_LINGER_MS} before handing the camera back. Failure is
 * silent by design — the win is credited server-side the moment the guess
 * lands, photo or not.
 *
 * In a hidden tab the fly-in and the linger are both skipped (see below): rAF
 * does not run there, so an animated capture would never fire inside the
 * server's window, and nobody is watching the hold either.
 *
 * Office state is read once via `useStore.getState()` rather than subscribed to:
 * a subscription would re-run this effect (and restart the fly-in) on every
 * unrelated broadcast that arrives during the capture window — of which there
 * is now one guaranteed, since the server answers the upload by broadcasting
 * the new photo while this component is still holding the camera.
 */
function PhotoControls({ winner, maxSeat }: { winner: QuizWinner; maxSeat: number }) {
  const { camera, gl, scene } = useThree();

  useEffect(() => {
    const office = useStore.getState().office;
    // identity rides the protocol (`winner.asker` / `winner.seat`), never a name
    // lookup in the live roster: a winner idle-evicted between the guess and the
    // capture would otherwise fall through to Kat Person and be photographed
    // under someone else's name.
    const pose = office
      ? askerPose(winner.asker, winner.seat, { layout: office.layout, katPerson: office.katPerson }, maxSeat)
      : null;
    if (!pose) {
      useStore.getState().clearPendingCapture();
      return;
    }
    // hold `pendingCapture` past the server's own "photo received" broadcast,
    // which would otherwise unmount this component mid-linger
    useStore.getState().setCaptureHold(true);

    // The face is measured off the animated skeleton, not derived from the seat:
    // see facePoint. The fallback only bites for a character with no head bone.
    // Kat Person is the one asker who is not at a desk — which is also the one
    // thing that decides how far the camera may back off (see photoShot).
    const seated = winner.asker !== 'catPerson';
    const forward = new THREE.Vector3(Math.sin(pose.rotY), 0, Math.cos(pose.rotY));
    const face = facePoint(scene, pose.x, pose.z) ?? {
      point: new THREE.Vector3(pose.x, 0, pose.z)
        .addScaledVector(forward, seated ? -SEAT_FACE_BACK : 0)
        .setY(FALLBACK_FACE_Y),
      size: 0.3,
    };
    const shot = photoShot(face.point, pose.rotY, maxSeat, { headSize: face.size, seated });
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
    let lingerTimer = 0;
    const t0 = performance.now();
    let shooting = false;
    // guards the hold- and linger-timer callbacks: setTimeout isn't cancelled by
    // unmount the way rAF is, so without this an unmount during the hold beat
    // (the server's timeout or another tab finishing first) would still fire the
    // capture/upload against whatever the camera looks at post-restore
    let cancelled = false;

    const restore = () => {
      camera.position.copy(from);
      camera.quaternion.copy(fromQuat);
      perspective.fov = baseFov;
      perspective.updateProjectionMatrix();
    };

    /** Hand the camera back to whatever mode was running before the photo. */
    const release = () => {
      if (cancelled) return;
      restore();
      useStore.getState().clearPendingCapture();
    };

    /**
     * render → toDataURL → POST, then stay on the winner.
     *
     * The shutter is the middle of the shot, not the end of it: the camera holds
     * the portrait for another {@link PHOTO_LINGER_MS} so the room gets a good
     * look at whoever just won, and only then goes back to its rounds. Nothing
     * has to keep the camera there during that hold — every other camera path
     * bails while `pendingCapture` is set — so the linger is a timer, not a loop.
     */
    const shoot = () => {
      if (cancelled) return;
      void captureCanvas(gl, scene, camera)
        .then(uploadEotmPhoto)
        .catch(() => {})
        .finally(() => {
          if (cancelled) return;
          lingerTimer = window.setTimeout(release, PHOTO_LINGER_MS);
        });
    };

    // Browsers pause rAF in a hidden tab, so the fly-in below would never reach
    // t === 1: the shutter would not fire at all, and would then fire on focus —
    // long after the server's 20 s window closed. Nobody is watching a fly-in
    // they cannot see, so jump the camera to the shot and take it now — and skip
    // the linger with it, since it exists purely to be watched.
    if (document.hidden) {
      camera.position.copy(shot.position);
      camera.quaternion.copy(toQuat);
      perspective.fov = shot.fov;
      perspective.updateProjectionMatrix();
      void captureCanvas(gl, scene, camera)
        .then(uploadEotmPhoto)
        .catch(() => {})
        .finally(release);
      return () => {
        cancelled = true;
        useStore.getState().setCaptureHold(false);
        restore();
      };
    }

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
      holdTimer = window.setTimeout(shoot, PHOTO_HOLD_MS);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(holdTimer);
      clearTimeout(lingerTimer);
      // the hold is this component's alone: whatever ends it (the sequence
      // finishing, or an unmount cutting it short) also drops the flag, or a
      // stale hold would pin `pendingCapture` on for good
      useStore.getState().setCaptureHold(false);
      // covers unmount mid-flight, mid-hold or mid-linger as well as the normal
      // capture-then-release path above — restoring twice there is harmless.
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
  /** a right-drag is aiming the camera by hand right now */
  const dragLooking = useRef(false);

  const free = mode.kind === 'free';

  useEffect(() => {
    const prev = prevMode.current;
    prevMode.current = mode;
    // a right-drag out of focus mode is the user taking the camera: gliding it
    // back to the pre-focus pose would yank the view out from under the drag
    if (dragLooking.current) {
      glide.current = null;
    } else if (prev.kind === 'focus' && mode.kind === 'free' && prev.returnPose) {
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
    ) : // build mode: the cursor drags objects rather than steering the camera, so
    // the pointer-locked controls give way to keyboard flight plus right-drag look
    // (unmounting them also releases any pointer lock via their cleanup)
    free && buildMode ? (
      <BuildFlyControls />
    ) : free ? (
      <FreeFlyControls glide={glide} />
    ) : null;

  return (
    <>
      {wallArtHover && <WallArtControls />}
      {pendingCapture && <PhotoControls winner={pendingCapture} maxSeat={maxSeat} />}
      <DragLookControls glide={glide} dragging={dragLooking} />
      {controls}
    </>
  );
}

/**
 * Reframe the painting while the cursor is over it: wheel zooms, and holding
 * ctrl turns mouse movement into a two-axis pan. Mounted only on hover, so it
 * never competes with FocusControls' own wheel listener.
 *
 * The wheel has to be a native non-passive listener rather than an R3F
 * `onWheel` prop: ctrl+wheel is the browser's page-zoom gesture, and only
 * `preventDefault` on a non-passive listener suppresses it. That still applies
 * with ctrl held even though the wheel no longer pans — otherwise leaning on
 * ctrl and brushing the wheel mid-pan zooms the whole page.
 */
function WallArtControls() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const art = useStore.getState().office?.wallArt;
      if (!art) return; // the built-in artwork has no framing to change
      e.preventDefault();
      if (e.ctrlKey) return; // ctrl is the pan modifier; suppress page zoom and nothing else
      reframeWallArt({ zoom: clampZoom(art.zoom * (e.deltaY > 0 ? 1 / ZOOM_PER_TICK : ZOOM_PER_TICK)) });
    };
    /**
     * Ctrl + move drags the picture inside its frame, on both axes. The image
     * follows the cursor — dragging right slides the picture right, which means
     * sampling further *left*, hence the subtraction on both axes. There is
     * nothing to pan on an axis with no overflow; `wallArtTransform` ignores the
     * value there, so this needs no special case for it.
     */
    const onMouseMove = (e: MouseEvent) => {
      if (!e.ctrlKey) return;
      if (document.pointerLockElement) return; // pointer-locked movement steers the fly cam
      const art = useStore.getState().office?.wallArt;
      if (!art) return;
      if (e.movementX === 0 && e.movementY === 0) return;
      reframeWallArt({
        panX: clampPan((art.panX ?? 0) - e.movementX * PAN_PER_PIXEL),
        panY: clampPan((art.panY ?? 0) - e.movementY * PAN_PER_PIXEL),
      });
    };
    const dom = gl.domElement;
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('mousemove', onMouseMove);
    return () => {
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('mousemove', onMouseMove);
    };
  }, [gl]);

  return null;
}

const ZOOM_PER_TICK = 1.12;
/** ~200 px of travel covers the full pan range, which feels like dragging the picture. */
const PAN_PER_PIXEL = 0.005;

const UP = new THREE.Vector3(0, 1, 0);
const CENTER_NDC = new THREE.Vector2(0, 0);
const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpWish = new THREE.Vector3();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
