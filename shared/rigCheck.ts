import { CANONICAL_BONES, REQUIRED_CLIPS, TARGET_HEIGHT, type CanonicalBone } from './rigCanonical.ts';

/**
 * Rig validation for a character GLB, from the JSON chunk alone.
 *
 * glTF requires `min`/`max` on POSITION accessors, so even mesh height is
 * readable without the binary chunk — which is what lets one module serve the
 * browser importer, the server and `npm run check-rig`, with no three.js and no
 * `fs`, and lets the tests synthesize fixtures from a plain object.
 *
 * Only failures that cannot possibly render are errors (bad container, a
 * compression extension we have no decoder for, no skin). Everything skeletal is
 * a warning: a near-miss rig still imports so the author can see how it looks.
 */

export type RigIssueCode =
  | 'not-a-glb'
  | 'unsupported-extension'
  | 'no-skin'
  | 'multi-skin'
  | 'joint-count'
  | 'missing-bone'
  | 'unknown-joint'
  | 'bad-parent'
  | 'bad-node-name'
  | 'duplicate-name'
  | 'bone-offset'
  | 'bone-rotation'
  | 'bone-scale'
  | 'uniform-scale'
  | 'height'
  | 'unused-clips'
  | 'large-file';

export interface RigIssue {
  code: RigIssueCode;
  /** user-facing; always names the fix, not just the delta */
  message: string;
  bone?: string;
}

export interface RigCheckResult {
  ok: boolean;
  errors: RigIssue[];
  warnings: RigIssue[];
  /** derived the same way scripts/generate-catalog.mjs derives it */
  rig: 'embedded' | 'shared';
  clipNames: string[];
  jointCount: number;
  /** skinned-mesh height in world units; 0 when unmeasurable */
  height: number;
  /** catalog `scale` that would bring the mesh to TARGET_HEIGHT, when that is meaningful */
  suggestedScale?: number;
  /** armature size relative to the canonical rig; 1 = exact */
  uniformScale: number;
  generator?: string;
}

/** Compression extensions drei's `useGLTF` has no decoder for: these load as an empty scene. */
const UNSUPPORTED_EXTENSIONS = [
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
];

/**
 * Names THREE.PropertyBinding treats as path syntax, so a bone named this way
 * never binds. KayKit's own `.l`/`.r` suffixes are fine — a bare dot is not the
 * problem; Blender's `.001` collision suffix and export prefixes are.
 */
const RESERVED_NAME = /[|/:[\]]|\.\d+$/;

const OFFSET_TOL = 0.002;
const ROTATION_TOL_DEG = 1;
const SCALE_TOL = 1e-3;
const UNIFORM_TOL = 0.02;
const HEIGHT_MIN = 1.6;
const HEIGHT_MAX = 2.8;
const LARGE_FILE_BYTES = 16 * 1024 * 1024;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/** Reads the JSON chunk of a GLB. Throws when the container is not a readable GLB. */
export function parseGlbJson(bytes: ArrayBuffer | Uint8Array): any {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.byteLength < 20) throw new Error('file is too short to be a GLB');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a binary glTF — export as glTF Binary (.glb)');
  const chunkLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('first GLB chunk is not JSON');
  if (20 + chunkLength > buf.byteLength) throw new Error('GLB is truncated');
  const text = new TextDecoder().decode(buf.subarray(20, 20 + chunkLength));
  return JSON.parse(text);
}

