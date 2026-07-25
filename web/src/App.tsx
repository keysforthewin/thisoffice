import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { shouldExitFocusOnMissedClick, useStore, type CameraMode } from './store.ts';
import { Office } from './scene/Office.tsx';
import { CameraRig, usePovList } from './scene/CameraRig.tsx';
import { Skybox } from './scene/Skybox.tsx';
import { SettingsPanel } from './settings/SettingsPanel.tsx';
import { loadCatalog } from './characters/catalog.ts';

export default function App() {
  const connected = useStore((s) => s.connected);
  const mode = useStore((s) => s.cameraMode);
  const setMode = useStore((s) => s.setCameraMode);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const office = useStore((s) => s.office);
  const povCount = (office?.employees.length ?? 0) + 2; // boss + employees + whiteboard

  useEffect(() => {
    loadCatalog().then(useStore.getState().setCatalog);
  }, []);

  // crosshair only makes sense while the fly-cam owns the (hidden) cursor
  const [pointerLocked, setPointerLocked] = useState(false);
  useEffect(() => {
    const onLockChange = () => setPointerLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, []);

  // capture phase runs before R3F's canvas handlers can change the mode, so
  // this records what mode each click gesture STARTED in (see onPointerMissed)
  const gestureStartMode = useRef<CameraMode | null>(null);
  useEffect(() => {
    const onDown = () => (gestureStartMode.current = useStore.getState().cameraMode);
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const cur = useStore.getState().cameraMode;
      if (e.key === 'm' || e.key === 'M') {
        setMode(cur.kind === 'movie' ? { kind: 'free' } : { kind: 'movie' });
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        setMode(cur.kind === 'free' ? { kind: 'pov', index: 0 } : { kind: 'free' });
      } else if (e.key === 'Escape') {
        if (useStore.getState().settingsOpen) setSettingsOpen(false);
        else if (cur.kind === 'focus') setMode(cur.from);
        else setMode({ kind: 'free' });
      } else if (e.key === 'End' && cur.kind === 'focus') {
        useStore.getState().setFocusScroll(0); // snap back to the live tail
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
      <Canvas
        shadows
        camera={{ position: [7.5, 6.5, 9], fov: 50 }}
        onPointerMissed={() => {
          // click away from the monitor exits — but only if this same gesture
          // didn't just enter focus (a tap's click raycasts mid-camera-flight
          // and "misses", which must not bounce us straight back out)
          const cur = useStore.getState().cameraMode;
          if (shouldExitFocusOnMissedClick(cur, gestureStartMode.current) && cur.kind === 'focus') {
            setMode(cur.from);
          }
        }}
      >
        <fog attach="fog" args={['#141218', 20, 46]} />
        <ambientLight intensity={0.5} color="#ffe9d0" />
        <hemisphereLight args={['#b8c4dc', '#5a4a3a', 0.55]} />
        <Suspense fallback={null}>
          <Skybox />
          <Office />
        </Suspense>
        <CameraRig />
      </Canvas>

      {mode.kind === 'free' && pointerLocked && <Crosshair />}
      <Hud connected={connected} mode={mode} onSettings={() => setSettingsOpen(true)} />
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}

/** Center-screen aim dot for the pointer-locked fly cam; fills in over a monitor. */
function Crosshair() {
  const aimed = useStore((s) => s.monitorHover !== null);
  return (
    <div
      style={{
        ...hudStyles.crosshair,
        background: aimed ? 'rgba(255,255,255,0.85)' : 'transparent',
      }}
    />
  );
}

function Hud({ connected, mode, onSettings }: { connected: boolean; mode: ReturnType<typeof useStore.getState>['cameraMode']; onSettings: () => void }) {
  const povs = usePovList();
  const office = useStore((s) => s.office);
  const focusName =
    mode.kind === 'focus'
      ? mode.target === 'boss'
        ? office?.boss.name ?? 'Boss'
        : office?.employees.find((e) => e.id === mode.target)?.name ?? 'screen'
      : '';
  const label =
    mode.kind === 'free'
      ? 'Free camera — click to look (Esc releases) · WASD fly · E/Space up · C down · Shift slow · V for POV tour · M movie mode'
      : mode.kind === 'movie'
        ? 'Movie mode — auto-follows the action · arrows cut now · M/Esc exit'
        : mode.kind === 'focus'
          ? `Screen: ${focusName} — scroll wheel for history · End = live · Esc or click away = back`
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
  crosshair: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    width: 8, height: 8, borderRadius: '50%',
    border: '1.5px solid rgba(255,255,255,0.75)',
    pointerEvents: 'none', transition: 'background 120ms',
  },
  gear: {
    position: 'absolute', top: 12, right: 16, background: 'rgba(14,17,22,0.65)',
    border: '1px solid #2c333d', color: '#e6e8eb', borderRadius: 8,
    width: 36, height: 36, fontSize: 17, cursor: 'pointer',
  },
};
