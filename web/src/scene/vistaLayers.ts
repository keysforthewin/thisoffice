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
   * and holds the UV at the artwork's lowest opaque pixel row, which continues
   * each building's window columns downward and leaves the gaps between
   * buildings transparent.
   */
  extend?: number;
  /**
   * Fraction of the image's height that is *transparent padding* below the
   * artwork — i.e. the v coordinate of the lowest opaque pixel row's bottom
   * edge. Default 0 = the artwork runs to the image's bottom row.
   *
   * This is not cosmetic. `extend` continues the facades by repeating the
   * artwork's bottom edge; if that edge is padding, it repeats *nothing* and
   * the layer still ends in midair. Both `mid` layers are padded (their
   * generator left ~15% empty at the bottom), which is why they floated while
   * `near`/`skyline` looked right. Measured with a full-width alpha scan at the
   * material's alphaTest (0.5):
   *   back-mid  last opaque row 876/1023 → (1024-1-876)/1024
   *   left-mid  last opaque row 853/1023 → (1024-1-853)/1024
   * Re-measure if an image is regenerated.
   */
  trimBottom?: number;
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
 * rather than moving where it ends — but only as far down as the artwork's
 * lowest *opaque* row, hence `trimBottom`. See VistaLayer.extend/trimBottom
 * and WindowVista.
 */
export const VISTA_LAYERS: Record<'back' | 'left', VistaLayer[]> = {
  back: [
    { url: '/vista/back-skyline.png', z: -18, w: 24, h: 9, x: 8.4, y: -1.2, trimBottom: 0, extend: 16 },
    { url: '/vista/back-mid.png', z: -11, w: 16, h: 9, x: 4.4, y: -2.8, trimBottom: 0.14355, extend: 16 },
    { url: '/vista/back-near.png', z: -4.5, w: 10, h: 6, x: 1.4, y: -2.2, trimBottom: 0, extend: 14 },
  ],
  left: [
    { url: '/vista/left-skyline.png', z: -18, w: 24, h: 9, x: 0, y: -1.2, trimBottom: 0, extend: 16 },
    { url: '/vista/left-mid.png', z: -11, w: 16, h: 9, x: 0, y: -2.8, trimBottom: 0.16602, extend: 16 },
    { url: '/vista/left-near.png', z: -4.5, w: 10, h: 6, x: 0, y: -2.2, trimBottom: 0, extend: 14 },
  ],
};
