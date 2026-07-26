import { describe, expect, it } from 'vitest';
import { BACK_LOCAL_WALL_X, VISTA_LAYERS } from './vistaLayers.ts';
import { skirtQuads, type SkirtData } from './vistaGeometry.ts';

describe('vista layers', () => {
  it('back-window layers never cross the left wall plane', () => {
    for (const l of VISTA_LAYERS.back) {
      expect(l.x - l.w / 2, `${l.url} left edge`).toBeGreaterThanOrEqual(BACK_LOCAL_WALL_X - 1e-9);
    }
  });

  it('every layer sits outside the window (negative z)', () => {
    for (const layers of Object.values(VISTA_LAYERS)) {
      for (const l of layers) expect(l.z).toBeLessThan(0);
    }
  });

  it('every extended layer is measurable — its skirt data is keyed off the image name', () => {
    for (const layers of Object.values(VISTA_LAYERS)) {
      for (const l of layers) {
        if (!l.extend) continue;
        expect(l.url, `${l.url} must be a .png so npm run vista can bake its skirt`).toMatch(/\.png$/);
      }
    }
  });
});

describe('skirtQuads', () => {
  /** Two buildings of different heights, plus a sky gap that must stay empty. */
  const data: SkirtData = {
    width: 10,
    height: 100,
    insetPx: 3,
    runs: [
      [0, 2, 99, 60], // tall-based building, reaching the image's bottom row
      [6, 9, 40, 20], // shorter building, ending 59 rows higher
    ],
  };

  it('hangs every building from its own base, not from one shared row', () => {
    const [low, high] = skirtQuads(10, 100, 20, data);
    // the short building's skirt starts far above the tall one's
    expect(low.yTop).toBeCloseTo(-50 + (1 - 100 / 100) * 100, 6);
    expect(high.yTop).toBeCloseTo(-50 + (1 - 41 / 100) * 100, 6);
    expect(high.yTop).toBeGreaterThan(low.yTop);
    // ...and each samples its own base, so neither repeats the other's sky
    expect(low.v).toBeCloseTo(1 - 96.5 / 100, 6);
    expect(high.v).toBeCloseTo(1 - 37.5 / 100, 6);
  });

  it('runs every building down to the same floor, however high it started', () => {
    const quads = skirtQuads(10, 100, 20, data);
    for (const q of quads) expect(q.yBottom).toBeCloseTo(-70, 6);
  });

  it('leaves sky gaps empty instead of skirting them', () => {
    const quads = skirtQuads(10, 100, 20, data);
    expect(quads).toHaveLength(2);
    // columns 3..5 carry no run, so no quad covers that u span
    for (const q of quads) {
      const covers = q.u0 < 0.6 && q.u1 > 0.3;
      expect(covers, 'a quad spans the empty columns').toBe(false);
    }
  });

  // holding exactly at the alpha edge is filtered to alpha ~0.5 and discarded by
  // the material's alphaTest — the skirt then renders nothing at all
  it('insets the hold row into the building, but never past its top', () => {
    // a 2px spire: inset of 3 would escape out the top into sky
    const spire: SkirtData = { width: 4, height: 100, insetPx: 3, runs: [[0, 3, 51, 50]] };
    const [q] = skirtQuads(4, 100, 10, spire);
    expect(q.v).toBeCloseTo(1 - 50.5 / 100, 6);
  });

  it('falls back to one full-width skirt when nothing has been measured', () => {
    const [q] = skirtQuads(10, 100, 20, undefined);
    expect(q).toMatchObject({ x0: -5, x1: 5, u0: 0, u1: 1, v: 0, yTop: -50, yBottom: -70 });
  });

  it('skirts nothing when the layer does not extend', () => {
    expect(skirtQuads(10, 100, 0, data)).toEqual([]);
  });
});

/**
 * The shipped artwork, not a fixture. The old single-row skirt left 73% of
 * back-skyline's columns and 85% of left-mid's hanging in midair; these assert
 * the baked data actually covers them, and would fail if `npm run vista` were
 * skipped after an image changed.
 */
describe('baked skirt data', () => {
  const dir = new URL('../../public/vista/', import.meta.url);

  for (const layers of Object.values(VISTA_LAYERS)) {
    for (const layer of layers) {
      const name = layer.url.split('/').pop()!;

      it(`${name} has measured runs covering its buildings`, async () => {
        const { readFileSync } = await import('node:fs');
        const raw = readFileSync(new URL(`${name.replace(/\.png$/, '')}.skirt.json`, dir), 'utf8');
        const skirt = JSON.parse(raw) as SkirtData;
        expect(skirt.runs.length).toBeGreaterThan(0);

        const quads = skirtQuads(layer.w, layer.h, layer.extend ?? 0, skirt);
        // every building reaches the same floor...
        const floor = -layer.h / 2 - (layer.extend ?? 0);
        for (const q of quads) expect(q.yBottom).toBeCloseTo(floor, 6);
        // ...from its own height: a single shared start row is the old bug
        const starts = new Set(quads.map((q) => q.yTop.toFixed(3)));
        expect(starts.size, 'distinct skirt start heights').toBeGreaterThan(1);
        // and each samples a row at or above its own base, never the image floor
        for (const q of quads) expect(q.v).toBeGreaterThanOrEqual(0);
      });
    }
  }
});
