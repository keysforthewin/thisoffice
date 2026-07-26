import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import type { ItemPose, OfficeLayout, WallPlacement, WallSide } from '../../../shared/types.ts';
import { useStore, type BuildHold } from '../store.ts';
import { carryAroundCorner, wallPlaneHit } from './walls.ts';
import {
  GRID,
  isPlacementValid,
  isWallPlacementValid,
  resolveWallItem,
  WALL_ITEMS,
  snapPose,
  wallItem,
  wallItemHeightRange,
  wallOffsetRange,
  type Footprint,
} from './buildLayout.ts';

/** Pointer capture keeps the drag alive when the cursor outruns the collider; a
 *  missing capture (pointer already gone, synthetic events) just degrades that. */
function capture(e: ThreeEvent<PointerEvent>, on: boolean) {
  try {
    const el = e.target as Element;
    if (on) el.setPointerCapture(e.pointerId);
    else el.releasePointerCapture(e.pointerId);
  } catch {
    /* inactive pointer id */
  }
}

const VALID_COLOR = '#4cc38a';
const INVALID_COLOR = '#ff4040';
/** Ctrl-rotate sensitivity: horizontal mouse motion → yaw, before the 15° snap. */
const ROTATE_PER_PX = 0.01;

function maxSeatOf(): number {
  const office = useStore.getState().office;
  return Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
}

function occupiedSeats(): number[] {
  const office = useStore.getState().office;
  return [0, ...(office?.employees.map((e) => e.seat) ?? [])];
}

