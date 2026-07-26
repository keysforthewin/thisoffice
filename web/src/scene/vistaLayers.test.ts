import { describe, expect, it } from 'vitest';
import { BACK_LOCAL_WALL_X, VISTA_LAYERS } from './vistaLayers.ts';
import { SKIRT_INSET_V, vistaRows } from './vistaGeometry.ts';

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

  // An extended layer whose image has transparent padding at the bottom repeats
  // that padding instead of its facades — the bug that left the mid layers
  // floating. trimBottom must be stated deliberately, even when it is 0.
  it('every extended layer declares its bottom padding', () => {
    for (const layers of Object.values(VISTA_LAYERS)) {
      for (const l of layers) {
        if (!l.extend) continue;
        expect(l.trimBottom, `${l.url} trimBottom`).toBeTypeOf('number');
        expect(l.trimBottom).toBeGreaterThanOrEqual(0);
        expect(l.trimBottom).toBeLessThan(0.5);
      }
    }
  });
});

describe('vistaRows', () => {
  it('keeps the artwork where it was authored and skirts below it', () => {
    const [top, artBottom, skirt] = vistaRows(9, 16, 0);
    expect(top).toEqual({ y: 4.5, v: 1 });
    expect(artBottom).toEqual({ y: -4.5, v: 0 });
    expect(skirt).toEqual({ y: -20.5, v: 0 });
  });

  it('ends the artwork just inside the last opaque row when the image is padded', () => {
    const [top, artBottom, skirt] = vistaRows(10, 5, 0.2);
    const hold = 0.2 + SKIRT_INSET_V;
    expect(top).toEqual({ y: 5, v: 1 });
    // 20% of the image is padding, so the art quad is ~8 units tall, not 10
    expect(artBottom.y).toBeCloseTo(5 - 10 * (1 - hold));
    expect(artBottom.v).toBeCloseTo(hold);
    // the skirt repeats that same row all the way down
    expect(skirt.v).toBeCloseTo(hold);
    expect(skirt.y).toBeCloseTo(artBottom.y - 5);
  });

  // holding exactly at the alpha edge is filtered to alpha ~0.5 and discarded by
  // the material's alphaTest — the skirt then renders nothing at all
  it('holds strictly inside the artwork, never on the alpha edge', () => {
    expect(vistaRows(9, 16, 0.14355)[1].v).toBeGreaterThan(0.14355);
  });
});
