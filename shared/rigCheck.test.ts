import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRig, parseGlbJson, type RigIssueCode } from './rigCheck.ts';
import { CANONICAL_BONES } from './rigCanonical.ts';

const CHARACTERS = path.join(fileURLToPath(new URL('../', import.meta.url)), 'web/public/models/characters');
const read = (name: string) => fs.readFileSync(path.join(CHARACTERS, name));

const codes = (issues: { code: RigIssueCode }[]) => issues.map((i) => i.code);

describe('checkRig on the shipped characters', () => {
  it('passes the stock KayKit 2.0 rig', () => {
    const result = checkRig(read('Ranger.glb'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.rig).toBe('shared');
    expect(result.jointCount).toBe(23);
    expect(result.uniformScale).toBeCloseTo(1, 3);
    expect(result.height).toBeGreaterThan(1.9);
    expect(result.height).toBeLessThan(2.4);
  });

  it('passes CatPerson, the custom character reshaped onto the rig', () => {
    const result = checkRig(read('CatPerson.glb'));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rig).toBe('shared');
    expect(result.jointCount).toBe(23);
  });

  it('accepts the animation library, whose Idle_A the office does play', () => {
    const result = checkRig(read('_lib/Rig_Medium_General.glb'));
    expect(result.ok).toBe(true);
    expect(result.rig).toBe('shared'); // Sit_Chair_Idle lives in the Simulation file
    expect(result.clipNames).toContain('Idle_A');
    expect(codes(result.warnings)).not.toContain('unused-clips');
  });

  it('flags baked clips the office would never play', () => {
    const gltf: any = parseGlbJson(read('Ranger.glb'));
    gltf.animations = [{ name: 'Walking_A' }];
    expect(codes(checkRig(makeGlb(gltf)).warnings)).toContain('unused-clips');
  });

  // the reason CANONICAL_BONES can be a hardcoded table rather than read from a
  // template GLB at build time: drift from the shipped rigs fails here instead
  it.each(['Ranger.glb', 'CatPerson.glb'])('matches CANONICAL_BONES exactly (%s)', (file) => {
    const gltf: any = parseGlbJson(read(file));
    const parentOf = new Map<number, number>();
    gltf.nodes.forEach((n: any, i: number) => {
      for (const c of n.children ?? []) parentOf.set(c, i);
    });
    const joints: number[] = gltf.skins[0].joints;
    expect(joints.length).toBe(CANONICAL_BONES.length);

    for (const bone of CANONICAL_BONES) {
      const index = joints.find((j) => gltf.nodes[j].name === bone.name);
      expect(index, `${bone.name} present`).toBeDefined();
      const node = gltf.nodes[index as number];
      const parentIndex = parentOf.get(index as number);
      const parent = parentIndex !== undefined && joints.includes(parentIndex) ? gltf.nodes[parentIndex].name : null;
      expect(parent).toBe(bone.parent);
      for (let i = 0; i < 3; i++) expect(node.translation?.[i] ?? 0).toBeCloseTo(bone.t[i], 4);
      const r = node.rotation ?? [0, 0, 0, 1];
      const dot = Math.abs(r[0] * bone.r[0] + r[1] * bone.r[1] + r[2] * bone.r[2] + r[3] * bone.r[3]);
      expect(dot).toBeCloseTo(1, 4);
    }
  });
});

/**
 * Synthetic GLBs: header + JSON chunk, no BIN chunk. Valid input because the
 * validator only ever reads the JSON, which is what makes one-mutation-per-test
 * possible with no binary payload and no fixture files.
 */
function makeGlb(gltf: unknown): Uint8Array {
  let json = JSON.stringify(gltf);
  while (json.length % 4 !== 0) json += ' ';
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(20 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, body.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out;
}

/** A minimal, canonical, valid character: 23 bones plus one 2.2-unit skinned mesh. */
function canonicalGltf(): any {
  const nodes: any[] = CANONICAL_BONES.map((bone) => ({
    name: bone.name,
    translation: [...bone.t],
    rotation: [...bone.r],
  }));
  const indexOf = (name: string) => CANONICAL_BONES.findIndex((b) => b.name === name);
  for (const bone of CANONICAL_BONES) {
    if (!bone.parent) continue;
    const parent = nodes[indexOf(bone.parent)];
    (parent.children ??= []).push(indexOf(bone.name));
  }
  const meshNode = nodes.push({ name: 'body', mesh: 0, skin: 0 }) - 1;
  return {
    asset: { version: '2.0', generator: 'test' },
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: 'VEC3', componentType: 5126, count: 3, min: [-0.4, 0, -0.3], max: [0.4, 2.2, 0.3] }],
    skins: [{ joints: CANONICAL_BONES.map((b) => indexOf(b.name)) }],
    scenes: [{ nodes: [indexOf('root'), meshNode] }],
    scene: 0,
  };
}

const bone = (gltf: any, name: string) => gltf.nodes.find((n: any) => n.name === name);