/** Commit a dropped item: optimistic local merge, then the server round-trip. */
function commitLayout(patch: OfficeLayout) {
  useStore.getState().patchLayout(patch);
  fetch('/api/layout', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** Where the pointer ray crosses the floor plane (y = 0). */
function rayOnFloor(e: ThreeEvent<PointerEvent>): { x: number; z: number } | null {
  const { origin, direction } = e.ray;
  if (Math.abs(direction.y) < 1e-6) return null;
  const t = -origin.y / direction.y;
  if (t < 0) return null;
  return { x: origin.x + direction.x * t, z: origin.z + direction.z * t };
}

/**
 * Invisible drag collider for a floor item (a desk unit or a furniture piece),
 * rendered inside the item's already-posed group. While held it lights up as
 * the placement footprint: green = droppable, red = blocked.
 */
export function BuildHandle({
  kind,
  itemKey,
  pose,
  footprint,
  height = 2.2,
}: {
  kind: 'seat' | 'furniture';
  itemKey: number | string;
  pose: ItemPose;
  footprint: Footprint;
  height?: number;
}) {
  const gl = useThree((s) => s.gl);
  const holding = useStore(
    (s) => s.buildHold !== null && s.buildHold.kind === kind && s.buildHold.key === itemKey,
  );
  const valid = useStore((s) => (holding ? s.buildHold!.valid : true));
  const drag = useRef<{ pointerId: number; grabOffset: { x: number; z: number }; rotAccum: number; startPose: ItemPose } | null>(null);

  const ghostFrom = (e: ThreeEvent<PointerEvent>): ItemPose | null => {
    const d = drag.current;
    if (!d) return null;
    const prev = useStore.getState().buildHold?.ghost ?? d.startPose;
    if (e.ctrlKey) {
      // rotate in place: horizontal mouse motion spins the item
      d.rotAccum += e.movementX * ROTATE_PER_PX;
      return snapPose({ x: prev.x, z: prev.z, rotY: d.startPose.rotY + d.rotAccum });
    }
    const hit = rayOnFloor(e);
    if (!hit) return null;
    return snapPose({ x: hit.x + d.grabOffset.x, z: hit.z + d.grabOffset.z, rotY: prev.rotY });
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return; // right-drag is the camera's, even over an item
    if (!useStore.getState().buildMode || drag.current) return;
    e.stopPropagation();
    capture(e, true);
    const hit = rayOnFloor(e);
    drag.current = {
      pointerId: e.pointerId,
      grabOffset: hit ? { x: pose.x - hit.x, z: pose.z - hit.z } : { x: 0, z: 0 },
      rotAccum: 0,
      startPose: pose,
    };
    useStore.getState().setBuildHold({ kind, key: itemKey, ghost: pose, wallGhost: null, valid: true });
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    e.stopPropagation();
    const ghost = ghostFrom(e);
    if (!ghost) return;
    const st = useStore.getState();
    const ok = isPlacementValid(
      st.office?.layout,
      { kind, key: itemKey, pose: ghost },
      occupiedSeats(),
      maxSeatOf(),
      st.office?.katPerson !== false,
    );
    st.setBuildHold({ kind, key: itemKey, ghost, wallGhost: null, valid: ok });
  };

  const endDrag = (e: ThreeEvent<PointerEvent>, commit: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    capture(e, false);
    drag.current = null;
    const hold = useStore.getState().buildHold;
    useStore.getState().setBuildHold(null);
    if (!commit || !hold?.ghost || !hold.valid) return;
    const { x, z, rotY } = hold.ghost;
    if (x === d.startPose.x && z === d.startPose.z && rotY === d.startPose.rotY) return;
    commitLayout(
      kind === 'seat'
        ? { seats: { [Number(itemKey)]: { x, z, rotY } } }
        : { furniture: { [String(itemKey)]: { x, z, rotY } } },
    );
  };

  return (
    <mesh
      position={[0, height / 2, footprint.cz]}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onPointerEnter={() => {
        if (useStore.getState().buildMode) gl.domElement.style.cursor = 'move';
      }}
      onPointerLeave={() => {
        if (!drag.current) gl.domElement.style.cursor = '';
      }}
    >
      <boxGeometry args={[footprint.w, height, footprint.d]} />
      <meshBasicMaterial
        color={valid ? VALID_COLOR : INVALID_COLOR}
        transparent
        opacity={holding ? 0.25 : 0}
        depthWrite={false}
      />
    </mesh>
  );
}

/**
 * Drag collider for a wall-mounted item (window, art, board, TV). Slides along
 * its wall, rises and falls with the cursor, and carries around the corner onto
 * the next wall when it runs past an end. Rendered in the wall's local frame at
 * the item's (ghost-aware) placement.
 *
 * Hold Shift to lock to whichever axis the drag has travelled furthest in: with
 * a 0.2 grid it is easy to knock an item up a rung while only meaning to slide
 * it sideways.
 */
export function WallHandle({ id, placement, w, h }: { id: string; placement: WallPlacement; w: number; h: number }) {
  const gl = useThree((s) => s.gl);
  const holding = useStore(
    (s) => s.buildHold !== null && s.buildHold.kind === 'wall' && s.buildHold.key === id,
  );
  const valid = useStore((s) => (holding ? s.buildHold!.valid : true));
  const drag = useRef<{
    pointerId: number;
    /** grab offset in the CURRENT wall's frame; re-anchored on every transfer */
    grab: { ox: number; oy: number };
    wall: WallSide;
    start: WallPlacement;
    travel: { ox: number; oy: number };
  } | null>(null);

  const halfW = wallItem(id)?.halfW ?? 0;

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return; // right-drag is the camera's, even over an item
    if (!useStore.getState().buildMode || drag.current) return;
    e.stopPropagation();
    capture(e, true);
    const hit = wallPlaneHit(e.ray, placement.wall, maxSeatOf());
    drag.current = {
      pointerId: e.pointerId,
      grab: hit ? { ox: placement.ox - hit.ox, oy: placement.oy - hit.oy } : { ox: 0, oy: 0 },
      wall: placement.wall,
      start: placement,
      travel: { ox: 0, oy: 0 },
    };
    useStore.getState().setBuildHold({ kind: 'wall', key: id, ghost: null, wallGhost: placement, valid: true });
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    const maxSeat = maxSeatOf();
    const hit = wallPlaneHit(e.ray, d.wall, maxSeat);
    if (!hit) return;

    const rawOx = hit.ox + d.grab.ox;
    const rawOy = hit.oy + d.grab.oy;
    d.travel = {
      ox: Math.max(d.travel.ox, Math.abs(rawOx - d.start.ox)),
      oy: Math.max(d.travel.oy, Math.abs(rawOy - d.start.oy)),
    };
    // Shift locks to the dominant axis so far — measured over the whole drag, not
    // this event, so the lock doesn't flip on a single jittery move
    const lockOy = e.shiftKey && d.travel.ox >= d.travel.oy;
    const lockOx = e.shiftKey && d.travel.oy > d.travel.ox;

    // past the end of this wall the offset carries around the corner; re-anchoring
    // the grab against the new wall keeps the item under the cursor across the seam
    const carried = carryAroundCorner(d.wall, lockOx ? d.start.ox : rawOx, maxSeat, halfW);
    if (carried.wall !== d.wall) {
      d.wall = carried.wall;
      const reHit = wallPlaneHit(e.ray, carried.wall, maxSeat);
      d.grab = reHit
        ? { ox: carried.ox - reHit.ox, oy: (lockOy ? d.start.oy : rawOy) - reHit.oy }
        : d.grab;
    }

    const [minX, maxX] = wallOffsetRange(id, carried.wall, maxSeat);
    const [minY, maxY] = wallItemHeightRange(id);
    const snap = (v: number, lo: number, hi: number) =>
      THREE.MathUtils.clamp(Math.round(THREE.MathUtils.clamp(v, lo, hi) / GRID) * GRID, lo, hi);
    const next: WallPlacement = {
      wall: carried.wall,
      ox: snap(carried.ox, minX, maxX),
      oy: lockOy ? d.start.oy : snap(rawOy, minY, maxY),
    };
    const st = useStore.getState();
    const ok = isWallPlacementValid(st.office?.layout, id, next, maxSeat);
    st.setBuildHold({ kind: 'wall', key: id, ghost: null, wallGhost: next, valid: ok });
  };

  const endDrag = (e: ThreeEvent<PointerEvent>, commit: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    capture(e, false);
    drag.current = null;
    const hold = useStore.getState().buildHold;
    useStore.getState().setBuildHold(null);
    if (!commit || !hold?.wallGhost || !hold.valid) return;
    const { wall, ox, oy } = hold.wallGhost;
    if (wall === d.start.wall && ox === d.start.ox && oy === d.start.oy) return;
    commitLayout({ wallItems: { [id]: { wall, ox, oy } } });
  };

  // rendered inside the item's own WallMounted group, so local origin IS the item
  return (
    <mesh
      position={[0, 0, 0.08]}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onPointerEnter={() => {
        if (useStore.getState().buildMode) gl.domElement.style.cursor = 'move';
      }}
      onPointerLeave={() => {
        if (!drag.current) gl.domElement.style.cursor = '';
      }}
    >
      <boxGeometry args={[w, h, 0.12]} />
      <meshBasicMaterial
        color={valid ? VALID_COLOR : INVALID_COLOR}
        transparent
        opacity={holding ? 0.25 : 0}
        depthWrite={false}
      />
    </mesh>
  );
}

/** The ghost-aware pose for a floor item: while held, render at the drag ghost. */
export function displayPose(hold: BuildHold | null, kind: 'seat' | 'furniture', key: number | string, pose: ItemPose): ItemPose {
  return hold && hold.kind === kind && hold.key === key && hold.ghost ? hold.ghost : pose;
}

/** The ghost-aware placement for a wall item. */
export function displayWallItem(hold: BuildHold | null, id: string, placement: WallPlacement): WallPlacement {
  return hold && hold.kind === 'wall' && hold.key === id && hold.wallGhost ? hold.wallGhost : placement;
}

/** Resolved-then-ghost-aware wall placement straight from the store (render helper). */
export function useWallItem(id: string, maxSeat: number): WallPlacement {
  const layout = useStore((s) => s.office?.layout);
  const hold = useStore((s) => s.buildHold);
  return displayWallItem(hold, id, resolveWallItem(layout, id, maxSeat));
}

/**
 * Every wall item's placement at once, from a single pair of store
 * subscriptions — the renderer needs all of them together (to know which
 * windows are on which wall), and one hook per item would make the hook count
 * depend on WALL_ITEMS.
 */
export function useWallItems(maxSeat: number): Record<string, WallPlacement> {
  const layout = useStore((s) => s.office?.layout);
  const hold = useStore((s) => s.buildHold);
  return useMemo(() => {
    const out: Record<string, WallPlacement> = {};
    for (const item of WALL_ITEMS) {
      out[item.id] = displayWallItem(hold, item.id, resolveWallItem(layout, item.id, maxSeat));
    }
    return out;
  }, [layout, hold, maxSeat]);
}
