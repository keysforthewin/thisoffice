import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validMagic, clampScale, clampOffset, CharacterStore, CHAIR_FORWARD_RANGE } from './characters.ts';

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

  it('accepts PNG, JPEG and WebP image headers', () => {
    expect(validMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'image')).toBe(true);
    expect(validMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image')).toBe(true);
    expect(validMagic(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'image')).toBe(true);
  });

  it('rejects non-images, including a RIFF container that is not WebP', () => {
    expect(validMagic(Buffer.from('glTF\x02\x00\x00\x00'), 'image')).toBe(false);
    expect(validMagic(Buffer.from('<svg xmlns='), 'image')).toBe(false);
    expect(validMagic(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]), 'image')).toBe(false);
    expect(validMagic(Buffer.from('RIFF'), 'image')).toBe(false); // truncated
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

  it('persists clamped seatOffset/chairHeight/chairForward and surfaces them in the catalog', () => {
    const store = new CharacterStore(tempDir);
    store.register('test_char', 'Test Character');
    // Create a dummy GLB file so it's not filtered out
    fs.writeFileSync(store.modelPath('test_char'), '');

    expect(store.adjust('test_char', { seatOffset: 0.9, chairHeight: -0.2, chairForward: -0.15 })).toBe(true);
    const entry = store.mergedCatalog().characters.find((c) => c.id === 'test_char')!;
    expect(entry.seatOffset).toBe(0.5); // clamped
    expect(entry.chairHeight).toBe(-0.2);
    expect(entry.chairForward).toBe(-0.15);
  });

  it('clamps chairForward to its own range in both directions', () => {
    const store = new CharacterStore(tempDir);
    store.register('test_char', 'Test Character');
    fs.writeFileSync(store.modelPath('test_char'), '');

    store.adjust('test_char', { chairForward: 99 });
    expect(store.mergedCatalog().characters.find((c) => c.id === 'test_char')!.chairForward).toBe(CHAIR_FORWARD_RANGE);
    store.adjust('test_char', { chairForward: -99 });
    expect(store.mergedCatalog().characters.find((c) => c.id === 'test_char')!.chairForward).toBe(-CHAIR_FORWARD_RANGE);
  });

  it('survives a reload of the store (chairForward is written to meta)', () => {
    const store = new CharacterStore(tempDir);
    store.register('test_char', 'Test Character');
    fs.writeFileSync(store.modelPath('test_char'), '');
    store.adjust('test_char', { chairForward: -0.25 });

    const reloaded = new CharacterStore(tempDir);
    const entry = reloaded.mergedCatalog().characters.find((c) => c.id === 'test_char')!;
    expect(entry.chairForward).toBe(-0.25);
  });

  it('returns false for unknown ids', () => {
    const store = new CharacterStore(tempDir);
    expect(store.adjust('nope', { seatOffset: 0.1 })).toBe(false);
  });
});

/** Minimal GLB: header + JSON chunk, which is all the rig sniffing reads. */
function glbWithClips(clipNames: string[]): Buffer {
  let json = JSON.stringify({ asset: { version: '2.0' }, animations: clipNames.map((name) => ({ name })) });
  while (json.length % 4 !== 0) json += ' ';
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
}

describe('imported character rig and pack', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'thisoffice-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const registerWith = (store: CharacterStore, id: string, clips: string[], pack?: 'Mixamo' | 'Blender') => {
    fs.mkdirSync(path.dirname(store.modelPath(id)), { recursive: true });
    fs.writeFileSync(store.modelPath(id), glbWithClips(clips));
    store.register(id, id, pack);
    return store.mergedCatalog().characters.find((c) => c.id === id)!;
  };

  it('reads the rig off the file: a Mixamo conversion bakes its own sitting clip', () => {
    const entry = registerWith(new CharacterStore(tempDir), 'mixamo_char', ['Sit_Chair_Idle', 'Idle'], 'Mixamo');
    expect(entry.rig).toBe('embedded');
    expect(entry.pack).toBe('Mixamo');
  });

  it('a Blender export has no clips, so it borrows the shared library', () => {
    const entry = registerWith(new CharacterStore(tempDir), 'blender_char', [], 'Blender');
    expect(entry.rig).toBe('shared');
    expect(entry.pack).toBe('Blender');
    expect(entry.tags).toContain('imported');
  });

  it('treats meta written before Blender imports existed as a Mixamo conversion', () => {
    const dir = path.join(tempDir, 'characters');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'legacy.glb'), glbWithClips([]));
    fs.writeFileSync(
      path.join(dir, 'imported.json'),
      JSON.stringify([{ id: 'legacy', displayName: 'Legacy', importedAt: 1 }]),
    );

    const entry = new CharacterStore(tempDir).mergedCatalog().characters.find((c) => c.id === 'legacy')!;
    expect(entry.rig).toBe('embedded');
    expect(entry.pack).toBe('Mixamo');
  });

  it('hides an imported character once the same id ships with the repo', () => {
    const store = new CharacterStore(tempDir);
    registerWith(store, 'Ranger', []); // promoted into web/public but still in data/
    const matches = store.mergedCatalog().characters.filter((c) => c.id === 'Ranger');
    expect(matches).toHaveLength(1);
    expect(matches[0].tags).not.toContain('imported');
  });
});
