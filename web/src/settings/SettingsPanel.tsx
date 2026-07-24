import { useState } from 'react';
import { useStore } from '../store.ts';
import { CHARACTER_VARIANTS } from '../../../shared/types.ts';

const api = (path: string, method: string, body?: unknown) =>
  fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

export function SettingsPanel() {
  const office = useStore((s) => s.office);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [bossName, setBossName] = useState<string | null>(null);

  if (!office) return null;

  return (
    <div style={styles.overlay} onClick={() => setOpen(false)}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Office Settings</h2>
          <button style={styles.close} onClick={() => setOpen(false)}>✕</button>
        </div>

        <h3 style={styles.sectionTitle}>The Boss</h3>
        <div style={styles.row}>
          <input
            style={styles.input}
            value={bossName ?? office.boss.name}
            onChange={(e) => setBossName(e.target.value)}
            onBlur={() => {
              if (bossName !== null && bossName !== office.boss.name)
                api('/settings', 'PUT', { name: bossName });
              setBossName(null);
            }}
          />
          <select
            style={styles.select}
            value={office.boss.variant}
            onChange={(e) => api('/settings', 'PUT', { variant: e.target.value })}
          >
            {CHARACTER_VARIANTS.map((v) => (
              <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>

        <h3 style={styles.sectionTitle}>Employees</h3>
        {office.employees.map((e) => (
          <EmployeeRow key={e.id} id={e.id} name={e.name} variant={e.variant} status={e.status} />
        ))}
      </div>
    </div>
  );
}

function EmployeeRow({ id, name, variant, status }: { id: string; name: string; variant: string; status: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div style={styles.row}>
      <input
        style={styles.input}
        value={draft ?? name}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== name) api(`/employees/${id}`, 'PUT', { name: draft });
          setDraft(null);
        }}
      />
      <select
        style={styles.select}
        value={variant}
        onChange={(e) => api(`/employees/${id}`, 'PUT', { variant: e.target.value })}
      >
        {CHARACTER_VARIANTS.map((v) => (
          <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>
        ))}
      </select>
      <span style={{ ...styles.badge, background: status === 'working' ? '#2e5c37' : '#3a3f47' }}>
        {status}
      </span>
      <button
        style={styles.remove}
        title="Remove employee"
        onClick={() => {
          if (confirm(`Let ${name} go?`)) api(`/employees/${id}`, 'DELETE');
        }}
      >
        🗑
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
  },
  panel: {
    width: 460, maxHeight: '80vh', overflowY: 'auto', background: '#161a20',
    color: '#e6e8eb', borderRadius: 12, padding: 20,
    fontFamily: 'system-ui, sans-serif', border: '1px solid #2c333d',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  close: { background: 'none', border: 'none', color: '#9aa4b0', fontSize: 16, cursor: 'pointer' },
  sectionTitle: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: '#9aa4b0', margin: '18px 0 8px' },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 },
  input: {
    flex: 1, background: '#0e1116', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 6, padding: '6px 10px', fontSize: 14,
  },
  select: {
    background: '#0e1116', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 6, padding: '6px 8px', fontSize: 13,
  },
  badge: { fontSize: 11, padding: '3px 8px', borderRadius: 10, color: '#dfe3e8' },
  remove: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15 },
};
