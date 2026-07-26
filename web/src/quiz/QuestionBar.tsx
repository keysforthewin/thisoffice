import { useEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { answerQuiz } from './quizApi.ts';

/** Keys stay inert while a text field has focus (the office-name and settings inputs). */
function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement
  );
}

/**
 * Which answer a keypress means, or null to ignore it. Split out from the
 * listener so the mapping and all four guards are testable without a DOM.
 *
 * `modified` covers meta/ctrl/alt so browser and OS shortcuts keep working, and
 * `repeat` drops held-key autorepeat — a leaned-on Y would otherwise answer the
 * question and then keep firing at whatever question came next.
 */
export function quizKeyAnswer(
  key: string,
  guards: { typing?: boolean; repeat?: boolean; modified?: boolean } = {},
): 'yes' | 'no' | null {
  if (guards.typing || guards.repeat || guards.modified) return null;
  const k = key.toLowerCase();
  if (k === 'y') return 'yes';
  if (k === 'n') return 'no';
  return null;
}

/**
 * The live 20 Questions prompt as a screen-bottom bar, sitting just above the
 * HUD help line, with Y/N bound as answer keys.
 *
 * Two reasons this exists alongside the in-world speech bubble rather than
 * replacing it: the bubble is a fixed-width panel in 3D space, so a long
 * question wraps awkwardly or runs past it — this shows the question in full —
 * and while the fly camera holds pointer lock the browser routes clicks to the
 * camera, so the bubble's buttons are unreachable and a key is the only way to
 * answer.
 *
 * The key listener is mounted with the bar, i.e. only while a question is
 * actually open, so Y and N are free for anything else the rest of the time.
 */
export function QuestionBar() {
  const question = useStore((s) => s.quiz?.question ?? null);
  const id = question?.id;
  /** One submission per question: a key-repeat or a fast double-tap would otherwise
   *  fire a second POST that the server can only answer with a stale-id 409. */
  const answered = useRef<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      const answer = quizKeyAnswer(e.key, {
        typing: isTyping(e.target),
        repeat: e.repeat,
        modified: e.metaKey || e.ctrlKey || e.altKey,
      });
      if (!answer) return;
      e.preventDefault();
      if (answered.current === id) return;
      answered.current = id;
      answerQuiz(id, answer);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (!question) return null;

  const submit = (answer: 'yes' | 'no') => {
    if (answered.current === question.id) return;
    answered.current = question.id;
    answerQuiz(question.id, answer);
  };

  return (
    <div style={styles.bar}>
      <span style={styles.who}>{question.askerName} asks</span>
      <span style={styles.text}>{question.text}</span>
      <button style={{ ...styles.btn, ...styles.yes }} onClick={() => submit('yes')}>
        <kbd style={styles.kbd}>Y</kbd> YES
      </button>
      <button style={{ ...styles.btn, ...styles.no }} onClick={() => submit('no')}>
        <kbd style={styles.kbd}>N</kbd> NO
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'absolute',
    // clears the HUD help line, which sits at bottom: 14 and is ~29px tall
    bottom: 52,
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'min(880px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'rgba(14,17,22,0.86)',
    border: '1px solid #2c333d',
    borderRadius: 18,
    padding: '8px 12px 8px 16px',
    color: '#e6e8eb',
    fontFamily: 'system-ui, sans-serif',
    // the bar itself must not eat clicks meant for the scene; the buttons opt back in
    pointerEvents: 'none',
  },
  who: {
    flexShrink: 0,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: '#9aa4b0',
  },
  // the question is the point of the bar: let it wrap rather than truncate
  text: { fontSize: 15, lineHeight: 1.3, minWidth: 0 },
  btn: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    borderRadius: 10,
    padding: '7px 12px',
    fontSize: 13,
    fontWeight: 700,
    color: '#fff',
    cursor: 'pointer',
    pointerEvents: 'auto',
  },
  yes: { background: '#2e7d43' },
  no: { background: '#a33a33' },
  kbd: {
    background: 'rgba(0,0,0,0.35)',
    border: '1px solid rgba(255,255,255,0.35)',
    borderRadius: 4,
    padding: '0 5px',
    fontSize: 11,
    fontFamily: 'inherit',
    lineHeight: '16px',
  },
};
