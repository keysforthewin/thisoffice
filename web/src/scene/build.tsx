import { useRef } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import type { ItemPose, OfficeLayout } from '../../../shared/types.ts';
import { useStore, type BuildHold } from '../store.ts';
import { BACK_Z, roomDims } from './layout.ts';
import {
  GRID,
  isPlacementValid,
  isWallPlacementValid,
  resolveWallOffset,
  snapPose,
  wallOffsetRange,
  type Footprint,
  type WallId,
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
    useStore.getState().setBuildHold({ kind, key: itemKey, ghost: pose, ghostOffset: null, valid: true });
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
    st.setBuildHold({ kind, key: itemKey, ghost, ghostOffset: null, valid: ok });
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

/** Where the pointer ray crosses a wall plane, as that wall's local `ox`. */
function rayOnWall(e: ThreeEvent<PointerEvent>, wall: WallId, maxSeat: number): number | null {
  const { origin, direction } = e.ray;
  const { width, centerZ } = roomDims(maxSeat);
  if (wall === 'back') {
    if (Math.abs(direction.z) < 1e-6) return null;
    const t = (BACK_Z - origin.z) / direction.z;
    return t < 0 ? null : origin.x + direction.x * t;
  }
  // left wall: plane x = -width/2, local +x runs toward -z (rotY π/2)
  if (Math.abs(direction.x) < 1e-6) return null;
  const t = (-width / 2 - origin.x) / direction.x;
  return t < 0 ? null : centerZ - (origin.z + direction.z * t);
}

/**
 * Drag collider for a wall-mounted item (window, art, picture frame). Slides
 * along its wall only; no rotation. Rendered in the wall's local frame at the
 * item's (ghost-aware) `ox`.
 */
export function WallHandle({
  id,
  wall,
  ox,
  oy,
  w,
  h,
}: {
  id: string;
  wall: WallId;
  ox: number;
  oy: number;
  w: number;
  h: number;
}) {
  const gl = useThree((s) => s.gl);
  const holding = useStore(
    (s) => s.buildHold !== null && s.buildHold.kind === 'wall' && s.buildHold.key === id,
  );
  const valid = useStore((s) => (holding ? s.buildHold!.valid : true));
  const drag = useRef<{ pointerId: number; grabOffset: number; startOx: number } | null>(null);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!useStore.getState().buildMode || drag.current) return;
    e.stopPropagation();
    capture(e, true);
    const hit = rayOnWall(e, wall, maxSeatOf());
    drag.current = { pointerId: e.pointerId, grabOffset: hit === null ? 0 : ox - hit, startOx: ox };
    useStore.getState().setBuildHold({ kind: 'wall', key: id, ghost: null, ghostOffset: ox, valid: true });
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    e.stopPropagation();
    const maxSeat = maxSeatOf();
    const hit = rayOnWall(e, wall, maxSeat);
    if (hit === null) return;
    const [min, max] = wallOffsetRange(id, maxSeat);
    const raw = THREE.MathUtils.clamp(hit + drag.current.grabOffset, min, max);
    const snapped = Math.round(raw / GRID) * GRID;
    const next = THREE.MathUtils.clamp(snapped, min, max);
    const st = useStore.getState();
    const ok = isWallPlacementValid(st.office?.layout, id, next, maxSeat);
    st.setBuildHold({ kind: 'wall', key: id, ghost: null, ghostOffset: next, valid: ok });
  };

  const endDrag = (e: ThreeEvent<PointerEvent>, commit: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    capture(e, false);
    drag.current = null;
    const hold = useStore.getState().buildHold;
    useStore.getState().setBuildHold(null);
    if (!commit || hold?.ghostOffset == null || !hold.valid) return;
    if (hold.ghostOffset === d.startOx) return;
    commitLayout({ wallItems: { [id]: hold.ghostOffset } });
  };

  return (
    <mesh
      position={[ox, oy, 0.08]}
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

/** The ghost-aware along-wall offset for a wall item. */
export function displayWallOffset(hold: BuildHold | null, id: string, ox: number): number {
  return hold && hold.kind === 'wall' && hold.key === id && hold.ghostOffset != null ? hold.ghostOffset : ox;
}

/** Resolved-then-ghost-aware wall offset straight from the store (render helper). */
export function useWallOffset(id: string, maxSeat: number): number {
  const layout = useStore((s) => s.office?.layout);
  const hold = useStore((s) => s.buildHold);
  return displayWallOffset(hold, id, resolveWallOffset(layout, id, maxSeat));
}
