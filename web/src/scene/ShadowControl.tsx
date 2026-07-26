import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../store.ts';

/**
 * The scene has one shadow-casting point light, which means a shadow *cube* —
 * six full scene renders. three re-renders all six every frame by default, even
 * though almost nothing that casts a shadow ever moves. This drives the shadow
 * map manually instead: refresh on the events that actually change the scene,
 * and idle the rest of the time.
 *
 * Three things force a refresh:
 *  - **Build mode.** Dragging furniture moves shadow casters every frame, so
 *    while build mode (or an in-flight drag) is active the map updates every
 *    frame exactly as it used to. Build mode is a deliberate, stationary
 *    editing state — paying full shadow cost there costs nothing that matters,
 *    and a stale shadow under a dragged desk would look broken.
 *  - **Scene changes.** Hires, evictions, layout patches and desk-count changes
 *    add or move geometry. These stay dirty for SETTLE_MS afterwards because
 *    the GLB for a new desk or character streams in a few frames later.
 *  - **A slow heartbeat.** Characters animate and cast shadows, so their
 *    shadows would otherwise freeze in one pose. HEARTBEAT_MS re-renders them
 *    occasionally — twice a second instead of sixty times — which reads as
 *    correct for a seated idle loop and also backstops any invalidation this
 *    component fails to notice.
 */

/** Keep refreshing this long after a scene change, to catch async GLB loads. */
const SETTLE_MS = 1200;
/** Idle refresh cadence: enough for slow idle animations, ~1/120th the cost. */
const HEARTBEAT_MS = 500;

export function ShadowControl() {
  const gl = useThree((s) => s.gl);
  const layout = useStore((s) => s.office?.layout);
  const buildMode = useStore((s) => s.buildMode);
  const buildHold = useStore((s) => s.buildHold);
  const catalog = useStore((s) => s.catalog);
  // identity of the roster, not its contents: hires/evictions/reseats only
  const roster = useStore((s) =>
    s.office ? s.office.employees.map((e) => `${e.id}:${e.seat}:${e.variant}`).join(',') : ''
  );

  const dirtyUntil = useRef(0);
  const lastBeat = useRef(0);

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      // hand the renderer back the way we found it (HMR, unmount)
      gl.shadowMap.autoUpdate = true;
    };
  }, [gl]);

  // any scene-shaping change re-dirties for a settle window
  useEffect(() => {
    dirtyUntil.current = performance.now() + SETTLE_MS;
  }, [layout, roster, catalog, buildMode]);

  useFrame(() => {
    const now = performance.now();
    // a drag moves casters continuously — track it frame by frame
    if (buildMode || buildHold) {
      gl.shadowMap.needsUpdate = true;
      // and stay dirty briefly after the drag ends so the final pose lands
      dirtyUntil.current = now + SETTLE_MS;
      return;
    }
    if (now < dirtyUntil.current) {
      gl.shadowMap.needsUpdate = true;
      return;
    }
    if (now - lastBeat.current >= HEARTBEAT_MS) {
      lastBeat.current = now;
      gl.shadowMap.needsUpdate = true;
    }
  });

  return null;
}
