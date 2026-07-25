import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store.ts';
import { PackChips } from './PackChips.tsx';
import { CharacterGrid, GRID_COLUMNS } from './CharacterGrid.tsx';
import { CharacterPreview } from './CharacterPreview.tsx';
import { ThumbnailFactory } from './useThumbnails.tsx';
import { ImportPanel } from '../importer/ImportPanel.tsx';
import { BiographyTab } from './BiographyTab.tsx';

interface Props {
  current: string;
  title?: string;
  /** REST path of this person's biography; when set, a Biography tab appears */
  bioPath?: string;
  onPick: (variant: string) => void;
  onClose: () => void;
}

export function CharacterPicker({ current, title, bioPath, onPick, onClose }: Props) {
  const catalog = useStore((s) => s.catalog);
  const [tab, setTab] = useState<'browse' | 'import' | 'bio'>('browse');
  const [query, setQuery] = useState('');
  const [packFilter, setPackFilter] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(current);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const characters = useMemo(() => catalog?.characters ?? [], [catalog]);
  const packs = useMemo(() => [...new Set(characters.map((c) => c.pack))], [characters]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return characters.filter((c) => {
      if (packFilter && c.pack !== packFilter) return false;
      if (!q) return true;
      return `${c.displayName} ${c.id} ${c.pack} ${c.tags.join(' ')}`.toLowerCase().includes(q);
    });
  }, [characters, query, packFilter]);

  // keep highlight on a visible card
  useEffect(() => {
    if (filtered.length && !filtered.some((c) => c.id === highlighted)) {
      setHighlighted(filtered[0].id);
    }
  }, [filtered, highlighted]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    rootRef.current
      ?.querySelector(`[data-charcard="${CSS.escape(highlighted)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const move = (delta: number) => {
    const idx = filtered.findIndex((c) => c.id === highlighted);
    const next = filtered[Math.max(0, Math.min(filtered.length - 1, (idx < 0 ? 0 : idx) + delta))];
    if (next) setHighlighted(next.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // keep every key inside the modal so App's global shortcuts (V, Tab, arrows) never fire
    e.stopPropagation();
    if (tab === 'import') {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose();
      return; // Enter/arrows belong to the import panel's own inputs
    }
    if (tab === 'bio') {
      // Enter/arrows belong to the textarea; Escape while typing must not close
      // the modal out from under an edit (the tab flushes pending saves on unmount)
      if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement)) onClose();
      return;
    }
    const inSearch = e.target === searchRef.current;
    if (e.key === 'Escape') {
      if (inSearch && query) setQuery('');
      else onClose();
    } else if (e.key === 'Enter') {
      const entry = filtered.find((c) => c.id === highlighted);
      if (entry) {
        onPick(entry.id);
        onClose();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(GRID_COLUMNS);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-GRID_COLUMNS);
    } else if (e.key === 'ArrowRight' && !inSearch) {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowLeft' && !inSearch) {
      e.preventDefault();
      move(-1);
    }
  };

  const highlightedEntry = filtered.find((c) => c.id === highlighted) ?? characters.find((c) => c.id === highlighted);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div ref={rootRef} style={styles.modal} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown} tabIndex={-1}>
        <div style={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>{title ?? 'Choose a character'}</h2>
            <div style={styles.tabs}>
              <button
                style={{ ...styles.tab, ...(tab === 'browse' ? styles.tabActive : {}) }}
                onClick={() => setTab('browse')}
              >
                Browse
              </button>
              <button
                style={{ ...styles.tab, ...(tab === 'import' ? styles.tabActive : {}) }}
                onClick={() => setTab('import')}
              >
                Import from Mixamo
              </button>
              {bioPath && (
                <button
                  style={{ ...styles.tab, ...(tab === 'bio' ? styles.tabActive : {}) }}
                  onClick={() => setTab('bio')}
                >
                  Biography
                </button>
              )}
            </div>
          </div>
          <button style={styles.close} onClick={onClose}>✕</button>
        </div>
        <div style={styles.body}>
          {tab === 'bio' && bioPath ? (
            <BiographyTab path={bioPath} />
          ) : (
          <>
          <div style={styles.left}>
            {tab === 'import' ? (
              <ImportPanel />
            ) : (
              <>
                <input
                  ref={searchRef}
                  style={styles.search}
                  placeholder={`Search ${characters.length} characters…`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <PackChips packs={packs} active={packFilter} onChange={setPackFilter} />
                <CharacterGrid
                  entries={filtered}
                  selected={current}
                  highlighted={highlighted}
                  onHighlight={setHighlighted}
                  onPick={(id) => {
                    onPick(id);
                    onClose();
                  }}
                />
              </>
            )}
          </div>
          <div style={styles.right}>
            <CharacterPreview entry={highlightedEntry} />
          </div>
          </>
          )}
        </div>
        <div style={styles.credit}>
          Built-in characters &amp; furniture by{' '}
          <a href="https://kaylousberg.com" target="_blank" rel="noreferrer" style={styles.creditLink}>
            Kay Lousberg (KayKit)
          </a>
          {' '}— released CC0, free for everyone. Thanks, Kay! 💛
        </div>
        <ThumbnailFactory />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30,
  },
  modal: {
    width: 'min(860px, 94vw)', height: 'min(560px, 88vh)', background: '#161a20',
    color: '#e6e8eb', borderRadius: 12, padding: 18, border: '1px solid #2c333d',
    fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column',
    outline: 'none',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  tabs: { display: 'flex', gap: 2, background: '#0e1116', borderRadius: 7, padding: 2 },
  tab: {
    background: 'none', border: 'none', color: '#9aa4b0', fontSize: 12,
    padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
  },
  tabActive: { background: '#252c36', color: '#e6e8eb' },
  close: { background: 'none', border: 'none', color: '#9aa4b0', fontSize: 16, cursor: 'pointer' },
  body: { display: 'flex', gap: 16, flex: 1, minHeight: 0 },
  left: { flex: '1 1 55%', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
  right: { flex: '1 1 45%', minWidth: 0, display: 'flex' },
  search: {
    background: '#0e1116', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 6, padding: '8px 12px', fontSize: 14, outline: 'none',
  },
  credit: {
    marginTop: 10, paddingTop: 10, borderTop: '1px solid #2c333d',
    fontSize: 12, color: '#9aa4b0', textAlign: 'center',
  },
  creditLink: { color: '#9ab4d0' },
};
