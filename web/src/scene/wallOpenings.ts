export interface Rect { x: number; y: number; w: number; h: number }

/** Split a w×h wall (centered at origin) into up to 4 solid strips around an
 *  opening centered at (ox,oy) with size ow×oh. Zero-area strips are omitted. */
export function wallStrips(w: number, h: number, ox: number, oy: number, ow: number, oh: number): Rect[] {
  const L = -w / 2, R = w / 2, B = -h / 2, T = h / 2;
  const ol = ox - ow / 2, or_ = ox + ow / 2, ob = oy - oh / 2, ot = oy + oh / 2;
  const strips: Rect[] = [
    { x: (L + ol) / 2, y: 0, w: ol - L, h },                                  // left, full height
    { x: (or_ + R) / 2, y: 0, w: R - or_, h },                                // right, full height
    { x: ox, y: (B + ob) / 2, w: ow, h: ob - B },                             // below opening
    { x: ox, y: (ot + T) / 2, w: ow, h: T - ot },                             // above opening
  ];
  return strips.filter((r) => r.w > 1e-6 && r.h > 1e-6);
}
