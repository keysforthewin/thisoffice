#!/usr/bin/env node
// Regenerates web/public/models/characters/catalog.json by scanning the GLB dir.
// Pack/tags/display names come from scripts/catalog-meta.json; do not hand-edit catalog.json.
import { readFileSync, writeFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const charactersDir = path.join(root, 'web/public/models/characters');
const metaPath = path.join(root, 'scripts/catalog-meta.json');
const outPath = path.join(charactersDir, 'catalog.json');

/** Read the JSON chunk of a .glb without loading the whole binary payload. */
function readGlbJson(file) {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    readSync(fd, header, 0, 20, 0);
    if (header.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB (bad magic)`);
    const chunkLength = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file}: first chunk is not JSON`);
    const json = Buffer.alloc(chunkLength);
    readSync(fd, json, 0, chunkLength, 20);
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

const files = readdirSync(charactersDir)
  .filter((f) => f.endsWith('.glb'))
  .sort();

const characters = files.map((file) => {
  const id = path.basename(file, '.glb');
  const gltf = readGlbJson(path.join(charactersDir, file));
  const clipNames = (gltf.animations ?? []).map((a) => a.name);
  const m = meta.characters?.[id] ?? {};
  const entry = {
    id,
    displayName: m.displayName ?? id.replace(/_/g, ' '),
    pack: m.pack ?? 'Unknown',
    tags: m.tags ?? [],
    rig: clipNames.includes('Sit_Chair_Idle') ? 'embedded' : 'shared',
  };
  console.log(`  ${id}: ${clipNames.length} clips, rig=${entry.rig}, pack=${entry.pack}`);
  return entry;
});

characters.sort((a, b) => a.pack.localeCompare(b.pack) || a.id.localeCompare(b.id));

const catalog = {
  version: meta.version ?? 1,
  generatedAt: new Date().toISOString(),
  clipAliases: meta.clipAliases ?? {},
  characters,
};

writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${outPath} (${characters.length} characters)`);
