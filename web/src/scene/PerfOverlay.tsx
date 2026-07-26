import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/**
 * Dev-only render readout, toggled with P. Split in two because the numbers
 * come from inside the Canvas (useFrame/useThree) but the panel is DOM:
 * `<PerfSampler>` mounts in the scene and pushes samples through a module-level
 * subscription; `<PerfPanel>` renders them next to the HUD.
 *
 * The sampler flushes at FLUSH_MS, never per frame — a React setState every
 * frame would itself cost more than most of what we're trying to measure.
 */

export interface PerfSample {
  fps: number;
  frameMs: number;
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  dpr: number;
}

const FLUSH_MS = 250;

type Listener = (s: PerfSample) => void;
const listeners = new Set<Listener>();

/**
 * Samples renderer counters once per frame and publishes a rolling average.
 * `gl.info.render` is reset at the top of each `render()`, so reading here —
 * before this frame renders — reports the frame that just finished.
 */
export function PerfSampler() {
  const gl = useThree((s) => s.gl);
  const acc = useRef({ frames: 0, ms: 0, since: 0 });

  useFrame((_, delta) => {
    const a = acc.current;
    a.frames++;
    a.ms += delta * 1000;
    a.since += delta * 1000;
    if (a.since < FLUSH_MS) return;

    const info = gl.info;
    const sample: PerfSample = {
      fps: (a.frames * 1000) / a.since,
      frameMs: a.ms / a.frames,
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      dpr: gl.getPixelRatio(),
    };
    a.frames = 0;
    a.ms = 0;
    a.since = 0;
    for (const fn of listeners) fn(sample);
  });

  return null;
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

export function PerfPanel() {
  const [s, setS] = useState<PerfSample | null>(null);
  useEffect(() => {
    listeners.add(setS);
    return () => void listeners.delete(setS);
  }, []);

  if (!s) return null;
  // green/amber/red against the 60fps target
  const color = s.fps >= 55 ? '#7ee081' : s.fps >= 40 ? '#e8c46a' : '#e87a7a';

  const rows: Array<[string, string]> = [
    ['fps', s.fps.toFixed(0)],
    ['frame', `${s.frameMs.toFixed(1)} ms`],
    ['calls', fmt(s.calls)],
    ['tris', fmt(s.triangles)],
    ['programs', `${s.programs}`],
    ['geom/tex', `${s.geometries}/${s.textures}`],
    ['dpr', s.dpr.toFixed(2)],
  ];

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        padding: '8px 10px',
        background: 'rgba(16,14,20,0.82)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 6,
        font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#cfc9d8',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 20,
        minWidth: 118,
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ opacity: 0.6 }}>{k}</span>
          <span style={k === 'fps' ? { color, fontWeight: 600 } : undefined}>{v}</span>
        </div>
      ))}
    </div>
  );
}
