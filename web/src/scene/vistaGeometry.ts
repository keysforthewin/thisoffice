export type FaceKind = 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface VistaFace {
  kind: FaceKind;
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number];
}

/** Five inward-facing faces of an open box spanning x∈[-w/2,w/2], y∈[-h/2,h/2],
 *  z∈[-d,0]. The missing face is z=0 — the window-opening side. Any sight line
 *  through the opening therefore terminates on a face, at any grazing angle. */
export function vistaBoxFaces(w: number, h: number, d: number): VistaFace[] {
  const Q = Math.PI / 2;
  return [
    { kind: 'back', position: [0, 0, -d], rotation: [0, 0, 0], size: [w, h] },
    { kind: 'left', position: [-w / 2, 0, -d / 2], rotation: [0, Q, 0], size: [d, h] },
    { kind: 'right', position: [w / 2, 0, -d / 2], rotation: [0, -Q, 0], size: [d, h] },
    { kind: 'top', position: [0, h / 2, -d / 2], rotation: [Q, 0, 0], size: [w, d] },
    { kind: 'bottom', position: [0, -h / 2, -d / 2], rotation: [-Q, 0, 0], size: [w, d] },
  ];
}
