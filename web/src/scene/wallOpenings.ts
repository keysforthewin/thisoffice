export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Split a w×h wall (centered at origin) into the solid strips left over around
 * a set of openings. Zero-area strips are omitted.
 *
 * Any number of openings, because windows are draggable between walls: a wall
 * can hold none, one, or both of them at once. The wall is cut into vertical
 * bands at every opening edge, so within a band an opening either spans the
 * full band or is absent from it entirely; each band then reduces to the
 * one-dimensional problem of the gaps above, below and between its openings.
 *
 * Openings are clipped to the wall, so one dragged half off the end still
 * leaves the correct solid remainder rather than a negative-width strip.
 */
export function wallStrips(w: number, h: number, openings: Rect[]): Rect[] {
  const L = -w / 2, R = w / 2, B = -h / 2, T = h / 2;
  const clipped = openings
    .map((o) => ({
      l: Math.max(L, o.x - o.w / 2),
      r: Math.min(R, o.x + o.w / 2),
      b: Math.max(B, o.y - o.h / 2),
      t: Math.min(T, o.y + o.h / 2),
    }))
    .filter((o) => o.r - o.l > 1e-6 && o.t - o.b > 1e-6);
  if (clipped.length === 0) return [{ x: 0, y: 0, w, h }];

  const cuts = [...new Set([L, R, ...clipped.flatMap((o) => [o.l, o.r])])].sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const x0 = cuts[i];
    const x1 = cuts[i + 1];
    if (x1 - x0 < 1e-6) continue;
    const mid = (x0 + x1) / 2;
    // bands are cut at every opening edge, so this is all-or-nothing per opening
    const inBand = clipped.filter((o) => o.l <= mid && o.r >= mid).sort((a, b) => a.b - b.b);
    let y = B;
    for (const o of inBand) {
      if (o.b - y > 1e-6) out.push({ x: mid, y: (y + o.b) / 2, w: x1 - x0, h: o.b - y });
      y = Math.max(y, o.t);
    }
    if (T - y > 1e-6) out.push({ x: mid, y: (y + T) / 2, w: x1 - x0, h: T - y });
  }
  return out;
}
