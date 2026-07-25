import { useCallback, useEffect, useRef, useState } from 'react';

const BIO_MAX_CHARS = 20_000;
const SAVE_DEBOUNCE_MS = 600;

/**
 * Free-text backstory editor for one person (boss or employee). The bio is
 * stored server-side per seat (never in the broadcast state), so this tab
 * fetches on open and PUTs with the same debounce+flush pattern as the
 * character adjustment sliders.
 */
export function BiographyTab({ path }: { path: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (!cancelled) setDraft(typeof body.bio === 'string' ? body.bio : '');
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the biography.');
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const persist = useCallback(
    (bio: string) => {
      pending.current = null;
      fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio }),
      }).catch(() => {
        /* editor keeps working locally; the next successful save wins */
      });
    },
    [path],
  );

  const apply = (bio: string) => {
    setDraft(bio);
    pending.current = bio;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(bio), SAVE_DEBOUNCE_MS);
  };

  // flush mid-debounce edits when the tab switches or the modal closes
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) persist(pending.current);
    },
    [persist],
  );

  if (error) return <div style={styles.status}>{error}</div>;
  if (draft === null) return <div style={styles.status}>Loading…</div>;

  return (
    <div style={styles.wrap}>
      <textarea
        style={styles.textarea}
        value={draft}
        maxLength={BIO_MAX_CHARS}
        placeholder={
        'Who is this person? Write their story — background, quirks, how they ended up ' +
        'in this office, example dialogue… as rich as you like.'
        }
        onChange={(e) => apply(e.target.value)}
      />
      <div style={styles.counter}>
        {draft.length.toLocaleString()} / {BIO_MAX_CHARS.toLocaleString()} chars · ~8,000 recommended · saves automatically
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 },
  textarea: {
    flex: 1, minHeight: 0, resize: 'none', boxSizing: 'border-box',
    background: '#0e1116', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.5,
    fontFamily: 'inherit', outline: 'none',
  },
  counter: { fontSize: 11, color: '#9aa4b0', textAlign: 'right' },
  status: { color: '#9aa4b0', fontSize: 13, padding: 20 },
};
