import type { CharacterEntry } from '../../../../shared/types.ts';
import { Thumb } from './Thumb.tsx';

export const GRID_COLUMNS = 4;

interface GridProps {
  entries: CharacterEntry[];
  selected: string;
  highlighted: string;
  onHighlight: (id: string) => void;
  onPick: (id: string) => void;
}

export function CharacterGrid({ entries, selected, highlighted, onHighlight, onPick }: GridProps) {
  if (entries.length === 0) {
    return <div style={{ color: '#9aa4b0', fontSize: 13, padding: 24, textAlign: 'center' }}>No characters match</div>;
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
        gap: 8,
        overflowY: 'auto',
        flex: 1,
        alignContent: 'start',
        paddingRight: 4,
      }}
    >
      {entries.map((entry) => (
        <CharacterCard
          key={entry.id}
          entry={entry}
          selected={entry.id === selected}
          highlighted={entry.id === highlighted}
          onHighlight={onHighlight}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

function CharacterCard({
  entry,
  selected,
  highlighted,
  onHighlight,
  onPick,
}: {
  entry: CharacterEntry;
  selected: boolean;
  highlighted: boolean;
  onHighlight: (id: string) => void;
  onPick: (id: string) => void;
}) {
  return (
    <div
      data-charcard={entry.id}
      onMouseEnter={() => onHighlight(entry.id)}
      onClick={() => onPick(entry.id)}
      style={{
        cursor: 'pointer',
        borderRadius: 8,
        border: `2px solid ${selected ? '#4cc38a' : highlighted ? '#5b6472' : '#2c333d'}`,
        background: highlighted ? '#1b212a' : '#12161c',
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
      }}
    >
      <Thumb id={entry.id} displayName={entry.displayName} size={64} />
      <div
        style={{
          fontSize: 11.5,
          color: selected ? '#4cc38a' : '#e6e8eb',
          textAlign: 'center',
          lineHeight: 1.2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          width: '100%',
        }}
      >
        {entry.displayName}
      </div>
    </div>
  );
}
