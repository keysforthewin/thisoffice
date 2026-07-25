import { useState } from 'react';
import { useStore } from '../store.ts';
import { CharacterButton } from './picker/CharacterButton.tsx';

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
          <CharacterButton
            variant={office.boss.variant}
            title={`Character for ${office.boss.name}`}
            onPick={(v) => api('/settings', 'PUT', { variant: v })}
          />
        </div>

        <h3 style={styles.sectionTitle}>Employees</h3>
        {office.employees.map((e) => (
          <EmployeeRow key={e.id} id={e.id} name={e.name} variant={e.variant} status={e.status} />
        ))}
        <button style={styles.hire} onClick={() => api('/employees', 'POST')}>
          + Hire employee
        </button>

        <h3 style={styles.sectionTitle}>Staffing</h3>
        <div style={styles.row}>
          <StaffingInput
            label="Min employees"
            value={office.staffing.minEmployees}
            onCommit={(v) => api('/settings', 'PUT', { staffing: { minEmployees: v } })}
          />
          <StaffingInput
            label="Max employees"
            value={office.staffing.maxEmployees}
            onCommit={(v) => api('/settings', 'PUT', { staffing: { maxEmployees: v } })}
          />
          <StaffingInput
            label="Idle timeout (s, 0 = stay)"
            value={office.staffing.idleTimeoutSec}
            min={0}
            onCommit={(v) => api('/settings', 'PUT', { staffing: { idleTimeoutSec: v } })}
          />
        </div>
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
      <CharacterButton
        variant={variant}
        title={`Character for ${name}`}
        onPick={(v) => api(`/employees/${id}`, 'PUT', { variant: v })}
      />
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

function StaffingInput({ label, value, min = 1, onCommit }: { label: string; value: number; min?: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label style={{ flex: 1, fontSize: 12, color: '#9aa4b0' }}>
      {label}
      <input
        style={{ ...styles.input, width: '100%', marginTop: 4 }}
        type="number"
        min={min}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = parseInt(draft ?? '', 10);
          if (Number.isInteger(v) && v >= min && v !== value) onCommit(v);
          setDraft(null);
        }}
      />
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
  },
  panel: {
    width: 460, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
    maxHeight: '80vh', overflowY: 'auto', overflowX: 'hidden', background: '#161a20',
    color: '#e6e8eb', borderRadius: 12, padding: 20,
    fontFamily: 'system-ui, sans-serif', border: '1px solid #2c333d',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  close: { background: 'none', border: 'none', color: '#9aa4b0', fontSize: 16, cursor: 'pointer' },
  sectionTitle: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: '#9aa4b0', margin: '18px 0 8px' },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 },
  input: {
    flex: 1, minWidth: 0, boxSizing: 'border-box',
    background: '#0e1116', border: '1px solid #2c333d', color: '#e6e8eb',
    borderRadius: 6, padding: '6px 10px', fontSize: 14,
  },
  badge: { fontSize: 11, padding: '3px 8px', borderRadius: 10, color: '#dfe3e8' },
  hire: {
    marginTop: 6, width: '100%', background: '#1c2733', border: '1px dashed #2c4258',
    color: '#cfe0f2', borderRadius: 8, padding: '8px 0', fontSize: 13, cursor: 'pointer',
  },
  remove: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15 },
};
