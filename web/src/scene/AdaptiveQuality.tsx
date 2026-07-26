import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/**
 * Trades resolution for frame rate when the machine can't keep up, and hands it
 * back when it can.
 *
 * Resolution is the right dial: fragment cost scales with the square of the
 * pixel ratio, and the office is fragment-bound (several point lights, every
 * surface a StandardMaterial). Dropping from 1.5 to 1.0 removes ~55% of the
 * shaded pixels while leaving geometry, animation and layout untouched — nothing
 * moves or disappears, the image just softens.
 *
 * Oscillation is the failure mode to design against: stepping down raises fps,
 * which would immediately justify stepping back up, which lowers it again. Three
 * guards prevent that — a gap between the down and up thresholds, a dwell time
 * after any change, and a requirement that "fast enough" hold for a sustained
 * window rather than a single lucky sample.
 */

/** Descending order; index 0 is the best-looking rung we ever use. */
const BASE_STEPS = [1.5, 1.25, 1.0];

/**
 * The rungs actually available on this display, clamped to its native pixel
 * ratio and de-duplicated.
 *
 * The clamp is essential, not cosmetic: `dpr` is an absolute device-pixel ratio,
 * not a fraction of native. On a plain 1× monitor the raw ladder's second rung
 * (1.25) is *above* native, so "stepping down" would render 56% more pixels
 * precisely when the machine is already dropping frames — the opposite of the
 * intent, and a feedback loop that keeps making things worse. On such a display
 * the ladder collapses to a single rung and adaptation correctly does nothing;
 * there is no resolution to give back.
 */
export function qualityLadder(devicePixelRatio: number): number[] {
  const capped = BASE_STEPS.map((s) => Math.min(s, devicePixelRatio));
  return capped.filter((v, i) => i === 0 || v !== capped[i - 1]);
}

const SAMPLE_MS = 500;
/** Below this we are visibly dropping frames — step down. */
const DOWN_FPS = 45;
/** Comfortably above 60fps-with-headroom before we consider stepping back up. */
const UP_FPS = 58;
/** How long UP_FPS must hold before we risk a step up. */
const UP_HOLD_MS = 5000;
/** Minimum time between any two changes, in either direction. */
const DWELL_MS = 2500;

export function AdaptiveQuality() {
  const setDpr = useThree((s) => s.setDpr);
  const steps = useRef<number[] | null>(null);
  const step = useRef(0);
  const frames = useRef(0);
  const elapsed = useRef(0);
  const lastChange = useRef(0);
  const fastSince = useRef<number | null>(null);

  useFrame((_, delta) => {
    if (steps.current === null) steps.current = qualityLadder(window.devicePixelRatio);
    const STEPS = steps.current;
    // a 1× display has nothing to trade away
    if (STEPS.length < 2) return;

    frames.current++;
    elapsed.current += delta * 1000;
    if (elapsed.current < SAMPLE_MS) return;

    const fps = (frames.current * 1000) / elapsed.current;
    const now = performance.now();
    frames.current = 0;
    elapsed.current = 0;

    if (fps < UP_FPS) fastSince.current = null;
    else if (fastSince.current === null) fastSince.current = now;

    if (now - lastChange.current < DWELL_MS) return;

    if (fps < DOWN_FPS && step.current < STEPS.length - 1) {
      step.current++;
      lastChange.current = now;
      fastSince.current = null;
      setDpr(STEPS[step.current]);
      return;
    }

    if (
      step.current > 0 &&
      fastSince.current !== null &&
      now - fastSince.current >= UP_HOLD_MS
    ) {
      step.current--;
      lastChange.current = now;
      fastSince.current = null;
      setDpr(STEPS[step.current]);
    }
  });

  return null;
}

/** Ceiling for the Canvas `dpr` prop; the adaptive steps start here. */
export const MAX_DPR = BASE_STEPS[0];
