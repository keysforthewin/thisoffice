import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { activeSetKey, pickShot, type PickedShot } from './movieShots.ts';

const MIN_HOLD_S = 2.5;
const CUT_MIN_S = 3;
const CUT_MAX_S = 10;
/** handheld position noise amplitude (world units; world scale is 1.35× human) */
const SHAKE_AMP = 0.015;
/** look-target drift amplitude */
const DRIFT_AMP = 0.05;

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

/**
 * Auto-director: hard-cuts every 3–10 s (or on arrow key / active-set change)
 * to a randomized shot around one active monitor (plus opportunistic
 * neighbors). Shots carry authored motion — dollies, arcs, trucks, board pans,
 * lens zooms — eased across the shot, with layered sinusoid noise on top for a
 * handheld feel.
 */
export function MovieCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const shot = useRef<PickedShot | null>(null);
  const shotAge = useRef(0);
  const shotDuration = useRef(0);
  const cutIndex = useRef(0);
  const setKey = useRef('');
  const wantCut = useRef(false);
  const prevPos = useRef<THREE.Vector3 | null>(null);
  const recent = useRef<PickedShot['archetype'][]>([]);
  const recentPrimaries = useRef<string[]>([]);
  const pendingRecut = useRef(false);
  // the fov the rest of the app runs at; zoom shots animate camera.fov, so shot
  // picking must use this stable base and unmount must restore it (CameraRig's
  // focus fitting reads camera.fov)
  const baseFov = useRef<number>(50);

  useEffect(() => {
    baseFov.current = camera.fov;
    return () => {
      camera.fov = baseFov.current;
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !ARROW_KEYS.has(e.key)) return;
      e.preventDefault();
      wantCut.current = true;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useFrame((_, delta) => {
    const now = Date.now();
    const { office, lastActivity } = useStore.getState();
    const key = activeSetKey(lastActivity, now, office);
    shotAge.current += delta;

    if (key !== setKey.current) {
      setKey.current = key;
      pendingRecut.current = true; // honored only once the hold expires
    }
    const held = shotAge.current < MIN_HOLD_S;
    if (!shot.current || wantCut.current || (!held && (pendingRecut.current || shotAge.current >= shotDuration.current))) {
      wantCut.current = false;
      pendingRecut.current = false;
      const picked = pickShot({
        office, lastActivity, now,
        fovY: THREE.MathUtils.degToRad(baseFov.current),
        aspect: camera.aspect,
        rng: Math.random,
        cutIndex: cutIndex.current++,
        prevPosition: prevPos.current,
        recentArchetypes: recent.current,
        recentPrimaries: recentPrimaries.current,
      });
      shot.current = picked;
      // measure the next cut's min distance from where this shot's camera ENDS
      prevPos.current = (picked.positionEnd ?? picked.position).clone();
      recent.current = [picked.archetype, ...recent.current].slice(0, 2);
      if (picked.primaryKey) {
        recentPrimaries.current = [picked.primaryKey, ...recentPrimaries.current].slice(0, 4);
      }
      shotAge.current = 0;
      shotDuration.current = Math.max(picked.minDuration ?? 0, CUT_MIN_S + Math.random() * (CUT_MAX_S - CUT_MIN_S));
    }

    const t = shotAge.current;
    const s = shot.current;

    // eased progress drives all authored motion (position, look target, lens)
    const p = Math.min(1, t / shotDuration.current);
    const e = s.ease === 'linear' ? p : p * p * (3 - 2 * p);
    tmpPos.lerpVectors(s.position, s.positionEnd ?? s.position, e);
    tmpLook.lerpVectors(s.lookAt, s.lookAtEnd ?? s.lookAt, e);
    const fov = s.fov !== undefined ? THREE.MathUtils.lerp(s.fov, s.fovEnd ?? s.fov, e) : baseFov.current;
    if (fov !== camera.fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // layered irrational-ratio sinusoids read as organic drift rather than a loop
    tmpPos.x += SHAKE_AMP * (Math.sin(t * 0.23) * 0.6 + Math.sin(t * 0.41 + 1.3) * 0.4);
    tmpPos.y += SHAKE_AMP * (Math.sin(t * 0.31 + 0.7) * 0.6 + Math.sin(t * 0.53 + 2.1) * 0.4);
    tmpPos.z += SHAKE_AMP * (Math.sin(t * 0.21 + 2.9) * 0.6 + Math.sin(t * 0.37 + 0.4) * 0.4);
    tmpLook.x += DRIFT_AMP * Math.sin(t * 0.31 + 0.2) * 0.5;
    tmpLook.y += DRIFT_AMP * Math.sin(t * 0.47 + 1.7) * 0.5;

    camera.position.copy(tmpPos);
    camera.lookAt(tmpLook);
  });

  return null;
}

const tmpPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
