/**
 * The KayKit `Rig_Medium` skeleton every shared-rig character must match.
 *
 * The `_lib` clips animate bone *translation* as well as rotation, so they only
 * bind cleanly to a skeleton with these exact rest transforms — a differently
 * proportioned rig gets its joints yanked here and the mesh tears. This table is
 * the contract a Blender-authored character is checked against.
 *
 * Values are local TRS plus parent name, never world positions and never joint
 * indices: `skins[0].joints` order differs between characters (Ranger lists legs
 * first, CatPerson arms first) while the transforms are identical, so name is the
 * only stable key.
 *
 * Measured from web/public/models/characters/Ranger.glb (stock KayKit 2.0) and
 * cross-checked against CatPerson.glb, which agrees to 2e-7. Regenerate with
 * `npm run check-rig -- --print-canonical <character.glb>`; rigCheck.test.ts
 * fails if the shipped characters ever drift from it.
 */
export interface CanonicalBone {
  name: string;
  /** parent bone, or null for the skeleton root (whose parent is the armature node) */
  parent: string | null;
  /** local translation */
  t: [number, number, number];
  /** local rotation quaternion, xyzw */
  r: [number, number, number, number];
}

export const CANONICAL_BONES: readonly CanonicalBone[] = [
  { name: 'root', parent: null, t: [0, 0, 0], r: [0, 0, 0, 1] },
  { name: 'hips', parent: 'root', t: [0, 0.4056634, 0], r: [0, 0, 0, 1] },
  { name: 'spine', parent: 'hips', t: [0, 0.1919775, 0], r: [0, 0, 0, 1] },
  { name: 'chest', parent: 'spine', t: [0, 0.374988, 0], r: [0, 0, 0, 1] },
  { name: 'head', parent: 'chest', t: [0, 0.2687966, 0], r: [0, 0, 0, 1] },
  { name: 'upperarm.l', parent: 'chest', t: [0.2120074, 0.1341321, 0], r: [-0.5141215, -0.4854678, -0.4854678, 0.5141219] },
  { name: 'lowerarm.l', parent: 'upperarm.l', t: [0, 0.2418973, 0], r: [0, 0, -0.0552855, 0.9984706] },
  { name: 'wrist.l', parent: 'lowerarm.l', t: [0, 0.2600438, 0], r: [0, 0, 0.0266581, 0.9996447] },
  { name: 'hand.l', parent: 'wrist.l', t: [0, 0.0738258, 0], r: [0, 0, -0.0000055, 1] },
  { name: 'handslot.l', parent: 'hand.l', t: [0, 0.0961251, -0.0575001], r: [0, 0, -0.7071068, 0.7071067] },
  { name: 'upperarm.r', parent: 'chest', t: [-0.2120074, 0.1341321, 0], r: [-0.5141214, 0.4854677, 0.4854678, 0.5141219] },
  { name: 'lowerarm.r', parent: 'upperarm.r', t: [0, 0.2418973, 0], r: [0, 0, 0.0552855, 0.9984706] },
  { name: 'wrist.r', parent: 'lowerarm.r', t: [0, 0.2600438, 0], r: [0, 0, -0.0266581, 0.9996447] },
  { name: 'hand.r', parent: 'wrist.r', t: [0, 0.0738258, 0], r: [0, 0, 0.0000055, 1] },
  { name: 'handslot.r', parent: 'hand.r', t: [0, 0.0961251, -0.0575001], r: [0, 0, 0.7071068, 0.7071067] },
  { name: 'upperleg.l', parent: 'hips', t: [0.1709451, 0.1135873, 0], r: [0.9998491, 0, 0, 0.0173732] },
  { name: 'lowerleg.l', parent: 'upperleg.l', t: [0, 0.2270775, 0], r: [0.1062251, 0, 0, 0.9943422] },
  { name: 'foot.l', parent: 'lowerleg.l', t: [0, 0.149437, 0], r: [-0.455239, 0, 0, 0.8903693] },
  { name: 'toes.l', parent: 'foot.l', t: [0, 0.16565, 0], r: [0, 0.920355, -0.3910841, 0] },
  { name: 'upperleg.r', parent: 'hips', t: [-0.1709451, 0.1135873, 0], r: [0.9998491, 0, 0, 0.0173732] },
  { name: 'lowerleg.r', parent: 'upperleg.r', t: [0, 0.2270775, 0], r: [0.1062251, 0, 0, 0.9943422] },
  { name: 'foot.r', parent: 'lowerleg.r', t: [0, 0.149437, 0], r: [-0.455239, 0, 0, 0.8903693] },
  { name: 'toes.r', parent: 'foot.r', t: [0, 0.16565, 0], r: [0, 0.920355, -0.3910841, 0] },
];

/** Mesh height a character should export at: this world is ~1.35x human scale. */
export const TARGET_HEIGHT = 2.2;

/** The two clips the office plays. A shared-rig GLB carries neither; they come from `_lib`. */
export const REQUIRED_CLIPS = ['Sit_Chair_Idle', 'Idle', 'Idle_A'];
