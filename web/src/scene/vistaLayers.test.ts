import { describe, expect, it } from 'vitest';
import { BACK_LOCAL_WALL_X, VISTA_LAYERS } from './vistaLayers.ts';

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
});
