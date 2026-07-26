import { describe, expect, it } from 'vitest';
import { classifyFile } from './importStore.ts';

describe('classifyFile', () => {
  it('routes by extension, case-insensitively', () => {
    expect(classifyFile('X Bot.fbx')).toBe('fbx');
    expect(classifyFile('KatPerson.GLB')).toBe('glb');
  });

  it('rejects anything else, including the Blender file itself', () => {
    expect(classifyFile('character.blend')).toBeNull();
    expect(classifyFile('scene.gltf')).toBeNull(); // separate .bin/textures would not upload
    expect(classifyFile('noextension')).toBeNull();
  });
});
