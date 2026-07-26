import { Html } from '@react-three/drei';
import { useStore } from '../store.ts';
import { askerAnchor, fallbackAnchor } from './askerAnchor.ts';
import { answerQuiz } from './quizApi.ts';

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

  return (
    <Html position={anchor} center distanceFactor={9} zIndexRange={[10, 0]}>
      <div style={styles.bubble}>
        <div style={styles.who}>{question.askerName}</div>
        <div style={styles.text}>{question.text}</div>
        <div style={styles.row}>
          <button style={{ ...styles.btn, ...styles.yes }} onClick={() => answerQuiz(question.id, 'yes')}>
            ✓ YES
          </button>
          <button style={{ ...styles.btn, ...styles.no }} onClick={() => answerQuiz(question.id, 'no')}>
            ✗ NO
          </button>
        </div>
      </div>
      <div style={styles.tail} />
    </Html>
  );
}

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
