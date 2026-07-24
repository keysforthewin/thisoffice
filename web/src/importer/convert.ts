import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

/** Height (in world units) imported characters are normalized to; KayKit adults are ~1.7. */
const TARGET_HEIGHT = 1.72;

export interface ParsedFbx {
  group: THREE.Group;
  clips: THREE.AnimationClip[];
  kind: 'character' | 'animation';
}

/**
 * Mixamo exports vary between "mixamorig:Hips", "mixamorigHips", "mixamorig_Hips"
 * and bare "Hips". Strip the prefix everywhere (bones AND tracks) so clips from
 * one download bind to skeletons from another — and because ":" is a reserved
 * character in THREE.PropertyBinding paths that breaks binding after the GLB
 * round-trip.
 */
export function normalizeMixamoName(name: string): string {
  return name.replace(/^mixamorig[:_]?/i, '');
}

/** Normalize the node segment of a track name like "mixamorig:Hips.position". */
export function normalizeTrackName(trackName: string): string {
  const dot = trackName.indexOf('.');
  if (dot === -1) return normalizeMixamoName(trackName);
  return normalizeMixamoName(trackName.slice(0, dot)) + trackName.slice(dot);
}

/**
 * Height of the skinned geometry only. Mixamo FBX groups sometimes carry
 * stray helper nodes (nulls, lights, reference meshes) that inflate a
 * whole-group Box3 and make the height normalizer shrink the character.
 * Bind-pose geometry bounds are close enough for a T-posed Mixamo export.
 */
export function measureSkinnedHeight(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.geometry.computeBoundingBox();
    meshBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).y;
}

/**
 * Parse a Mixamo FBX (ArrayBuffer) and classify it. Textures embedded in the
 * FBX load asynchronously (data URIs), so we wait for the loading manager to
 * drain before resolving — otherwise the exporter would see empty images.
 */
export async function parseFbx(buffer: ArrayBuffer): Promise<ParsedFbx> {
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader(manager));

  let group: THREE.Group;
  const texturesDone = new Promise<void>((resolve) => {
    let started = false;
    manager.onStart = () => {
      started = true;
    };
    manager.onLoad = () => resolve();
    manager.onError = () => {
      /* individual texture failures are handled as material warnings later */
    };
    // if parse() queued nothing, onLoad never fires — resolve on the next tick
    setTimeout(() => {
      if (!started) resolve();
    }, 50);
  });

  try {
    group = new FBXLoader(manager).parse(buffer, '') as THREE.Group;
  } catch (e) {
    const msg = String(e);
    if (/version|format|ASCII/i.test(msg)) {
      throw new Error(
        'Unsupported FBX format — on Mixamo, download as "FBX Binary (.fbx)" (not FBX 6.x / ASCII).',
      );
    }
    throw new Error(`Could not read FBX: ${msg}`);
  }
  await texturesDone;

  let hasSkin = false;
  group.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkin = true;
  });
  const clips = group.animations ?? [];
  if (!hasSkin && !clips.length) {
    throw new Error('FBX contains neither a skinned character nor animations.');
  }
  return { group, clips, kind: hasSkin ? 'character' : 'animation' };
}

/** Strip mixamorig prefixes from every node in the hierarchy. */
function normalizeSceneNames(root: THREE.Object3D) {
  root.traverse((o) => {
    o.name = normalizeMixamoName(o.name);
  });
}

/** Retarget a clip by name only (both skeletons are Mixamo's) and rename it. */
function prepareClip(source: THREE.AnimationClip, canonicalName: string): THREE.AnimationClip {
  const clip = source.clone();
  clip.name = canonicalName;
  clip.tracks = clip.tracks.map((t) => {
    const renamed = t.clone();
    renamed.name = normalizeTrackName(t.name);
    return renamed;
  });
  clip.resetDuration();
  return clip;
}

/**
 * Mixamo clips can carry a world-space drift/offset on the hips; zero the
 * horizontal components so the character stays centered on its chair.
 */
function centerHipsTrack(clip: THREE.AnimationClip) {
  for (const track of clip.tracks) {
    if (!/(^|\|)Hips\.position$/.test(track.name) && track.name !== 'Hips.position') continue;
    const values = track.values;
    for (let i = 0; i < values.length; i += 3) {
      values[i] = 0; // x
      values[i + 2] = 0; // z
    }
  }
}

/**
 * FBXLoader produces Phong materials; convert explicitly to Standard so the
 * exporter doesn't do a lossy fallback. Returns human-readable warnings.
 */
function convertMaterials(root: THREE.Object3D): string[] {
  const warnings = new Set<string>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const convert = (m: THREE.Material): THREE.Material => {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
      const phong = m as THREE.MeshPhongMaterial;
      const std = new THREE.MeshStandardMaterial({
        name: m.name,
        color: phong.color?.clone() ?? new THREE.Color('#888'),
        map: phong.map ?? null,
        normalMap: phong.normalMap ?? null,
        roughness: 0.85,
        metalness: 0,
        transparent: m.transparent,
        opacity: m.opacity,
        side: m.side,
      });
      if (phong.map && !phong.map.image) {
        std.map = null;
        warnings.add(
          `Texture "${phong.map.name || m.name}" failed to load — using flat colors. Re-download from Mixamo as "FBX Binary" with skin.`,
        );
      }
      return std;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
  return [...warnings];
}

export interface ConvertResult {
  glb: ArrayBuffer;
  warnings: string[];
}

/**
 * Bake a self-contained character GLB: normalized Mixamo skeleton, Standard
 * materials, height-normalized root scale, and the two canonical clips
 * (Sit_Chair_Idle, Idle) the office needs — so at runtime an imported
 * character behaves exactly like a builtin `rig: 'embedded'` one.
 */
export async function convertCharacter(
  character: ParsedFbx,
  sit: ParsedFbx,
  idle: ParsedFbx,
  id: string,
): Promise<ConvertResult> {
  if (character.kind !== 'character') throw new Error('Not a character FBX (no skinned mesh).');
  if (!sit.clips.length || !idle.clips.length) throw new Error('Animation FBX has no clips.');

  const group = character.group;
  normalizeSceneNames(group);
  const warnings = convertMaterials(group);

  // Height-normalize via a wrapper group; never touch skinned geometry or
  // bind matrices (they stay in Mixamo's native units).
  const height = measureSkinnedHeight(group);
  const root = new THREE.Group();
  root.name = id;
  if (height > 0.001) {
    root.scale.setScalar(TARGET_HEIGHT / height);
  } else {
    warnings.push('Could not measure character height — imported at native scale.');
  }
  root.add(group);

  const sitClip = prepareClip(sit.clips[0], 'Sit_Chair_Idle');
  centerHipsTrack(sitClip);
  const idleClip = prepareClip(idle.clips[0], 'Idle');

  const glb = (await new GLTFExporter().parseAsync(root, {
    binary: true,
    animations: [sitClip, idleClip],
  })) as ArrayBuffer;

  return { glb, warnings };
}
