import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import { useStore } from '../store.ts';
import { NameTag } from './NameTag.tsx';
import { NO_RAYCAST, crownOffset, findHeadBone } from './nametagVisibility.ts';
import { catalogEntry, resolveClip } from '../characters/catalog.ts';
import { useCharacterModel, preloadCharacter } from '../characters/useCharacterModel.ts';

interface Props {
  variant: string;
  working: boolean;
  /** which library clip to loop; standing props pass 'Idle' instead of sitting at a desk */
  clip?: string;
  position?: [number, number, number];
  rotationY?: number;
  name?: string;
  accent?: string;
}

// Bone-pivot → crown allowance: crown bones (HeadTop_End) are already at the
// top of the skull; a plain head pivot sits at the neck, so add skull height.
// This is only an estimate — a character whose head mesh is far larger than the
// allowance (the chibi cat) would wear its tag across its face, so the tag also
// clears the model's actual silhouette top (see `modelTop`).
const CROWN_BONE = /top|end/i;
const SKULL_ABOVE_CROWN = 0.04;
const SKULL_ABOVE_HEAD_PIVOT = 0.3;
/** "a few inches" of air, plus half the tag pill so its bottom edge clears. */
const TAG_LIFT = 0.12 + 0.11;
/** Tag height above the person origin when the rig has no head bone. */
const FALLBACK_HEAD_TOP = 2.1;

function PersonImpl({ variant, working, clip = 'Sit_Chair_Idle', position = [0, 0, 0], rotationY = 0, name, accent }: Props) {
  const catalog = useStore((s) => s.catalog);
  const entry = catalogEntry(catalog, variant);
  const { clone, clips } = useCharacterModel(variant, entry);
  const group = useRef<THREE.Group>(null);
  const { actions } = useAnimations(clips, group);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.frustumCulled = false; // skinned mesh bounds don't follow the sit pose

        // Characters never occlude nametags: opt out of raycasting so the
        // tag visibility check (nametagVisibility.ts) sees through them.
        child.raycast = NO_RAYCAST;
      }
    });
  }, [clone]);

  // Resolve in an effect, not render: drei's `actions` getters return null until
  // the group ref mounts, and a render-time memo would cache that null forever.
  const [sit, setSit] = useState<THREE.AnimationAction | null>(null);
  useEffect(() => {
    setSit(resolveClip(actions, clip, catalog?.clipAliases));
  }, [actions, catalog, clip]);

  useEffect(() => {
    if (!sit) return;
    sit.reset().play();
    sit.time = Math.random() * (sit.getClip().duration || 1); // desync from neighbors
    return () => {
      sit.stop();
    };
  }, [sit]);

  useEffect(() => {
    if (sit) sit.timeScale = working ? 2.2 : 0.6;
  }, [sit, working]);

  const scale = entry?.scale ?? 1;
  const seatOffset = entry?.seatOffset ?? 0;
  const headBone = useMemo(() => findHeadBone(clone), [clone]);
  // Per-character skull height above the head bone, replacing the SKULL_ABOVE_*
  // guesses (which put the tag across a chibi character's face). See crownOffset.
  const crown = useMemo(() => crownOffset(clone, headBone), [clone, headBone]);
  const tagGroup = useRef<THREE.Group>(null);
  const collider = useRef<THREE.Mesh>(null);
  const headLocal = useMemo(() => new THREE.Vector3(), []);
  const ignoreOwn = useCallback((obj: THREE.Object3D) => obj === collider.current, []);

  // Follow the animated head each frame: place the tag a few inches above the
  // crown, and size the invisible body collider (which occludes OTHER people's
  // tags — this person's own meshes are NO_RAYCAST, see below) to match.
  useFrame(() => {
    if (!group.current) return;
    if (headBone) {
      headBone.getWorldPosition(headLocal);
      group.current.worldToLocal(headLocal);
      // measured crown offset when the skeleton allows it; the constants are the fallback
      const skull = crown ?? (CROWN_BONE.test(headBone.name) ? SKULL_ABOVE_CROWN : SKULL_ABOVE_HEAD_PIVOT);
      headLocal.y += skull * scale;
    } else {
      headLocal.set(0, FALLBACK_HEAD_TOP * scale + seatOffset, 0);
    }
    tagGroup.current?.position.set(headLocal.x, headLocal.y + TAG_LIFT, headLocal.z);
    if (collider.current) {
      collider.current.position.set(headLocal.x, (seatOffset + headLocal.y) / 2, headLocal.z);
      collider.current.scale.set(1.0 * scale, Math.max(headLocal.y - seatOffset, 0.1), 0.8 * scale);
    }
  });

  return (
    <group ref={group} position={position} rotation={[0, rotationY, 0]}>
      <primitive object={clone} scale={scale} position={[0, seatOffset, 0]} />
      {/* Invisible body box: the raycaster still hits visible=false meshes, so
          this stands in for the (NO_RAYCAST) character when occluding tags. */}
      <mesh ref={collider} visible={false}>
        <boxGeometry />
      </mesh>
      {name && (
        <group ref={tagGroup}>
          <NameTag name={name} accent={accent} ignore={ignoreOwn} />
        </group>
      )}
    </group>
  );
}

/**
 * Memoized with an explicit comparator because `position` arrives as a fresh
 * array literal on every parent render — the default shallow compare would
 * never hit. Re-rendering a Person is expensive (useCharacterModel, the skeleton
 * clone lookup and useAnimations all re-run), and a status push that changes
 * nothing about this character used to trigger one for every person in the room.
 */
function sameProps(a: Props, b: Props): boolean {
  return (
    a.variant === b.variant &&
    a.working === b.working &&
    a.clip === b.clip &&
    a.rotationY === b.rotationY &&
    a.name === b.name &&
    a.accent === b.accent &&
    a.position?.[0] === b.position?.[0] &&
    a.position?.[1] === b.position?.[1] &&
    a.position?.[2] === b.position?.[2]
  );
}

export const Person = memo(PersonImpl, sameProps);

export function preloadVariant(variant: string) {
  preloadCharacter(variant);
}
