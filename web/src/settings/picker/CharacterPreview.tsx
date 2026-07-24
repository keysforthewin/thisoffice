import { Suspense, useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    const idle = resolveClip(actions, 'Idle', catalog?.clipAliases);
    idle?.reset().play();
    return () => {
      idle?.stop();
    };
  }, [actions, catalog]);

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.6;
  });

  return (
    <group ref={group}>
      <primitive object={clone} scale={scale} />
    </group>
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
};
