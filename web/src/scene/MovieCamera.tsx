import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { activeSetKey, pickShot, type Shot } from './movieShots.ts';

const CUT_MIN_S = 3;
const CUT_MAX_S = 10;
/** handheld position noise amplitude (world units; world scale is 1.35× human) */
const SHAKE_AMP = 0.05;
/** look-target drift amplitude */
const DRIFT_AMP = 0.12;
/** total pan of the look target across a shot, along camera-right */
const PAN_AMP = 0.18;

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

/**
 * Auto-director: hard-cuts every 3–10 s (or on arrow key / active-set change)
 * to a randomized shot framing all currently active monitors, with layered
 * sinusoid noise for a handheld feel within each shot.
 */
export function MovieCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const shot = useRef<Shot | null>(null);
  const shotAge = useRef(0);
  const shotDuration = useRef(0);
  const cutIndex = useRef(0);
  const setKey = useRef('');
  const panDir = useRef(1);
  const wantCut = useRef(false);

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

    if (!shot.current || wantCut.current || shotAge.current >= shotDuration.current || key !== setKey.current) {
      wantCut.current = false;
      setKey.current = key;
      shot.current = pickShot({
        office,
        lastActivity,
        now,
        fovY: THREE.MathUtils.degToRad(camera.fov),
        aspect: camera.aspect,
        rng: Math.random,
        cutIndex: cutIndex.current++,
      });
      shotAge.current = 0;
      shotDuration.current = CUT_MIN_S + Math.random() * (CUT_MAX_S - CUT_MIN_S);
      panDir.current = Math.random() < 0.5 ? -1 : 1;
    }

    const t = shotAge.current;
    const s = shot.current;
    // layered irrational-ratio sinusoids read as organic drift rather than a loop
    tmpPos.copy(s.position);
    tmpPos.x += SHAKE_AMP * (Math.sin(t * 1.7) * 0.6 + Math.sin(t * 3.1 + 1.3) * 0.4);
    tmpPos.y += SHAKE_AMP * (Math.sin(t * 2.3 + 0.7) * 0.6 + Math.sin(t * 4.1 + 2.1) * 0.4);
    tmpPos.z += SHAKE_AMP * (Math.sin(t * 1.3 + 2.9) * 0.6 + Math.sin(t * 3.7 + 0.4) * 0.4);

    tmpForward.copy(s.lookAt).sub(s.position).normalize();
    tmpRight.crossVectors(tmpForward, UP).normalize();
    tmpLook.copy(s.lookAt);
    tmpLook.addScaledVector(tmpRight, panDir.current * PAN_AMP * (t / shotDuration.current - 0.5));
    tmpLook.x += DRIFT_AMP * Math.sin(t * 0.9 + 0.2) * 0.5;
    tmpLook.y += DRIFT_AMP * Math.sin(t * 1.1 + 1.7) * 0.5;

    camera.position.copy(tmpPos);
    camera.lookAt(tmpLook);
  });

  return null;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
