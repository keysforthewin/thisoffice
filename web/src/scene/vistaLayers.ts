/** Alpha-cutout city layer placement, in the window opening's local frame:
 *  opening center at the origin, outside = -z. Tuned by eye; adjust freely —
 *  but keep the invariant below (vistaLayers.test.ts enforces it).
 *
 *  Constraint (do not regress): the back window's layers are shifted +x so no
 *  layer crosses the left wall plane — world x = -7.6, which is local x ≈ -3.8
 *  for that opening — otherwise they'd be visible edge-on through the left
 *  window. Future movable-windows work must preserve this. The seamless sky
 *  behind the layers is scene-global (DuskSky) and needs no such care. */
export interface VistaLayer {
  url: string;
  z: number;
  w: number;
  h: number;
  x: number;
  y: number;
  /**
   * Extra world height added *below* the layer so its facades run down out of
   * sight instead of ending in midair.
   *
   * The image itself is not stretched: `w`/`h`/`x`/`y` still describe exactly
   * where the artwork sits. WindowVista grows the plane downward by this much
   * and rescales the texture's V so the artwork keeps its original size at the
   * top; the region below samples the image's bottom pixel row (clamp-to-edge),
   * which continues each building's window columns downward and leaves the gaps
   * between buildings transparent.
   */
  extend?: number;
}

/** Left wall plane in the back opening's local x (world -7.6, opening at -3.8). */
export const BACK_LOCAL_WALL_X = -3.7;

/**
 * The `y` values are the original authored composition, framed by the window
 * opening (world y 1.15..3.05). Do not try to fix the problem below by lowering
 * them — that was tried and it fails from both ends: dropping `skyline` lifts
 * its ragged silhouette bottom into the eye-level view, and dropping `mid` far
 * enough to matter stops it covering that same ragged edge. The layers only look
 * independent; at eye level each one hides the one behind it.
 *
 * The actual problem is that the artwork simply *stops*. Looking down through a
 * window opens the view cone well below the sill, and each layer's bottom — the
 * alpha cutout's last opaque row, or the plane edge — reads as a hard horizontal
 * slice with the next layer visible underneath: buildings floating in midair. No
 * amount of repositioning fixes that, because the cone eventually reaches under
 * anything placed at a finite height.
 *
 * `extend` fixes it instead, by continuing each facade downward out of sight
 * rather than moving where it ends. See VistaLayer.extend and WindowVista.
 */
export const VISTA_LAYERS: Record<'back' | 'left', VistaLayer[]> = {
  back: [
    { url: '/vista/back-skyline.png', z: -18, w: 24, h: 9, x: 8.4, y: -1.2, extend: 16 },
    { url: '/vista/back-mid.png', z: -11, w: 16, h: 9, x: 4.4, y: -2.8, extend: 16 },
    { url: '/vista/back-near.png', z: -4.5, w: 10, h: 6, x: 1.4, y: -2.2, extend: 14 },
  ],
  left: [
    { url: '/vista/left-skyline.png', z: -18, w: 24, h: 9, x: 0, y: -1.2, extend: 16 },
    { url: '/vista/left-mid.png', z: -11, w: 16, h: 9, x: 0, y: -2.8, extend: 16 },
    { url: '/vista/left-near.png', z: -4.5, w: 10, h: 6, x: 0, y: -2.2, extend: 14 },
  ],
};
