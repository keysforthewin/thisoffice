import { Html } from '@react-three/drei';
import { useStore, type AppStore } from '../store.ts';
import { askerAnchor } from './askerAnchor.ts';
import { answerQuiz } from './quizApi.ts';

/**
 * The current asker's seat, as a plain number (or null) rather than a slice of
 * `employees`. `ws.ts` JSON.parses every server message, so `office.employees`
 * is a fresh array reference on every broadcast even when nothing about it
 * changed; a selector that returned that array (or found-and-returned an
 * Employee object from it) would make the bubble re-render on every status
 * push, hire, or monitor-title change, not just ones that move this asker's
 * seat. Reducing the subscription to the one number this component actually
 * needs lets zustand's default `Object.is` comparison do its job. Exported so
 * a store-level test can assert on it without rendering the component.
 */
export function selectAskerSeat(s: AppStore): number | null {
  const asker = s.quiz?.question?.asker;
  if (!asker || asker === 'boss' || asker === 'catPerson') return null;
  return s.office?.employees.find((e) => e.id === asker)?.seat ?? null;
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
  const hasOffice = useStore((s) => s.office != null);
  const askerSeat = useStore(selectAskerSeat);

  // build mode is for rearranging the room; a click-through bubble is in the way
  if (!question || buildMode) return null;
  const anchor = askerAnchor(question.asker, askerSeat, hasOffice ? { layout } : null, maxSeat);
  if (!anchor) return null;

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
