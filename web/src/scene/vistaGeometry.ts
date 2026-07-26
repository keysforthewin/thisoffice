import * as THREE from 'three';

/** Geometry rows, top to bottom, in the layer's local frame (origin = layer center). */
export interface VistaRow {
  y: number;
  v: number;
}

/**
 * How far *inside* the artwork the hold row sits, in v.
 *
 * Holding exactly at the alpha edge renders nothing: bilinear filtering blends
 * the last opaque row with the transparent one below it, giving alpha ≈ 0.5,
 * and the material's `alphaTest: 0.5` then discards the whole skirt. A few
 * texels of inset (≈5 rows of a 1024-tall source) lands on solid pixels
 * instead. The cost is those few rows of artwork, ~0.05 world units.
 */
export const SKIRT_INSET_V = 0.005;

/**
 * Rows for a vista layer plane: the artwork quad, plus a "skirt" quad below it
 * that repeats one opaque row of the artwork all the way down.
 *
 * `trim` is the fraction of the image's height that is transparent padding at
 * the bottom (v of the last opaque row's lower edge). The artwork keeps its
 * authored placement — top edge at `+h/2`, the same image scale as before —
 * but the plane stops just inside the artwork's bottom instead of at v = 0, so
 * the skirt samples facade rather than padding.
 */
export function vistaRows(h: number, extend: number, trim = 0): VistaRow[] {
  const hold = trim > 0 ? Math.min(1, trim + SKIRT_INSET_V) : 0;
  const artBottom = h / 2 - h * (1 - hold);
  return [
    { y: h / 2, v: 1 },
    { y: artBottom, v: hold },
    { y: artBottom - extend, v: hold },
  ];
}

/**
 * A 2-quad plane facing +z: the artwork, and the downward skirt. Equivalent to
 * a PlaneGeometry of height `h + extend` when `trim` is 0 and the image's
 * bottom row is opaque — which is exactly the case ClampToEdgeWrapping used to
 * cover on its own.
 */
export function vistaGeometry(w: number, h: number, extend: number, trim = 0): THREE.BufferGeometry {
  const rows = vistaRows(h, extend, trim);
  const pos: number[] = [];
  const uv: number[] = [];
  const normal: number[] = [];
  for (const row of rows) {
    for (const x of [-w / 2, w / 2]) {
      pos.push(x, row.y, 0);
      uv.push(x < 0 ? 0 : 1, row.v);
      normal.push(0, 0, 1);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2;
    index.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setIndex(index);
  return geo;
}
