import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecorStore } from './decor.ts';

describe('DecorStore eotm', () => {
  it('stores the photo as a png beside the painting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const store = new DecorStore(dir);
    expect(store.eotmPath()).toBe(path.join(dir, 'eotm.png'));
  });

  it('clearEotm removes the file and tolerates it being absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const store = new DecorStore(dir);
    fs.writeFileSync(store.eotmPath(), 'x');
    store.clearEotm();
    expect(fs.existsSync(store.eotmPath())).toBe(false);
    expect(() => store.clearEotm()).not.toThrow();
  });

  it('clearing the painting does not clear the photo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const store = new DecorStore(dir);
    fs.writeFileSync(store.eotmPath(), 'x');
    fs.writeFileSync(store.wallArtPath('png'), 'y');
    store.clearWallArt();
    expect(fs.existsSync(store.eotmPath())).toBe(true);
  });
});
