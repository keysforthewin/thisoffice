/**
 * Which monitor (if any) a ray is pointing at, given raycast hits in
 * near-to-far order. Monitor meshes carry `userData.monitorTarget`; invisible
 * collider boxes and nametag sprites never block the view, but any other
 * visible geometry (walls, desks, characters' models) does.
 */

/**
 * Crosshair targets that are an *action*, not a focus subject: picking one runs
 * its handler and leaves the camera where it is. `wallArt` hangs a new picture;
 * `beacon` dismisses the blinking boss-desk light, the same as clicking it with
 * the cursor. Everything else the crosshair picks is flown to.
 */
export const WALL_ART_TARGET = 'wallArt';
export const BEACON_TARGET = 'beacon';

export interface PickHit {
  object: { userData: Record<string, unknown>; visible: boolean; type: string };
}

export function pickMonitorTarget(hits: PickHit[]): string | null {
  for (const { object } of hits) {
    const target = object.userData.monitorTarget;
    if (typeof target === 'string') return target;
    if (!object.visible || object.type === 'Sprite') continue;
    return null;
  }
  return null;
}
