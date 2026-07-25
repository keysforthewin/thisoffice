/** Alpha-cutout city layer placement, in the window opening's local frame:
 *  opening center at the origin, outside = -z. Tuned by eye; adjust freely —
 *  but keep the invariant below (vistaLayers.test.ts enforces it).
 *
 *  Constraint (do not regress): the back window's layers are shifted +x so no
 *  layer crosses the left wall plane — world x = -7.6, which is local x ≈ -3.8
 *  for that opening — otherwise they'd be visible edge-on through the left
 *  window. Future movable-windows work must preserve this. The seamless sky
 *  behind the layers is scene-global (DuskSky) and needs no such care. */
export interface VistaLayer { url: string; z: number; w: number; h: number; x: number; y: number }

/** Left wall plane in the back opening's local x (world -7.6, opening at -3.8). */
export const BACK_LOCAL_WALL_X = -3.7;

export const VISTA_LAYERS: Record<'back' | 'left', VistaLayer[]> = {
  back: [
    { url: '/vista/back-skyline.png', z: -18, w: 24, h: 9, x: 8.4, y: -1.2 },
    { url: '/vista/back-mid.png', z: -11, w: 16, h: 9, x: 4.4, y: -2.8 },
    { url: '/vista/back-near.png', z: -4.5, w: 10, h: 6, x: 1.4, y: -2.2 },
  ],
  left: [
    { url: '/vista/left-skyline.png', z: -18, w: 24, h: 9, x: 0, y: -1.2 },
    { url: '/vista/left-mid.png', z: -11, w: 16, h: 9, x: 0, y: -2.8 },
    { url: '/vista/left-near.png', z: -4.5, w: 10, h: 6, x: 0, y: -2.2 },
  ],
};
