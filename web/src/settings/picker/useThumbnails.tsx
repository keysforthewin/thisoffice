import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import type { CharacterEntry } from '../../../../shared/types.ts';
import { useStore } from '../../store.ts';
import { resolveClip } from '../../characters/catalog.ts';
import { useCharacterModel } from '../../characters/useCharacterModel.ts';
import { useThumbStore } from './thumbStore.ts';

const THUMB_SIZE = 128;
/** bump when thumbnail framing/lighting changes to invalidate cached snapshots */
const THUMB_REV = 4;

function cacheKey(version: number, id: string, rev?: number) {
  return `charthumb:v${version}.${THUMB_REV}:${id}:${rev ?? 0}`;
}

function readCache(version: number, id: string, rev?: number): string | null {
  try {
    return localStorage.getItem(cacheKey(version, id, rev));
  } catch {
    return null;
  }
}

function writeCache(version: number, id: string, rev: number | undefined, dataUrl: string) {
  try {
    localStorage.setItem(cacheKey(version, id, rev), dataUrl);
  } catch {
    // quota exceeded — keep the in-memory copy only
  }
}

/** revs already reflected in the in-memory thumb store; a change means re-import */
const hydratedRevs = new Map<string, number | undefined>();

/** Load cached thumbnails from localStorage into the thumb store. */
export function useHydrateThumbs() {
  const catalog = useStore((s) => s.catalog);
  useEffect(() => {
    if (!catalog) return;
    const { thumbs, setThumb } = useThumbStore.getState();
    for (const c of catalog.characters) {
      const revChanged = hydratedRevs.has(c.id) && hydratedRevs.get(c.id) !== c.rev;
      hydratedRevs.set(c.id, c.rev);
      if (revChanged) {
        setThumb(c.id, ''); // falsy -> ThumbnailFactory re-renders it from the new model
        continue;
      }
      if (!thumbs[c.id]) {
        const cached = readCache(catalog.version, c.id, c.rev);
        if (cached) setThumb(c.id, cached);
      }
    }
  }, [catalog]);
}

/**
 * Invisible sequential snapshot renderer. Mounted while the picker is open;
 * renders each un-thumbnailed character once in a small offscreen canvas and
 * caches the PNG dataURL in localStorage + the thumb store.
 */
export function ThumbnailFactory() {
  const catalog = useStore((s) => s.catalog);
  const thumbs = useThumbStore((s) => s.thumbs);
  const setThumb = useThumbStore((s) => s.setThumb);
  useHydrateThumbs();

  const pending = useMemo(
    () => (catalog?.characters ?? []).filter((c) => !thumbs[c.id]),
    [catalog, thumbs],
  );
  const current = pending[0];

  if (!catalog || !current) return null;

  return (
    <div style={{ position: 'fixed', left: -2000, top: 0, width: THUMB_SIZE, height: THUMB_SIZE, pointerEvents: 'none' }}>
      <Canvas
        dpr={1}
        camera={{ position: [0, 1.9, 3.9], fov: 38 }}
        onCreated={({ camera }) => camera.lookAt(0, 1.1, 0)}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
      >
        <color attach="background" args={['#12161c']} />
        <ambientLight intensity={0.7} color="#ffe9d0" />
        <hemisphereLight args={['#b8c4dc', '#5a4a3a', 0.5]} />
        <directionalLight position={[2.5, 4, 2.5]} color="#fff1dc" intensity={1.5} />
        <Suspense fallback={null}>
          <Snap
            key={current.id}
            entry={current}
            onDone={(dataUrl) => {
              writeCache(catalog.version, current.id, current.rev, dataUrl);
              setThumb(current.id, dataUrl);
            }}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

function Snap({ entry, onDone }: { entry: CharacterEntry; onDone: (dataUrl: string) => void }) {
  const catalog = useStore((s) => s.catalog);
  const { clone, clips } = useCharacterModel(entry.id, entry);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(clips, group);
  const { gl } = useThree();
  const frames = useRef(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const idle = resolveClip(actions, 'Idle', catalog?.clipAliases);
    if (!idle) return;
    idle.reset().play();
    idle.getMixer().update(0.05); // snap the pose now so the first rendered frame isn't the T-pose
    return () => {
      idle.stop();
    };
  }, [actions, catalog]);

  useFrame(() => {
    if (done) return;
    frames.current += 1;
    // a few frames of margin so the posed model is what preserveDrawingBuffer holds
    if (frames.current >= 4) {
      setDone(true);
      onDone(gl.domElement.toDataURL('image/png'));
    }
  });

  return (
    <group ref={group} rotation={[0, -0.5, 0]}>
      <primitive object={clone} />
    </group>
  );
}
