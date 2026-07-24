import { Suspense, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { useStore } from './store.ts';
import { Office } from './scene/Office.tsx';
import { CameraRig, usePovList } from './scene/CameraRig.tsx';
import { SettingsPanel } from './settings/SettingsPanel.tsx';

export default function App() {
  const connected = useStore((s) => s.connected);
  const mode = useStore((s) => s.cameraMode);
  const setMode = useStore((s) => s.setCameraMode);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const office = useStore((s) => s.office);
  const povCount = (office?.employees.length ?? 0) + 2; // boss + employees + whiteboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const cur = useStore.getState().cameraMode;
      if (e.key === 'v' || e.key === 'V') {
        setMode(cur.kind === 'free' ? { kind: 'pov', index: 0 } : { kind: 'free' });
      } else if (e.key === 'Escape') {
        if (useStore.getState().settingsOpen) setSettingsOpen(false);
        else setMode({ kind: 'free' });
      } else if ((e.key === 'Tab' || e.key === 'ArrowRight') && cur.kind === 'pov') {
        e.preventDefault();
        setMode({ kind: 'pov', index: (cur.index + 1) % povCount });
      } else if (e.key === 'ArrowLeft' && cur.kind === 'pov') {
        setMode({ kind: 'pov', index: (cur.index - 1 + povCount) % povCount });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [povCount, setMode, setSettingsOpen]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas shadows camera={{ position: [7.5, 6.5, 9], fov: 50 }}>
        <color attach="background" args={['#141218']} />
        <fog attach="fog" args={['#141218', 20, 46]} />
        <ambientLight intensity={0.5} color="#ffe9d0" />
        <hemisphereLight args={['#b8c4dc', '#5a4a3a', 0.55]} />
        <directionalLight
          castShadow
          position={[6, 9, 4]}
          color="#fff1dc"
          intensity={1.7}
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-16}
          shadow-camera-right={16}
          shadow-camera-top={16}
          shadow-camera-bottom={-16}
        />
        <Suspense fallback={null}>
          <Office />
        </Suspense>
        <CameraRig />
      </Canvas>

      <Hud connected={connected} mode={mode} onSettings={() => setSettingsOpen(true)} />
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}

function Hud({ connected, mode, onSettings }: { connected: boolean; mode: ReturnType<typeof useStore.getState>['cameraMode']; onSettings: () => void }) {
  const povs = usePovList();
  const label =
    mode.kind === 'free'
      ? 'Free camera — drag to orbit · V for POV tour'
      : `POV: ${povs[Math.min(mode.index, povs.length - 1)]?.label ?? ''} — Tab/← → cycle · V/Esc exit`;
  return (
    <>
      <div style={hudStyles.topLeft}>
        <span style={{ ...hudStyles.dot, background: connected ? '#4cc38a' : '#e5484d' }} />
        This Office
      </div>
      <div style={hudStyles.bottom}>{label}</div>
      <button style={hudStyles.gear} onClick={onSettings} title="Settings">⚙</button>
    </>
  );
}

const hudStyles: Record<string, React.CSSProperties> = {
  topLeft: {
    position: 'absolute', top: 14, left: 16, color: '#e6e8eb',
    fontFamily: 'system-ui, sans-serif', fontSize: 15, fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none',
  },
  dot: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block' },
  bottom: {
    position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
    color: '#9aa4b0', fontFamily: 'system-ui, sans-serif', fontSize: 13,
    background: 'rgba(14,17,22,0.65)', padding: '6px 14px', borderRadius: 16,
    pointerEvents: 'none', whiteSpace: 'nowrap',
  },
  gear: {
    position: 'absolute', top: 12, right: 16, background: 'rgba(14,17,22,0.65)',
    border: '1px solid #2c333d', color: '#e6e8eb', borderRadius: 8,
    width: 36, height: 36, fontSize: 17, cursor: 'pointer',
  },
};