describe('checkRig on mutated rigs', () => {
  it('accepts the canonical fixture', () => {
    const result = checkRig(makeGlb(canonicalGltf()));
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.height).toBeCloseTo(2.2, 5);
    expect(result.suggestedScale).toBeUndefined();
  });

  it('reports a renamed bone from both directions', () => {
    const gltf = canonicalGltf();
    bone(gltf, 'head').name = 'skull';
    const result = checkRig(makeGlb(gltf));
    expect(codes(result.warnings)).toContain('missing-bone');
    expect(codes(result.warnings)).toContain('unknown-joint');
    expect(result.ok).toBe(true); // warnings never block the import
  });

  it('reports an extra bone', () => {
    const gltf = canonicalGltf();
    gltf.nodes.push({ name: 'tail', translation: [0, 0.1, 0] });
    gltf.skins[0].joints.push(gltf.nodes.length - 1);
    bone(gltf, 'hips').children.push(gltf.nodes.length - 1);
    const result = checkRig(makeGlb(gltf));
    expect(codes(result.warnings)).toContain('joint-count');
    expect(codes(result.warnings)).toContain('unknown-joint');
  });

  it('reports a moved bone by name', () => {
    const gltf = canonicalGltf();
    bone(gltf, 'hips').translation[1] += 0.05;
    const result = checkRig(makeGlb(gltf));
    const offsets = result.warnings.filter((w) => w.code === 'bone-offset');
    expect(offsets).toHaveLength(1);
    expect(offsets[0].bone).toBe('hips');
  });

  it('tolerates sub-tolerance jitter', () => {
    const gltf = canonicalGltf();
    bone(gltf, 'hips').translation[1] += 0.0015;
    expect(codes(checkRig(makeGlb(gltf)).warnings)).not.toContain('bone-offset');
  });

  it('reports a reparented bone', () => {
    const gltf = canonicalGltf();
    const head = gltf.nodes.findIndex((n: any) => n.name === 'head');
    bone(gltf, 'chest').children = bone(gltf, 'chest').children.filter((c: number) => c !== head);
    bone(gltf, 'spine').children.push(head);
    const warnings = checkRig(makeGlb(gltf)).warnings;
    expect(warnings.find((w) => w.code === 'bad-parent')?.bone).toBe('head');
  });

  it('reports a rotated rest pose', () => {
    const gltf = canonicalGltf();
    bone(gltf, 'chest').rotation = [0.2588, 0, 0, 0.9659]; // 30 degrees
    const warnings = checkRig(makeGlb(gltf)).warnings;
    expect(warnings.find((w) => w.code === 'bone-rotation')?.bone).toBe('chest');
  });

  it('tolerates the near-unit bone scales Blender actually exports', () => {
    const gltf = canonicalGltf();
    bone(gltf, 'chest').scale = [1, 0.9999999403953552, 1];
    expect(codes(checkRig(makeGlb(gltf)).warnings)).not.toContain('bone-scale');
  });

  it('collapses a uniformly scaled armature into one warning', () => {
    const gltf = canonicalGltf();
    for (const node of gltf.nodes) {
      if (node.translation) node.translation = node.translation.map((v: number) => v * 0.8);
    }
    gltf.accessors[0].max[1] = 2.2 * 0.8;
    const result = checkRig(makeGlb(gltf));
    expect(codes(result.warnings)).toContain('uniform-scale');
    expect(codes(result.warnings)).not.toContain('bone-offset');
    expect(result.uniformScale).toBeCloseTo(0.8, 3);
    expect(result.suggestedScale).toBeUndefined();
  });

  it('reports a Blender dedupe suffix', () => {
    const gltf = canonicalGltf();
    bone(gltf, 'head').name = 'head.001';
    expect(codes(checkRig(makeGlb(gltf)).warnings)).toContain('bad-node-name');
  });

  it('reports a mesh that shadows a bone name', () => {
    const gltf = canonicalGltf();
    gltf.nodes.find((n: any) => n.name === 'body').name = 'chest';
    const warnings = checkRig(makeGlb(gltf)).warnings;
    expect(warnings.find((w) => w.code === 'duplicate-name')?.bone).toBe('chest');
  });

  it('rejects compression we have no decoder for', () => {
    const gltf = canonicalGltf();
    gltf.extensionsRequired = ['KHR_draco_mesh_compression'];
    const result = checkRig(makeGlb(gltf));
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(['unsupported-extension']);
  });

  it('rejects a file with no skinned mesh', () => {
    const gltf = canonicalGltf();
    delete gltf.skins;
    const result = checkRig(makeGlb(gltf));
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('no-skin');
  });

  it('treats a baked sitting clip as an embedded rig', () => {
    const gltf = canonicalGltf();
    gltf.animations = [{ name: 'Sit_Chair_Idle' }];
    expect(checkRig(makeGlb(gltf)).rig).toBe('embedded');
  });

  it('skips the skeleton contract for a self-animating character', () => {
    const gltf = canonicalGltf();
    gltf.animations = [{ name: 'Sit_Chair_Idle' }];
    bone(gltf, 'head').name = 'skull';
    gltf.nodes.push({ name: 'ponytail', translation: [0, 0.2, 0] });
    gltf.skins[0].joints.push(gltf.nodes.length - 1);
    // it brings its own clips, so it never binds to _lib and the rig is its own business
    expect(checkRig(makeGlb(gltf)).warnings).toEqual([]);
  });

  it('suggests a scale for an off-height mesh', () => {
    const gltf = canonicalGltf();
    gltf.accessors[0].max[1] = 3.3;
    const result = checkRig(makeGlb(gltf));
    expect(codes(result.warnings)).toContain('height');
    expect(result.suggestedScale).toBeCloseTo(2.2 / 3.3, 4);
  });

  it('reports a bad container instead of throwing', () => {
    expect(checkRig(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false, errors: [{ code: 'not-a-glb' }] });
    const truncated = makeGlb(canonicalGltf()).subarray(0, 40);
    expect(checkRig(truncated).errors[0].code).toBe('not-a-glb');
  });
});
