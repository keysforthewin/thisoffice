import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import type { CharacterEntry } from '../../../../shared/types.ts';
import { useStore } from '../../store.ts';
import { catalogEntry, resolveClip } from '../../characters/catalog.ts';
import { useCharacterModel } from '../../characters/useCharacterModel.ts';

export function CharacterPreview({ entry }: { entry?: CharacterEntry }) {
  // debounce so arrow-key scrubbing doesn't fetch every intermediate GLB
  const [shown, setShown] = useState(entry);
  useEffect(() => {
    const t = setTimeout(() => setShown(entry), 150);
    return () => clearTimeout(t);
  }, [entry]);

  return (
    <div style={styles.wrap}>
      <div style={styles.canvasBox}>
        <Canvas
          dpr={[1, 1.5]}
          camera={{ position: [0, 1.9, 4.4], fov: 40 }}
          onCreated={({ camera }) => camera.lookAt(0, 1.1, 0)}
          shadows
        >
          <color attach="background" args={['#12161c']} />
          <ambientLight intensity={0.6} color="#ffe9d0" />
          <hemisphereLight args={['#b8c4dc', '#5a4a3a', 0.5]} />
          <directionalLight castShadow position={[2.5, 4, 2.5]} color="#fff1dc" intensity={1.6} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <circleGeometry args={[1.5, 48]} />
            <meshStandardMaterial color="#1b212a" />
          </mesh>
          {shown && (
            <Suspense fallback={null}>
              <PreviewModel key={shown.id} entry={shown} />
            </Suspense>
          )}
        </Canvas>
      </div>
      <div style={styles.footer}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{entry?.displayName ?? '—'}</div>
        <div style={{ fontSize: 12, color: '#9aa4b0' }}>
          {entry?.pack}
          {entry && (
            <span style={{ color: '#7c8794' }}>
              {entry.pack === 'Mixamo' ? ' · via Adobe Mixamo (your import)' : ' · by Kay Lousberg, CC0'}
            </span>
          )}
        </div>
        {entry && entry.tags.length > 0 && (
          <div style={styles.tags}>
            {entry.tags.map((t) => (
              <span key={t} style={styles.tag}>{t}</span>
            ))}
          </div>
        )}
        {entry?.pack === 'Mixamo' && <ScaleSlider key={entry.id} id={entry.id} />}
      </div>
    </div>
  );
}

function PreviewModel({ entry }: { entry: CharacterEntry }) {
  const catalog = useStore((s) => s.catalog);
  const scale = useStore((s) => catalogEntry(s.catalog, entry.id)?.scale ?? 1);
  const { clone, clips } = useCharacterModel(entry.id, entry);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(clips, group);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.frustumCulled = false;
      }
    });
  }, [clone]);

  const idle = useMemo(() => resolveClip(actions, 'Idle', catalog?.clipAliases), [actions, catalog]);

  useEffect(() => {
    idle?.reset().play();
    return () => {
      idle?.stop();
    };
  }, [idle]);

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.6;
  });

  return (
    <group ref={group}>
      <primitive object={clone} scale={scale} />
    </group>
  );
}

/** Log-scale size control for imported characters: 0.1× – 10×, persisted per character. */
function ScaleSlider({ id }: { id: string }) {
  const scale = useStore((s) => catalogEntry(s.catalog, id)?.scale ?? 1);
  const setCharacterScale = useStore((s) => s.setCharacterScale);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);

  const persist = useCallback((value: number) => {
    pending.current = null;
    fetch(`/api/characters/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: value }),
    }).catch(() => {
      /* slider keeps working locally; next successful PATCH wins */
    });
  }, [id]);

  const apply = (value: number) => {
    setCharacterScale(id, value);
    pending.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(value), 300);
  };

  // flush a pending change when the picker closes mid-debounce
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current !== null) persist(pending.current);
  }, [persist]);

  return (
    <div style={styles.scaleRow}>
      <span style={styles.scaleLabel}>Size</span>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={Math.log10(scale)}
        onChange={(e) => apply(Number((10 ** Number(e.target.value)).toFixed(2)))}
        style={{ flex: 1 }}
      />
      <span style={styles.scaleValue}>{scale.toFixed(2)}×</span>
      <button style={styles.scaleReset} onClick={() => apply(1)} title="Reset to 1×">↺</button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minWidth: 0 },
  canvasBox: {
    flex: 1, minHeight: 0, borderRadius: 10, overflow: 'hidden',
    border: '1px solid #2c333d', background: '#12161c',
  },
  footer: { display: 'flex', flexDirection: 'column', gap: 4 },
  tags: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 },
  tag: {
    fontSize: 11, color: '#9aa4b0', background: '#0e1116',
    border: '1px solid #2c333d', borderRadius: 10, padding: '2px 8px',
  },
  scaleRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
  scaleLabel: { fontSize: 12, color: '#9aa4b0' },
  scaleValue: { fontSize: 12, color: '#e6e8eb', minWidth: 44, textAlign: 'right' as const },
  scaleReset: {
    background: 'none', border: '1px solid #2c333d', color: '#9aa4b0',
    borderRadius: 5, cursor: 'pointer', fontSize: 12, padding: '2px 7px',
  },
};