/** Validates a character GLB against the canonical rig. Never throws. */
export function checkRig(bytes: ArrayBuffer | Uint8Array): RigCheckResult {
  const errors: RigIssue[] = [];
  const warnings: RigIssue[] = [];
  const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
  const fail = (code: RigIssueCode, message: string): RigCheckResult => ({
    ok: false,
    errors: [{ code, message }],
    warnings,
    rig: 'shared',
    clipNames: [],
    jointCount: 0,
    height: 0,
    uniformScale: 1,
  });

  let gltf: any;
  try {
    gltf = parseGlbJson(bytes);
  } catch (err) {
    return fail('not-a-glb', `${(err as Error).message}. Re-export from Blender as glTF Binary (.glb).`);
  }

  for (const ext of gltf.extensionsRequired ?? []) {
    if (UNSUPPORTED_EXTENSIONS.includes(ext)) {
      errors.push({
        code: 'unsupported-extension',
        message: `${ext} is not supported — turn off compression in the glTF export options (Compression, and Images: keep them uncompressed).`,
      });
    }
  }

  const nodes: any[] = gltf.nodes ?? [];
  const clipNames: string[] = (gltf.animations ?? []).map((a: any, i: number) => a.name ?? `animation_${i}`);
  const rig: 'embedded' | 'shared' = clipNames.includes('Sit_Chair_Idle') ? 'embedded' : 'shared';

  const skins: any[] = gltf.skins ?? [];
  if (skins.length === 0) {
    errors.push({
      code: 'no-skin',
      message: 'no skinned mesh — the character must be parented to the Rig_Medium armature with an Armature modifier.',
    });
  } else if (skins.length > 1) {
    errors.push({
      code: 'multi-skin',
      message: `${skins.length} skeletons in one file — join the meshes so they share the single Rig_Medium armature.`,
    });
  }

  const joints: number[] = skins[0]?.joints ?? [];
  const jointNames = joints.map((i) => nodes[i]?.name ?? `node_${i}`);
  const height = measureHeight(gltf, nodes);
  const uniformScale = inferUniformScale(nodes, joints);

  // duplicate names anywhere in the scene: getObjectByName resolves to the first
  // match, so a mesh sharing a bone's name silently steals the clip's binding
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const node of nodes) {
    const name = node?.name;
    if (!name) continue;
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  for (const name of dupes) {
    warnings.push({
      code: 'duplicate-name',
      message: `two nodes are called "${name}" — rename one in Blender's outliner; clips bind to whichever comes first.`,
      bone: name,
    });
  }

  // The canonical skeleton is only a contract for characters that borrow the
  // `_lib` clips. A character carrying its own Sit_Chair_Idle (the KayKit 1.0
  // packs, and every Mixamo import) animates itself, on whatever rig it likes.
  if (joints.length > 0 && rig === 'shared') {
    if (joints.length !== CANONICAL_BONES.length) {
      warnings.push({
        code: 'joint-count',
        message: `${joints.length} bones, expected ${CANONICAL_BONES.length} — the shared sitting and idle clips only bind to the untouched Rig_Medium skeleton.`,
      });
    }

    const parentOf = new Map<number, number>();
    nodes.forEach((n, i) => {
      for (const c of n?.children ?? []) parentOf.set(c, i);
    });
    const byName = new Map<string, { index: number; node: any }>();
    joints.forEach((index, i) => byName.set(jointNames[i], { index, node: nodes[index] }));

    for (const name of jointNames) {
      if (RESERVED_NAME.test(name)) {
        warnings.push({
          code: 'bad-node-name',
          message: `bone "${name}" contains a reserved character — rename it (Blender adds ".001" when a name collides); animation never binds to it.`,
          bone: name,
        });
      }
    }

    const canonicalByName = new Map(CANONICAL_BONES.map((b) => [b.name, b]));
    for (const bone of CANONICAL_BONES) {
      if (!byName.has(bone.name)) {
        warnings.push({
          code: 'missing-bone',
          message: `bone "${bone.name}" is missing — rebuild on Rig_Medium_Template.glb and never rename or delete a bone.`,
          bone: bone.name,
        });
      }
    }
    for (const name of jointNames) {
      if (!canonicalByName.has(name)) {
        warnings.push({
          code: 'unknown-joint',
          message: `bone "${name}" is not part of Rig_Medium — extra bones are never animated; delete it or accept that it stays in its rest pose.`,
          bone: name,
        });
      }
    }

    for (const [name, entry] of byName) {
      const canonical = canonicalByName.get(name);
      if (!canonical) continue;

      const parentIndex = parentOf.get(entry.index);
      const parentName = parentIndex === undefined ? null : (nodes[parentIndex]?.name ?? null);
      const parentIsJoint = parentIndex !== undefined && joints.includes(parentIndex);
      const actualParent = parentIsJoint ? parentName : null;
      if (actualParent !== canonical.parent) {
        warnings.push({
          code: 'bad-parent',
          message: `bone "${name}" hangs off ${actualParent ?? 'the armature'} instead of ${canonical.parent ?? 'the armature'} — reparenting breaks the shared clips.`,
          bone: name,
        });
      }

      checkBoneTransform(entry.node, canonical, uniformScale, warnings);
    }

    if (Math.abs(uniformScale - 1) > UNIFORM_TOL) {
      warnings.push({
        code: 'uniform-scale',
        message: `the armature is ${uniformScale.toFixed(2)}x the template — rebuild on Rig_Medium_Template.glb rather than scaling the rig; the shared clips write absolute bone positions and will resize the skeleton at playback.`,
      });
    }
  }

  if (height > 0 && (height < HEIGHT_MIN || height > HEIGHT_MAX)) {
    warnings.push({
      code: 'height',
      message: `the mesh is ${height.toFixed(2)} units tall; this office is ~1.35x human scale, so characters should be about ${TARGET_HEIGHT}. Use the Size slider in the picker, or rescale in Blender.`,
    });
  }

  if (clipNames.length > 0 && !clipNames.some((c) => REQUIRED_CLIPS.includes(c))) {
    warnings.push({
      code: 'unused-clips',
      message: `${clipNames.length} animation(s) are baked in but none is ${REQUIRED_CLIPS.join(' / ')} — they only add file size; the office plays the shared clips.`,
    });
  }

  if (byteLength > LARGE_FILE_BYTES) {
    warnings.push({
      code: 'large-file',
      message: `${(byteLength / 1024 / 1024).toFixed(1)} MB — shrink the textures before contributing this to the repo.`,
    });
  }

  // Only rescue a wildly-off export. Shipped characters run 2.17–2.65 units
  // (hats, hoods) at scale 1, so anything tighter would shrink normal work.
  const scaleIsTrustworthy = Math.abs(uniformScale - 1) <= UNIFORM_TOL;
  const needsScale = height > 0 && (height < HEIGHT_MIN || height > HEIGHT_MAX);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rig,
    clipNames,
    jointCount: joints.length,
    height,
    // a rescaled armature is renormalized by the shared clips at playback, so
    // TARGET_HEIGHT / height would be the wrong correction there
    suggestedScale: scaleIsTrustworthy && needsScale ? TARGET_HEIGHT / height : undefined,
    uniformScale,
    generator: gltf.asset?.generator,
  };
}

