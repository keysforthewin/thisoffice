interface Props {
  packs: string[];
  active: string | null;
  onChange: (pack: string | null) => void;
}

export function PackChips({ packs, active, onChange }: Props) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <Chip label="All" active={active === null} onClick={() => onChange(null)} />
      {packs.map((p) => (
        <Chip key={p} label={p} active={active === p} onClick={() => onChange(active === p ? null : p)} />
      ))}
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? '#24462f' : '#0e1116',
        border: `1px solid ${active ? '#4cc38a' : '#2c333d'}`,
        color: active ? '#4cc38a' : '#9aa4b0',
        borderRadius: 12,
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
