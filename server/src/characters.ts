import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { CharacterCatalog, CharacterEntry } from '../../shared/types.ts';
import { CHARACTER_VARIANTS } from '../../shared/types.ts';
import { sanitizeCharacterId } from '../../shared/characterId.ts';
import { parseGlbJson } from '../../shared/rigCheck.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');
const BUILTIN_CATALOG = path.resolve(__dirname, '../../web/public/models/characters/catalog.json');

export const ANIM_SLOTS = ['sit', 'idle'] as const;
export type AnimSlot = (typeof ANIM_SLOTS)[number];

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Decor images are wall art, not rigged models — a far smaller ceiling is plenty. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;
export const SEAT_OFFSET_RANGE = 0.5;
export const CHAIR_HEIGHT_RANGE = 0.4;
export const CHAIR_FORWARD_RANGE = 0.5;
const GLB_MAGIC = Buffer.from('glTF', 'ascii');
/** Binary FBX files always start with this signature */
const FBX_MAGIC = Buffer.from('Kaydara FBX Binary', 'ascii');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
/** WebP is RIFF<4-byte size>WEBP, so the tag sits at offset 8 */
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_TAG = Buffer.from('WEBP', 'ascii');

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

export function clampOffset(v: number, range: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(range, Math.max(-range, v));
}

export interface CharacterAdjust {
  scale?: number;
  seatOffset?: number;
  chairHeight?: number;
  chairForward?: number;
}

interface ImportedMeta {
  id: string;
  displayName: string;
  importedAt: number;
  /** absent = imported before Blender GLBs existed, i.e. a Mixamo conversion */
  rig?: 'embedded' | 'shared';
  pack?: string;
  scale?: number;
  seatOffset?: number;
  chairHeight?: number;
  chairForward?: number;
}

/**
 * Packs an upload may claim. The label rides a query string into a catalog every
 * client renders, so it is an allowlist rather than free text.
 */
export const IMPORT_PACKS = ['Mixamo', 'Blender'] as const;
export type ImportPack = (typeof IMPORT_PACKS)[number];

export function isImportPack(pack: string | null): pack is ImportPack {
  return (IMPORT_PACKS as readonly string[]).includes(pack ?? '');
}

export const sanitizeId = sanitizeCharacterId;

export function isAnimSlot(slot: string): slot is AnimSlot {
  return (ANIM_SLOTS as readonly string[]).includes(slot);
}

