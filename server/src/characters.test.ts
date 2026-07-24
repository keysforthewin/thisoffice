import { describe, expect, it } from 'vitest';
import { validMagic, clampScale, CharacterStore } from './characters.ts';

describe('validMagic', () => {
  it('accepts GLB headers', () => {
    expect(validMagic(Buffer.from('glTF\x02\x00\x00\x00rest'), 'glb')).toBe(true);
  });

  it('accepts binary FBX headers', () => {
    expect(validMagic(Buffer.from('Kaydara FBX Binary  \x00'), 'fbx')).toBe(true);
  });

  it('rejects mismatched or truncated headers', () => {
    expect(validMagic(Buffer.from('glTF'), 'fbx')).toBe(false);
    expect(validMagic(Buffer.from('; FBX 6.1.0 project file'), 'fbx')).toBe(false); // ASCII FBX
    expect(validMagic(Buffer.from('gl'), 'glb')).toBe(false);
    expect(validMagic(Buffer.from(''), 'glb')).toBe(false);
  });
});

describe('clampScale', () => {
  it('passes through in-range values', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
  });

  it('clamps to [0.1, 10]', () => {
    expect(clampScale(0.001)).toBe(0.1);
    expect(clampScale(50)).toBe(10);
  });

  it('returns 1 for non-finite input', () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(1);
  });
});

describe('CharacterStore.setScale', () => {
  it('returns false for ids that are not imported characters', () => {
    const store = new CharacterStore();
    expect(store.setScale('Knight', 2)).toBe(false); // builtin, not in imported list
    expect(store.setScale('no_such_character_xyz', 2)).toBe(false);
  });
});
