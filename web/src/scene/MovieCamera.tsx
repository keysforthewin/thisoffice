import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { activeSetKey, ARCHETYPES, pickShot, type PickedShot } from './movieShots.ts';
import { askerAnchor, fallbackAnchor } from '../quiz/askerAnchor.ts';

/**
 * This is a visualizer, not a trailer — shots dwell so you can actually read a
 * monitor or the status board before it cuts away. MIN_HOLD_S is the floor an
 * activity-driven recut cannot preempt; in a busy office that floor, not the
 * duration, is what sets the cut rate, so it has to move with the rest.
 */
const MIN_HOLD_S = 5;
/** Shortened floor for urgent events (a new message from upstairs, the waiting beacon
 *  lighting up): quick enough to feel like a reaction, long enough not to cut mid-beat. */
const PREEMPT_HOLD_S = 1.5;
const CUT_MIN_S = 5;
const CUT_MAX_S = 15;
/** handheld position noise amplitude (world units; world scale is 1.35× human) */
const SHAKE_AMP = 0.015;
/** look-target drift amplitude */
const DRIFT_AMP = 0.05;

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

/**
 * Auto-director: hard-cuts every 5–15 s (or on arrow key / active-set change)
 * to a randomized shot around one active monitor (plus opportunistic
 * neighbors). Shots carry authored motion — dollies, arcs, trucks, board pans,
 * lens zooms — eased across the shot, with layered sinusoid noise on top for a
 * handheld feel.
 *
 * Two events preempt on the shortened PREEMPT_HOLD_S floor instead of waiting out
 * MIN_HOLD_S: a new message from upstairs (which also forces the boss's screen as
 * the next primary), and the waiting beacon lighting up (which turns the red light
 * into a hard framing requirement on every subsequent shot). Only the arrow keys
 * still bypass the hold entirely.
 */
export function MovieCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  // A winner's photo owns the camera for its ~1.6s fly+hold: freeze rather than
  // unmount, so shotAge/setKey/recent-shot history survive and the director
  // picks up the same shot at the same progress once the capture releases the
  // camera back — no fov/fov-restore race with PhotoControls, no extra hard cut.
  const suppressed = useStore((s) => !!s.pendingCapture);
  const shot = useRef<PickedShot | null>(null);
  const shotAge = useRef(0);
  const shotDuration = useRef(0);
  const cutIndex = useRef(0);
  const setKey = useRef('');
  const wantCut = useRef(false);
  const prevPos = useRef<THREE.Vector3 | null>(null);
  const recent = useRef<PickedShot['archetype'][]>([]);
  const recentPrimaries = useRef<string[]>([]);
  const recentMotion = useRef<boolean[]>([]);
  const pendingRecut = useRef(false);
  /** the pending recut is urgent: honored at PREEMPT_HOLD_S rather than MIN_HOLD_S */
  const preempt = useRef(false);
  const forcePrimary = useRef<string | undefined>(undefined);
  const lastInboxAlert = useRef<number | null>(null);
  const lastWaiting = useRef<boolean | null>(null);
  // the fov the rest of the app runs at; zoom shots animate camera.fov, so shot
  // picking must use this stable base and unmount must restore it (CameraRig's
  // focus fitting reads camera.fov)
  const baseFov = useRef<number>(50);

  useEffect(() => {
    baseFov.current = camera.fov;
    return () => {
      camera.fov = baseFov.current;
      camera.updateProjectionMatrix();
      // A dutchStatic shot applies camera.rotateZ every frame; if movie mode is
      // exited mid-shot that roll would otherwise hang around in the free camera
      // until the user's first mousemove (FreeFlyControls only reseeds yaw/pitch,
      // dropping roll, on mount and on that first move). Level immediately instead.
      tmpEuler.setFromQuaternion(camera.quaternion);
      tmpEuler.z = 0;
      camera.quaternion.setFromEuler(tmpEuler);
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
    if (suppressed) return;
    const now = Date.now();
    const { office, lastActivity, inboxAlert, quiz } = useStore.getState();
    // Resolved exactly the way SpeechBubble resolves it, so the camera frames
    // where the bubble actually is — including the clamp that keeps an evicted
    // asker's bubble inside the room.
    const question = quiz?.question ?? null;
    const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
    const quizAnchor =
      question && office
        ? askerAnchor(question.asker, question.askerSeat, { layout: office.layout, katPerson: office.katPerson }, maxSeat) ??
          fallbackAnchor(maxSeat)
        : null;
    // a new question is a new subject in a new place: fold it into the recut
    // fingerprint so the camera turns to whoever just spoke up
    const key = `${activeSetKey(lastActivity, now, office)}#${question?.id ?? ''}`;
    shotAge.current += delta;

    if (key !== setKey.current) {
      setKey.current = key;
      pendingRecut.current = true; // honored only once the hold expires
    }
    // A new message from upstairs lands on the boss's screen and is the most important
    // thing in the room; the active-set fingerprint can't see it (a second prompt inside
    // the boss key's TTL doesn't change the set at all), so watch the alert directly.
    if (lastInboxAlert.current !== null && inboxAlert > lastInboxAlert.current) {
      pendingRecut.current = true;
      preempt.current = true;
      forcePrimary.current = 'boss';
    }
    lastInboxAlert.current = inboxAlert;

    const waiting = !!office?.waitingForInput;
    // off → on: the current shot almost certainly doesn't frame the beacon, so recut
    // urgently. on → off only lifts a constraint — an ordinary recut is fine.
    if (lastWaiting.current !== null && waiting !== lastWaiting.current) {
      pendingRecut.current = true;
      if (waiting) preempt.current = true;
    }
    lastWaiting.current = waiting;

    const held = shotAge.current < (preempt.current ? PREEMPT_HOLD_S : MIN_HOLD_S);
    if (!shot.current || wantCut.current || (!held && (pendingRecut.current || shotAge.current >= shotDuration.current))) {
      wantCut.current = false;
      pendingRecut.current = false;
      preempt.current = false;
      const picked = pickShot({
        office, lastActivity, now,
        fovY: THREE.MathUtils.degToRad(baseFov.current),
        aspect: camera.aspect,
        rng: Math.random,
        cutIndex: cutIndex.current++,
        prevPosition: prevPos.current,
        recentArchetypes: recent.current,
        recentPrimaries: recentPrimaries.current,
        recentMotion: recentMotion.current,
        waiting,
        forcePrimary: forcePrimary.current,
        quizAnchor,
      });
      forcePrimary.current = undefined;
      shot.current = picked;
      // measure the next cut's min distance from where this shot's camera ENDS
      prevPos.current = (picked.positionEnd ?? picked.position).clone();
      recent.current = [picked.archetype, ...recent.current].slice(0, 3);
      recentMotion.current = [!ARCHETYPES[picked.archetype].static, ...recentMotion.current].slice(0, 4);
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
    // lookAt recomputes orientation fresh every frame, so a shot with no roll always
    // renders at roll 0 regardless of the previous shot's roll — only apply when set.
    if (s.roll) camera.rotateZ(s.roll);
  });

  return null;
}

const tmpPos = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
// 'YXZ' matches CameraRig's FreeFlyControls convention (yaw, pitch, then roll last)
// so leveling here composes cleanly with how the free camera re-derives its own look.
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
