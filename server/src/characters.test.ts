import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validMagic, clampScale, clampOffset, CharacterStore } from './characters.ts';

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

describe('CharacterStore.adjust scale', () => {
  it('returns false for ids that are not imported characters', () => {
    const store = new CharacterStore();
    expect(store.adjust('Knight', { scale: 2 })).toBe(false); // builtin, not in imported list
    expect(store.adjust('no_such_character_xyz', { scale: 2 })).toBe(false);
  });
});

describe('clampOffset', () => {
  it('passes in-range values, clamps out-of-range, zeroes non-finite', () => {
    expect(clampOffset(0.2, 0.5)).toBe(0.2);
    expect(clampOffset(-0.7, 0.5)).toBe(-0.5);
    expect(clampOffset(9, 0.4)).toBe(0.4);
    expect(clampOffset(NaN, 0.5)).toBe(0);
    expect(clampOffset(Infinity, 0.5)).toBe(0);
  });
});

describe('CharacterStore.adjust', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'thisoffice-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists clamped seatOffset/chairHeight and surfaces them in the catalog', () => {
    const store = new CharacterStore(tempDir);
    store.register('test_char', 'Test Character');
    // Create a dummy GLB file so it's not filtered out
    fs.writeFileSync(store.modelPath('test_char'), '');

    expect(store.adjust('test_char', { seatOffset: 0.9, chairHeight: -0.2 })).toBe(true);
    const entry = store.mergedCatalog().characters.find((c) => c.id === 'test_char')!;
    expect(entry.seatOffset).toBe(0.5); // clamped
    expect(entry.chairHeight).toBe(-0.2);
  });

  it('returns false for unknown ids', () => {
    const store = new CharacterStore(tempDir);
    expect(store.adjust('nope', { seatOffset: 0.1 })).toBe(false);
  });
});
