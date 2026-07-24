import { useThumbStore, initialsFor, hueFor } from './thumbStore.ts';

export function Thumb({ id, displayName, size }: { id: string; displayName: string; size: number }) {
  const dataUrl = useThumbStore((s) => s.thumbs[id]);
  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt={displayName}
        width={size}
        height={size}
        style={{ borderRadius: 6, display: 'block', background: '#0e1116' }}
      />
    );
  }
  const hue = hueFor(id);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.34,
        fontWeight: 700,
        color: `hsl(${hue}, 45%, 72%)`,
        background: `hsl(${hue}, 28%, 16%)`,
        userSelect: 'none',
      }}
    >
      {initialsFor(displayName)}
    </div>
  );
}
