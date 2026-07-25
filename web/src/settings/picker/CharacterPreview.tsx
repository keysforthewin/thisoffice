import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import type { CharacterEntry } from '../../../../shared/types.ts';
import { useStore } from '../../store.ts';
import { catalogEntry, resolveClip } from '../../characters/catalog.ts';
import { useCharacterModel } from '../../characters/useCharacterModel.ts';
import { FurnitureModel, CHAIR_OFFSET_Z, PERSON_OFFSET_Z, PERSON_LIFT_Y } from '../../scene/Desk.tsx';

export function CharacterPreview({ entry }: { entry?: CharacterEntry }) {
  // debounce so arrow-key scrubbing doesn't fetch every intermediate GLB
  const [shown, setShown] = useState(entry);
  useEffect(() => {
    const t = setTimeout(() => setShown(entry), 150);
    return () => clearTimeout(t);
  }, [entry]);

  const seated = shown?.pack === 'Mixamo';

  return (
    <div style={styles.wrap}>
      <div style={styles.canvasBox}>
        <Canvas
          key={seated ? 'seated' : 'idle'}
          dpr={[1, 1.5]}
          camera={seated ? { position: [3.1, 2.5, -3.3], fov: 40 } : { position: [0, 1.9, 4.4], fov: 40 }}
          onCreated={({ camera }) => camera.lookAt(0, 1.1, seated ? -0.6 : 0)}
          shadows
        >
          <color attach="background" args={['#12161c']} />
          <ambientLight intensity={0.6} color="#ffe9d0" />
          <hemisphereLight args={['#b8c4dc', '#5a4a3a', 0.5]} />
          <directionalLight castShadow position={[2.5, 4, 2.5]} color="#fff1dc" intensity={1.6} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <circleGeometry args={[seated ? 2.4 : 1.5, 48]} />
            <meshStandardMaterial color="#1b212a" />
          </mesh>
          {shown && (
            <Suspense fallback={null}>
              {seated ? <SeatedPreview key={shown.id} entry={shown} /> : <PreviewModel key={shown.id} entry={shown} />}
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
        {entry?.pack === 'Mixamo' && ADJUSTS.map((spec) => (
          <AdjustSlider key={`${entry.id}:${spec.field}`} id={entry.id} spec={spec} />
        ))}
      </div>
    </div>
  );
}

/** The character sitting at a real desk+chair — same offsets as Desk.tsx — so
 *  Size / Seat offset / Chair height are judged against desk-top and seat. */
function SeatedPreview({ entry }: { entry: CharacterEntry }) {
  const live = useStore((s) => catalogEntry(s.catalog, entry.id));
  const chairHeight = live?.chairHeight ?? 0;
  return (
    <group rotation={[0, 0.55, 0]}>
      <FurnitureModel url="/models/furniture/table_medium.gltf" />
      <FurnitureModel url="/models/furniture/chair_A.gltf" position={[0, chairHeight, CHAIR_OFFSET_Z]} />
      <SeatedModel entry={entry} position={[0, PERSON_LIFT_Y + chairHeight, PERSON_OFFSET_Z]} />
    </group>
  );
}

function SeatedModel({ entry, position }: { entry: CharacterEntry; position: [number, number, number] }) {
  const catalog = useStore((s) => s.catalog);
  const live = catalogEntry(catalog, entry.id);
  const scale = live?.scale ?? 1;
  const seatOffset = live?.seatOffset ?? 0;
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

  // resolve in an effect, not render — actions are null until the group mounts (see Person.tsx)
  const [sit, setSit] = useState<THREE.AnimationAction | null>(null);
  useEffect(() => {
    setSit(resolveClip(actions, 'Sit_Chair_Idle', catalog?.clipAliases));
  }, [actions, catalog]);
  useEffect(() => {
    sit?.reset().play();
    return () => { sit?.stop(); };
  }, [sit]);

  return (
    <group ref={group} position={position}>
      <primitive object={clone} scale={scale} position={[0, seatOffset, 0]} />
    </group>
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

interface AdjustSpec {
  field: 'scale' | 'seatOffset' | 'chairHeight';
  label: string;
  min: number; max: number; step: number;
  fallback: number;
  /** slider-value ↔ real-value mapping (scale is log10; offsets are identity) */
  toSlider: (v: number) => number;
  fromSlider: (v: number) => number;
  format: (v: number) => string;
}

const ADJUSTS: AdjustSpec[] = [
  { field: 'scale', label: 'Size', min: -1, max: 1, step: 0.01, fallback: 1,
    toSlider: Math.log10, fromSlider: (v) => Number((10 ** v).toFixed(2)), format: (v) => `${v.toFixed(2)}×` },
  { field: 'seatOffset', label: 'Seat offset', min: -0.5, max: 0.5, step: 0.01, fallback: 0,
    toSlider: (v) => v, fromSlider: (v) => v, format: (v) => v.toFixed(2) },
  { field: 'chairHeight', label: 'Chair height', min: -0.4, max: 0.4, step: 0.01, fallback: 0,
    toSlider: (v) => v, fromSlider: (v) => v, format: (v) => v.toFixed(2) },
];

/** Generalized slider for scale / seatOffset / chairHeight: same debounce/flush/PATCH pattern. */
function AdjustSlider({ id, spec }: { id: string; spec: AdjustSpec }) {
  const value = useStore((s) => catalogEntry(s.catalog, id)?.[spec.field] ?? spec.fallback);
  const patchCharacter = useStore((s) => s.patchCharacter);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);

  const persist = useCallback((v: number) => {
    pending.current = null;
    fetch(`/api/characters/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [spec.field]: v }),
    }).catch(() => { /* slider keeps working locally; next successful PATCH wins */ });
  }, [id, spec.field]);

  const apply = (v: number) => {
    patchCharacter(id, { [spec.field]: v });
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(v), 300);
  };

  // flush a pending change when the picker closes mid-debounce
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current !== null) persist(pending.current);
  }, [persist]);

  return (
    <div style={styles.scaleRow}>
      <span style={styles.scaleLabel}>{spec.label}</span>
      <input type="range" min={spec.min} max={spec.max} step={spec.step}
        value={spec.toSlider(value)}
        onChange={(e) => apply(spec.fromSlider(Number(e.target.value)))}
        style={{ flex: 1 }} />
      <span style={styles.scaleValue}>{spec.format(value)}</span>
      <button style={styles.scaleReset} onClick={() => apply(spec.fallback)} title="Reset">↺</button>
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
