/**
 * Which monitor (if any) a ray is pointing at, given raycast hits in
 * near-to-far order. Monitor meshes carry `userData.monitorTarget`; invisible
 * collider boxes and nametag sprites never block the view, but any other
 * visible geometry (walls, desks, characters' models) does.
 */

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
