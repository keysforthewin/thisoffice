import { useRef, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../store.ts';
import { fillsView, isTagFullyVisible } from '../scene/nametagVisibility.ts';
import { askerAnchor, fallbackAnchor } from './askerAnchor.ts';
import { answerQuiz } from './quizApi.ts';

/**
 * The bubble is a DOM overlay, so nothing about it is depth-tested: left alone it
 * draws over monitors, walls and desks from any angle, which reads as it floating
 * in front of the room rather than standing in it. It therefore borrows the
 * nametag rule wholesale (`isTagFullyVisible`): shown only while every sample
 * point has a clear line from the camera past everything that raycasts, and
 * characters opt out of raycasting, so it still shows through the person asking.
 *
 * Hiding it can never strand the round, which is the only reason all-or-nothing
 * is safe here: the question stays answerable from the QuestionBar HUD and the
 * Y/N keys, both of which are on screen the whole time the bubble is up.
 */
const CHECK_MS = 100;

/**
 * The bubble's world footprint, approximating the 240 px card at its usual
 * distance. Approximate is fine — the check is all-or-nothing over the quad, so a
 * few centimetres either way only shifts where the edge of a monitor starts to
 * count as covering it.
 */
const BUBBLE_W = 1.7;
const BUBBLE_H = 1.3;

/**
 * The bubble is deliberately a large object — a readable card, not a pill — so it
 * gets a far looser near-cull than a nametag: it only goes away once it is eating
 * most of the frame, around 2 units at the default fov. Hiding it is safe at any
 * distance because the QuestionBar and the Y/N keys keep the question answerable.
 */
const MAX_BUBBLE_SCREEN_FRACTION = 0.62;

const _camPos = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _center = new THREE.Vector3();

/**
 * Characters stand in for themselves as invisible box colliders (Person.tsx), and
 * those are the one thing the bubble is allowed to show through — chiefly the
 * asker's own, whose head is directly under the anchor. NameTag exempts only the
 * tag's owner, because a tag hangs at head height where someone else's body
 * legitimately covers it; the bubble hangs a metre higher, above the colliders
 * entirely, so it needs no ref plumbing to say which one is its own.
 */
const ignoreCharacters = (obj: THREE.Object3D) => !obj.visible;

/** Throttled nametag-style occlusion for the one bubble in the scene. */
function useBubbleVisible(anchor: [number, number, number]): boolean {
  const [visible, setVisible] = useState(true);
  const next = useRef(0);

  useFrame(({ camera, scene, clock }, delta) => {
    next.current -= delta * 1000;
    if (next.current > 0) return;
    next.current += CHECK_MS;
    camera.getWorldPosition(_camPos);
    camera.getWorldQuaternion(_camQuat);
    _center.set(anchor[0], anchor[1], anchor[2]);
    if (fillsView(BUBBLE_H, _center.distanceTo(_camPos), camera, MAX_BUBBLE_SCREEN_FRACTION)) {
      setVisible((was) => (was ? false : was));
      return;
    }
    const clear = isTagFullyVisible(
      scene,
      _camPos,
      _camQuat,
      _center,
      BUBBLE_W,
      BUBBLE_H,
      ignoreCharacters,
      clock.elapsedTime * 1000
    );
    // Only ever a state change on a crossing: a setState every 100 ms would
    // re-render the bubble (and its two buttons) for the whole round.
    setVisible((was) => (was === clear ? was : clear));
  });

  return visible;
}

/**
 * The office's 20 Questions prompt, above whoever is asking.
 *
 * This is the one speech bubble in the scene, and a deliberate exception to the
 * "all activity renders on monitors" rule: it is game UI needing two clickable
 * targets, not activity telemetry. Only ever one is mounted.
 */
export function SpeechBubble({ maxSeat }: { maxSeat: number }) {
  const question = useStore((s) => s.quiz?.question ?? null);
  const buildMode = useStore((s) => s.buildMode);
  // `layout` is the one field of `office` the store keeps reference-stable
  // across unrelated broadcasts (`stableLayout` in store.ts); `office` itself
  // is not.
  const layout = useStore((s) => s.office?.layout);
  const katPerson = useStore((s) => s.office?.katPerson !== false);
  const hasOffice = useStore((s) => s.office != null);

  // build mode is for rearranging the room; a click-through bubble is in the way
  if (!question || buildMode) return null;
  // `askerSeat` rides the question, so the bubble does not depend on the live
  // roster: the asker can be evicted mid-question and the bubble stays put and
  // answerable. `fallbackAnchor` is the last resort — never render nothing,
  // because the server keeps holding this question until this bubble answers it.
  const anchor =
    askerAnchor(question.asker, question.askerSeat, hasOffice ? { layout, katPerson } : null, maxSeat) ??
    fallbackAnchor(maxSeat);

  // Split so the occlusion hook is never called conditionally: everything above
  // can bail out, and `Bubble` only ever mounts with a question and an anchor.
  return <Bubble anchor={anchor} id={question.id} askerName={question.askerName} text={question.text} />;
}

function Bubble({
  anchor,
  id,
  askerName,
  text,
}: {
  anchor: [number, number, number];
  id: string;
  askerName: string;
  text: string;
}) {
  const visible = useBubbleVisible(anchor);

  return (
    <Html position={anchor} center distanceFactor={9} zIndexRange={[10, 0]}>
      {/* Kept mounted and hidden rather than unmounted: the DOM node survives a
          monitor passing in front of it, so a click that lands mid-crossing is
          not lost to a remount. */}
      <div style={visible ? undefined : HIDDEN}>
        <div style={styles.bubble}>
          <div style={styles.who}>{askerName}</div>
          <div style={styles.text}>{text}</div>
          <div style={styles.row}>
            <button style={{ ...styles.btn, ...styles.yes }} onClick={() => answerQuiz(id, 'yes')}>
              ✓ YES
            </button>
            <button style={{ ...styles.btn, ...styles.no }} onClick={() => answerQuiz(id, 'no')}>
              ✗ NO
            </button>
          </div>
        </div>
        <div style={styles.tail} />
      </div>
    </Html>
  );
}

/** `visibility` rather than `display: none`, so the card keeps its layout box. */
const HIDDEN: React.CSSProperties = { visibility: 'hidden', pointerEvents: 'none' };

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    width: 240,
    boxSizing: 'border-box',
    background: '#f7f4ec',
    color: '#1b1f24',
    border: '2px solid #2c333d',
    borderRadius: 14,
    padding: '10px 12px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    userSelect: 'none',
  },
  who: { fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#6b7280', marginBottom: 4 },
  text: { fontSize: 15, lineHeight: 1.3, marginBottom: 10 },
  row: { display: 'flex', gap: 8 },
  btn: {
    flex: 1,
    border: 'none',
    borderRadius: 8,
    padding: '7px 0',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    color: '#fff',
  },
  yes: { background: '#2e7d43' },
  no: { background: '#a33a33' },
  tail: {
    width: 0,
    height: 0,
    margin: '0 auto',
    borderLeft: '9px solid transparent',
    borderRight: '9px solid transparent',
    borderTop: '12px solid #2c333d',
  },
};
