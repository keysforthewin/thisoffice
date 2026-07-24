import { describe, expect, it } from 'vitest';
import { sanitizeCharacterId } from './characterId.ts';

describe('sanitizeCharacterId', () => {
  it('handles typical Mixamo download names', () => {
    expect(sanitizeCharacterId('X Bot.fbx')).toBe('X_Bot');
    expect(sanitizeCharacterId('Ch03_nonPBR (1).fbx')).toBe('Ch03_nonPBR_1');
    expect(sanitizeCharacterId('Louise')).toBe('Louise');
  });

  it('strips path-hostile characters', () => {
    expect(sanitizeCharacterId('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeCharacterId('a/b\\c')).toBe('a_b_c');
  });

  it('rejects names with nothing usable', () => {
    expect(sanitizeCharacterId('....')).toBeNull();
    expect(sanitizeCharacterId('')).toBeNull();
    expect(sanitizeCharacterId('日本語')).toBeNull();
  });

  it('caps length at 64', () => {
    expect(sanitizeCharacterId('x'.repeat(200))!.length).toBe(64);
  });
});