function checkBoneTransform(
  node: any,
  canonical: CanonicalBone,
  uniformScale: number,
  warnings: RigIssue[],
): void {
  const t: number[] = node?.translation ?? [0, 0, 0];
  const offset = Math.hypot(
    t[0] - canonical.t[0] * uniformScale,
    t[1] - canonical.t[1] * uniformScale,
    t[2] - canonical.t[2] * uniformScale,
  );
  if (offset > OFFSET_TOL) {
    warnings.push({
      code: 'bone-offset',
      message: `bone "${canonical.name}" sits ${offset.toFixed(3)} units off the template — move it back; the shared clips assume the Rig_Medium rest pose.`,
      bone: canonical.name,
    });
  }

  const r: number[] = node?.rotation ?? [0, 0, 0, 1];
  // q and -q are the same rotation, hence the absolute dot
  const dot = Math.min(1, Math.abs(r[0] * canonical.r[0] + r[1] * canonical.r[1] + r[2] * canonical.r[2] + r[3] * canonical.r[3]));
  const angleDeg = (2 * Math.acos(dot) * 180) / Math.PI;
  if (angleDeg > ROTATION_TOL_DEG) {
    warnings.push({
      code: 'bone-rotation',
      message: `bone "${canonical.name}" is rotated ${angleDeg.toFixed(1)}° away from its rest pose — a wrong rest rotation distorts the mesh even though the clips overwrite the pose.`,
      bone: canonical.name,
    });
  }

  const s: number[] | undefined = node?.scale;
  if (s && s.some((v) => Math.abs(v - 1) > SCALE_TOL)) {
    warnings.push({
      code: 'bone-scale',
      message: `bone "${canonical.name}" is scaled — apply the scale in Blender (Ctrl+A) so it exports at 1.`,
      bone: canonical.name,
    });
  }
}

/**
 * Armature size relative to the template, from the bones with a large canonical
 * offset. Dividing it out turns "built at human scale" into one clear warning
 * instead of 23 per-bone ones.
 *
 * The median, not a least-squares fit: one deliberately moved bone must not drag
 * the estimate, or a single mistake reports as every bone being slightly wrong.
 */
function inferUniformScale(nodes: any[], joints: number[]): number {
  const canonicalByName = new Map(CANONICAL_BONES.map((b) => [b.name, b]));
  const ratios: number[] = [];
  for (const index of joints) {
    const node = nodes[index];
    const canonical = canonicalByName.get(node?.name);
    if (!canonical) continue;
    const expected = Math.hypot(...canonical.t);
    if (expected < 0.05) continue;
    ratios.push(Math.hypot(...(node.translation ?? [0, 0, 0])) / expected);
  }
  if (ratios.length === 0) return 1;
  ratios.sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

/** Skinned-mesh height from POSITION accessor bounds, which glTF requires to be present. */
function measureHeight(gltf: any, nodes: any[]): number {
  const meshes: any[] = gltf.meshes ?? [];
  const accessors: any[] = gltf.accessors ?? [];
  let min = Infinity;
  let max = -Infinity;
  for (const node of nodes) {
    if (node?.mesh === undefined || node.skin === undefined) continue;
    for (const primitive of meshes[node.mesh]?.primitives ?? []) {
      const accessor = accessors[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      min = Math.min(min, accessor.min[1]);
      max = Math.max(max, accessor.max[1]);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}
