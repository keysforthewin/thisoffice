import { useState } from 'react';
import { useStore } from '../../store.ts';
import { catalogEntry } from '../../characters/catalog.ts';
import { CharacterPicker } from './CharacterPicker.tsx';
import { Thumb } from './Thumb.tsx';
import { useHydrateThumbs } from './useThumbnails.tsx';

interface Props {
  variant: string;
  title?: string;
  /** REST path of this person's biography (e.g. /api/boss/bio); enables the picker's Biography tab */
  bioPath?: string;
  onPick: (variant: string) => void;
}

export function CharacterButton({ variant, title, bioPath, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const catalog = useStore((s) => s.catalog);
  useHydrateThumbs();
  const entry = catalogEntry(catalog, variant);
  const displayName = entry?.displayName ?? variant.replace(/_/g, ' ');

  return (
    <>
      <button style={styles.button} onClick={() => setOpen(true)} title="Change character">
        <Thumb id={variant} displayName={displayName} size={26} />
        <span style={styles.label}>{displayName}</span>
        <span style={styles.chevron}>▾</span>
      </button>
      {open && (
        <CharacterPicker current={variant} title={title} bioPath={bioPath} onPick={onPick} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#0e1116', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer',
    maxWidth: 180,
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chevron: { color: '#9aa4b0', fontSize: 10 },
};
