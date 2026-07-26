import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WALL_ART_EXTS, type WallArtExt } from '../../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');

const CONTENT_TYPES: Record<WallArtExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export function isWallArtExt(ext: string): ext is WallArtExt {
  return (WALL_ART_EXTS as readonly string[]).includes(ext);
}

/** `image/jpeg` etc. for a stored painting. */
export function wallArtContentType(ext: WallArtExt): string {
  return CONTENT_TYPES[ext];
}

/**
 * Storage for uploaded room decor — currently just the painting behind the
 * boss. Like `data/characters/`, this directory is user content and gitignored;
 * the office state holds only the metadata (which extension, and the framing).
 */
export class DecorStore {
  constructor(private dir = path.join(DEFAULT_DATA_DIR, 'decor')) {}

  wallArtPath(ext: WallArtExt): string {
    return path.join(this.dir, `wallart.${ext}`);
  }

  /** Remove every stored painting, whatever extension it was uploaded under. */
  clearWallArt(keep?: WallArtExt): void {
    for (const ext of WALL_ART_EXTS) {
      if (ext === keep) continue;
      fs.rmSync(this.wallArtPath(ext), { force: true });
    }
  }

  /**
   * The Employee of the Month photo. Always PNG — it comes from a canvas
   * capture, not a user upload, so there is no format to negotiate.
   */
  eotmPath(): string {
    return path.join(this.dir, 'eotm.png');
  }

  clearEotm(): void {
    fs.rmSync(this.eotmPath(), { force: true });
  }
}