export class CharacterStore {
  private imported: ImportedMeta[];
  private dataDir: string;
  private charactersDir: string;
  private animsDir: string;
  private metaFile: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
    this.charactersDir = path.join(this.dataDir, 'characters');
    this.animsDir = path.join(this.charactersDir, 'anims');
    this.metaFile = path.join(this.charactersDir, 'imported.json');
    this.imported = this.loadMeta();
  }

  private loadMeta(): ImportedMeta[] {
    try {
      const list = JSON.parse(fs.readFileSync(this.metaFile, 'utf-8'));
      if (Array.isArray(list)) {
        // only keep entries whose GLB still exists on disk
        return list.filter((m) => m?.id && fs.existsSync(this.modelPath(m.id)));
      }
    } catch {
      /* first run */
    }
    return [];
  }

  private saveMeta() {
    fs.mkdirSync(this.charactersDir, { recursive: true });
    const tmp = `${this.metaFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.imported, null, 2));
    fs.renameSync(tmp, this.metaFile);
  }

  modelPath(id: string): string {
    return path.join(this.charactersDir, `${id}.glb`);
  }

  animPath(slot: AnimSlot): string {
    return path.join(this.animsDir, `${slot}.fbx`);
  }

  animStatus(): Record<AnimSlot, boolean> {
    return {
      sit: fs.existsSync(this.animPath('sit')),
      idle: fs.existsSync(this.animPath('idle')),
    };
  }

  private builtinCatalog(): CharacterCatalog {
    try {
      return JSON.parse(fs.readFileSync(BUILTIN_CATALOG, 'utf-8'));
    } catch {
      return {
        version: 0,
        generatedAt: '',
        clipAliases: {},
        characters: CHARACTER_VARIANTS.map((id) => ({
          id,
          displayName: id.replace(/_/g, ' '),
          pack: id.startsWith('Skeleton_') ? 'Skeletons 1.0' : 'Adventurers 1.0',
          tags: [],
          rig: 'embedded' as const,
        })),
      };
    }
  }

  isBuiltinId(id: string): boolean {
    return this.builtinCatalog().characters.some((c) => c.id === id);
  }

  mergedCatalog(): CharacterCatalog {
    const builtin = this.builtinCatalog();
    const builtinIds = new Set(builtin.characters.map((c) => c.id));
    const importedEntries: CharacterEntry[] = this.imported
      // a promoted character lives in both places until the server restarts;
      // the committed copy wins, so the picker never shows the id twice
      .filter((m) => !builtinIds.has(m.id))
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        pack: m.pack ?? 'Mixamo',
        tags: ['imported'],
        rig: m.rig ?? 'embedded',
        url: `/api/characters/${m.id}/model.glb?v=${m.importedAt}`,
        rev: m.importedAt,
        scale: m.scale,
        seatOffset: m.seatOffset,
        chairHeight: m.chairHeight,
        chairForward: m.chairForward,
      }));
    return { ...builtin, characters: [...builtin.characters, ...importedEntries] };
  }

  register(id: string, displayName: string, pack?: ImportPack): void {
    const importedAt = Date.now();
    // read the rig off the file rather than trusting the uploader: a Mixamo
    // conversion always bakes Sit_Chair_Idle, a Blender export never does
    const rig = this.readRig(id);
    const existing = this.imported.find((m) => m.id === id);
    if (existing) {
      existing.displayName = displayName;
      existing.importedAt = importedAt;
      existing.rig = rig;
      if (pack) existing.pack = pack;
    } else {
      this.imported.push({ id, displayName, importedAt, rig, pack: pack ?? 'Mixamo' });
    }
    this.saveMeta();
  }

  /** Same rule scripts/generate-catalog.mjs applies to committed characters. */
  private readRig(id: string): 'embedded' | 'shared' {
    try {
      const gltf: any = parseGlbJson(fs.readFileSync(this.modelPath(id)));
      const clipNames: string[] = (gltf.animations ?? []).map((a: any) => a.name);
      return clipNames.includes('Sit_Chair_Idle') ? 'embedded' : 'shared';
    } catch {
      // unreadable here means unplayable in the browser too; 'shared' at least
      // gives it the library clips rather than none
      return 'shared';
    }
  }

  adjust(id: string, adj: CharacterAdjust): boolean {
    const meta = this.imported.find((m) => m.id === id);
    if (!meta) return false;
    if (adj.scale !== undefined) meta.scale = clampScale(adj.scale);
    if (adj.seatOffset !== undefined) meta.seatOffset = clampOffset(adj.seatOffset, SEAT_OFFSET_RANGE);
    if (adj.chairHeight !== undefined) meta.chairHeight = clampOffset(adj.chairHeight, CHAIR_HEIGHT_RANGE);
    if (adj.chairForward !== undefined) meta.chairForward = clampOffset(adj.chairForward, CHAIR_FORWARD_RANGE);
    this.saveMeta();
    return true;
  }

  remove(id: string): boolean {
    const before = this.imported.length;
    this.imported = this.imported.filter((m) => m.id !== id);
    if (this.imported.length === before) return false;
    try {
      fs.unlinkSync(this.modelPath(id));
    } catch {
      /* already gone */
    }
    this.saveMeta();
    return true;
  }

  variantIds(): string[] {
    return this.mergedCatalog().characters.map((c) => c.id);
  }
}

export type UploadKind = 'glb' | 'fbx' | 'image';

const startsWith = (head: Buffer, magic: Buffer) =>
  head.length >= magic.length && head.subarray(0, magic.length).equals(magic);

export function validMagic(head: Buffer, kind: UploadKind): boolean {
  if (kind === 'image') {
    if (startsWith(head, PNG_MAGIC) || startsWith(head, JPEG_MAGIC)) return true;
    return startsWith(head, RIFF_MAGIC) && head.length >= 12 && head.subarray(8, 12).equals(WEBP_TAG);
  }
  return startsWith(head, kind === 'glb' ? GLB_MAGIC : FBX_MAGIC);
}

const KIND_ERRORS: Record<UploadKind, string> = {
  glb: 'not a GLB file',
  fbx: 'not a binary FBX file',
  image: 'not a PNG, JPEG or WebP image',
};

/**
 * Stream a binary upload to destPath. Validates the magic bytes of the first
 * chunk and enforces a size cap; writes via a temp file so a failed upload
 * never leaves a partial asset behind.
 */
export function saveUpload(
  req: IncomingMessage,
  destPath: string,
  kind: UploadKind,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES;
    const tooLarge = `file too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      req.resume();
      return resolve({ ok: false, error: tooLarge });
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = path.join(path.dirname(destPath), `.tmp-${crypto.randomUUID()}`);
    const out = fs.createWriteStream(tmpPath);
    let bytes = 0;
    let checkedMagic = false;
    let failed = false;

    const fail = (error: string) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(tmpPath, { force: true }, () => {});
      req.resume();
      resolve({ ok: false, error });
    };

    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      if (!checkedMagic) {
        checkedMagic = true;
        if (!validMagic(chunk, kind)) return fail(KIND_ERRORS[kind]);
      }
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(tooLarge);
    });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (bytes === 0) return fail('empty upload');
      try {
        fs.renameSync(tmpPath, destPath);
        resolve({ ok: true });
      } catch (e) {
        fail(String(e));
      }
    });
    out.on('error', (e) => fail(String(e)));
    req.on('error', (e) => fail(String(e)));
  });
}

/** Stream a stored asset to an HTTP response; returns false if missing. */
export function streamFile(
  filePath: string,
  res: import('node:http').ServerResponse,
  contentType: string,
  cacheControl = 'no-cache',
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
