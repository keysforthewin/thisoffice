import { useStore } from '../store.ts';

/**
 * The plan-approval / question menu a tailed session is blocked on, as a
 * screen-bottom card — the readable companion to the blinking boss-desk beacon,
 * which only says *that* something is waiting.
 *
 * Deliberately inert: the server tails transcript files and has no channel back
 * into the session (no PID, no TTY, no socket), so there is nothing a button
 * here could submit. It numbers the options the way the CLI does so you can
 * read the menu from across the room and type the number in your terminal.
 *
 * Sits above the quiz bar when both are open — the two are independent and can
 * be on screen together.
 */
export function AskBar() {
  const ask = useStore((s) => s.office?.pendingAsk ?? null);
  const quizOpen = useStore((s) => !!s.quiz?.question);
  if (!ask) return null;

  return (
    <div style={{ ...styles.bar, bottom: quizOpen ? 104 : 52 }}>
      <span style={styles.chip}>Awaiting input</span>
      <div style={styles.body}>
        <div style={styles.summary}>{ask.summary}</div>
        {ask.options.length > 0 && (
          <div style={styles.options}>
            {ask.options.map((o, i) => (
              <span key={i} style={styles.option}>
                <kbd style={styles.kbd}>{i + 1}</kbd> {o}
              </span>
            ))}
          </div>
        )}
        <div style={styles.hint}>{ask.project} · answer in your terminal</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'min(880px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    background: 'rgba(14,17,22,0.86)',
    border: '1px solid #6b4a12',
    borderRadius: 18,
    padding: '10px 16px',
    color: '#e6e8eb',
    fontFamily: 'system-ui, sans-serif',
    // pure readout: never eat clicks meant for the scene
    pointerEvents: 'none',
  },
  chip: {
    flexShrink: 0,
    marginTop: 2,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: '#e0a83a',
  },
  body: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  summary: { fontSize: 15, lineHeight: 1.3 },
  options: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  option: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid #2c333d',
    borderRadius: 10,
    padding: '4px 10px',
    fontSize: 13,
  },
  hint: { fontSize: 11, color: '#9aa4b0' },
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
