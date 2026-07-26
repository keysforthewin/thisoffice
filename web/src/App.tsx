import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { dismissBootScreen } from './boot.ts';
import { shouldExitFocusOnMissedClick, useStore, type CameraMode } from './store.ts';
import { Office } from './scene/Office.tsx';
import { DuskSky } from './scene/DuskSky.tsx';
import { CameraRig, usePovList } from './scene/CameraRig.tsx';
import { SettingsPanel } from './settings/SettingsPanel.tsx';
import { PerfPanel, PerfSampler } from './scene/PerfOverlay.tsx';
import { ShadowControl } from './scene/ShadowControl.tsx';
import { AdaptiveQuality, MAX_DPR } from './scene/AdaptiveQuality.tsx';
import { QuestionBar } from './quiz/QuestionBar.tsx';
import { AskBar } from './ask/AskBar.tsx';
import { loadCatalog } from './characters/catalog.ts';

export default function App() {
  const connected = useStore((s) => s.connected);
  const mode = useStore((s) => s.cameraMode);
  const setMode = useStore((s) => s.setCameraMode);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const perfOverlay = useStore((s) => s.perfOverlay);
  // shared with the actual list CameraRig renders — never hand-count spots here again
  const povCount = usePovList().length;

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
      if (e.key === 'b' || e.key === 'B') {
        // build mode lives inside the free camera; entering releases the pointer
        // lock so the cursor can grab objects (setCameraMode ends it elsewhere)
        if (cur.kind !== 'free') return;
        const st = useStore.getState();
        if (!st.buildMode && document.pointerLockElement) document.exitPointerLock();
        st.setBuildMode(!st.buildMode);
        return;
      }
      if (e.key === 'p' || e.key === 'P') {
        const st = useStore.getState();
        st.setPerfOverlay(!st.perfOverlay);
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        setMode(cur.kind === 'free' ? { kind: 'pov', index: 0 } : { kind: 'free' });
      } else if (e.key === 'Escape') {
        const st = useStore.getState();
        if (st.settingsOpen) setSettingsOpen(false);
        else if (st.buildHold) st.setBuildHold(null); // cancel the in-flight drag first
        else if (st.buildMode) st.setBuildMode(false);
        else if (cur.kind === 'focus') {
          // flag first: FreeFlyControls' mount effect re-locks when it sees it
          if (cur.relock && cur.from.kind === 'free') useStore.getState().setPendingRelock(true);
          setMode(cur.from);
        } else setMode({ kind: 'free' });
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
        // R3F defaults to [1, 2]; on a retina/4K panel that is 4× the fragment
        // work of dpr 1 for a scene that is already fragment-bound. AdaptiveQuality
        // steps down from this ceiling when frames start dropping.
        dpr={[1, MAX_DPR]}
        camera={{ position: [7.5, 6.5, 9], fov: 50 }}
        onPointerMissed={() => {
          // click away from the monitor exits — but only if this same gesture
          // didn't just enter focus (a tap's click raycasts mid-camera-flight
          // and "misses", which must not bounce us straight back out)
          const cur = useStore.getState().cameraMode;
          if (shouldExitFocusOnMissedClick(cur, gestureStartMode.current) && cur.kind === 'focus') {
            if (cur.relock && cur.from.kind === 'free') useStore.getState().setPendingRelock(true);
            setMode(cur.from);
          }
        }}
      >
        <color attach="background" args={['#241d2e']} />
        <fog attach="fog" args={['#141218', 20, 46]} />
        <ambientLight intensity={0.5} color="#ffe9d0" />
        <hemisphereLight args={['#b8c4dc', '#5a4a3a', 0.55]} />
        <Suspense fallback={null}>
          <DuskSky />
          <Office />
          {/* inside the boundary on purpose — see SceneReady */}
          <SceneReady />
        </Suspense>
        <CameraRig />
        <ShadowControl />
        <AdaptiveQuality />
        {perfOverlay && <PerfSampler />}
      </Canvas>

      {perfOverlay && <PerfPanel />}
      {mode.kind === 'free' && pointerLocked && <Crosshair />}
      {/* above the HUD help line, and the only way to answer while pointer-locked */}
      <QuestionBar />
      {/* what the blinking boss-desk beacon is actually waiting on */}
      <AskBar />
      <Hud connected={connected} mode={mode} onSettings={() => setSettingsOpen(true)} />
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}

/**
 * Drops the index.html loading screen once there is something worth looking at.
 *
 * It lives *inside* the Suspense boundary so it only ticks while the scene is
 * actually mounted: the roster arrives over the WebSocket after first paint, and
 * the characters it pulls in re-suspend the subtree — a probe outside the
 * boundary would fade the spinner out onto an empty room. It also waits for the
 * office state itself, so the reveal is a furnished room rather than bare floor,
 * with a short grace period so a dead server still gets you into the scene.
 */
const OFFICE_WAIT_S = 3;
const SETTLE_FRAMES = 2;

function SceneReady() {
  const office = useStore((s) => s.office);
  const frames = useRef(0);
  const waited = useRef(0);
  useFrame((_, delta) => {
    waited.current += delta;
    if (!office && waited.current < OFFICE_WAIT_S) return;
    // one more frame after the models resolve, so the fade uncovers a drawn scene
    if (++frames.current >= SETTLE_FRAMES) dismissBootScreen();
  });
  return null;
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
  const buildMode = useStore((s) => s.buildMode);
  const officeName = office?.officeName ?? 'This Office';
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const commitName = () => {
    setEditingName(false);
    if (nameDraft.trim() === officeName) return;
    // empty draft is sent too: the server maps it back to the default name
    fetch('/api/office', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameDraft }),
    }).catch(() => {});
  };
  const focusName =
    mode.kind === 'focus'
      ? mode.target === 'boss'
        ? office?.boss.name ?? 'Boss'
        : office?.employees.find((e) => e.id === mode.target)?.name ?? 'screen'
      : '';
  const label =
    mode.kind === 'free' && buildMode
      ? 'Build mode — drag objects to move · hold Ctrl while dragging to rotate · right-drag look · WASD fly · red = blocked · B/Esc exit'
      : mode.kind === 'free'
      ? 'Free camera — click to look (Esc releases) · WASD fly · E/Space up · C down · Shift slow · V for POV tour · M movie mode · B build mode'
      : mode.kind === 'movie'
        ? 'Movie mode — auto-follows the action · arrows cut now · right-drag for first person · M/Esc exit'
        : mode.kind === 'focus' && mode.target === 'tv'
          ? 'Stats TV — scroll wheel to flip through stats · Esc or click away = back'
        : mode.kind === 'focus'
          ? `Screen: ${focusName} — scroll wheel for history · End = live · Esc or click away = back`
          : `POV: ${povs[Math.min(mode.index, povs.length - 1)]?.label ?? ''} — Tab/← → cycle · right-drag for first person · V/Esc exit`;
  return (
    <>
      <div style={hudStyles.topLeft}>
        <span style={{ ...hudStyles.dot, background: connected ? '#4cc38a' : '#e5484d' }} />
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            maxLength={60}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              else if (e.key === 'Escape') setEditingName(false);
            }}
            style={hudStyles.nameInput}
          />
        ) : (
          <span
            style={{ cursor: 'text' }}
            title="Click to rename"
            onClick={() => {
              setNameDraft(officeName);
              setEditingName(true);
            }}
          >
            {officeName}
          </span>
        )}
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
    display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto',
  },
  dot: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block' },
  nameInput: {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: 4, color: '#e6e8eb', fontFamily: 'system-ui, sans-serif',
    fontSize: 15, fontWeight: 600, padding: '1px 6px', outline: 'none', width: 180,
  },
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
