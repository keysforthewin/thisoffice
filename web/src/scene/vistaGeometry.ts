import * as THREE from 'three';

/**
 * Geometry for one vista layer: the artwork quad, plus a "skirt" below it that
 * continues each building's facade down out of sight.
 *
 * The skirt used to be a single full-width quad holding ONE row of the image —
 * the lowest opaque row in the whole picture. That works only for the buildings
 * that actually reach that row. A skyline's buildings do not stand on a common
 * ground line, so for every shorter building the repeated pixel is sky: the
 * skirt is transparent there and the building floats. Measured on the shipped
 * art, that was 73% of back-skyline's columns and 85% of left-mid's — which is
 * exactly the "some extend, some float" the old `trimBottom` fix left behind
 * (it only moved the single row up past the images' transparent padding).
 *
 * So the skirt is now per column: one quad per run of columns sharing a base
 * row, each holding *its own* building's lowest pixels. Columns that are sky all
 * the way down get no quad at all. `scripts/measure-vista.mjs` bakes the runs
 * next to each image as `<name>.skirt.json`; run `npm run vista` after changing
 * any vista artwork.
 */

/** One run of columns sharing a base row: [x0, x1, base, top] — see the script. */
export type SkirtRun = [number, number, number, number];

export interface SkirtData {
  width: number;
  height: number;
  /** rows to hold *above* the base, so the skirt never samples the alpha edge */
  insetPx: number;
  runs: SkirtRun[];
}

export interface SkirtQuad {
  /** world x span, in the layer's local frame */
  x0: number;
  x1: number;
  /** world y of the quad's top (the base row's lower edge) and bottom */
  yTop: number;
  yBottom: number;
  /** u span, and the single v every corner samples */
  u0: number;
  u1: number;
  v: number;
}

/** Image row (0 = top) → the v of that row's lower edge. */
function rowBottomV(row: number, height: number): number {
  return 1 - (row + 1) / height;
}

/** Image row → the v of that row's centre, which is what a skirt samples. */
function rowCentreV(row: number, height: number): number {
  return 1 - (row + 0.5) / height;
}

/**
 * The skirt quads for a layer.
 *
 * Every quad ends at the same `yBottom` (`-h/2 - extend`), so a short building
 * runs down just as far as a tall one — that uniform floor is the whole point.
 * Each quad *starts* at its own building's base, so it never overlaps the
 * artwork it hangs from (no coplanar z-fighting) and leaves no transparent
 * sliver between the two.
 *
 * With no measured data the skirt falls back to one full-width quad holding the
 * image's bottom row, which is the original behaviour for an unpadded image.
 */
export function skirtQuads(w: number, h: number, extend: number, skirt?: SkirtData): SkirtQuad[] {
  const yBottom = -h / 2 - extend;
  if (extend <= 0) return [];
  if (!skirt || skirt.runs.length === 0) {
    return [{ x0: -w / 2, x1: w / 2, yTop: -h / 2, yBottom, u0: 0, u1: 1, v: 0 }];
  }
  const { width, height, insetPx } = skirt;
  return skirt.runs.map(([x0, x1, base, top]) => {
    // inset upward into the building, but never past the top of the opaque span
    // that base belongs to — a 2px spire would otherwise hold sky and float again
    const holdRow = Math.max(top, Math.min(base, base - insetPx));
    const u0 = x0 / width;
    const u1 = (x1 + 1) / width;
    return {
      x0: -w / 2 + u0 * w,
      x1: -w / 2 + u1 * w,
      yTop: -h / 2 + rowBottomV(base, height) * h,
      yBottom,
      u0,
      u1,
      v: rowCentreV(holdRow, height),
    };
  });
}

/** Push a quad's four corners (two triangles) into the buffers. */
function pushQuad(
  pos: number[],
  uv: number[],
  normal: number[],
  index: number[],
  x0: number,
  x1: number,
  yTop: number,
  yBottom: number,
  u0: number,
  u1: number,
  vTop: number,
  vBottom: number,
) {
  const a = pos.length / 3;
  pos.push(x0, yTop, 0, x1, yTop, 0, x0, yBottom, 0, x1, yBottom, 0);
  uv.push(u0, vTop, u1, vTop, u0, vBottom, u1, vBottom);
  for (let i = 0; i < 4; i++) normal.push(0, 0, 1);
  index.push(a, a + 2, a + 3, a, a + 3, a + 1);
}

/** A plane facing +z: the artwork, and one skirt quad per run of columns. */
export function vistaGeometry(w: number, h: number, extend: number, skirt?: SkirtData): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  pushQuad(pos, uv, normal, index, -w / 2, w / 2, h / 2, -h / 2, 0, 1, 1, 0);
  for (const q of skirtQuads(w, h, extend, skirt)) {
    pushQuad(pos, uv, normal, index, q.x0, q.x1, q.yTop, q.yBottom, q.u0, q.u1, q.v, q.v);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setIndex(index);
  return geo;
}
