#!/usr/bin/env node
// Imports KayKit character packs into web/public/models/characters/ and regenerates the catalog.
//
// Character packs (self-contained .glb per character; .gltf files are converted via
// `npx @gltf-transform/cli copy`):
//   node scripts/import-characters.mjs <extracted-pack-dir> --pack "Adventurers 2.0" \
//     [--tags human,fantasy] [--only Ranger,Knight] [--suffix _V2] [--force]
//
// Animation library packs (KayKit Character Animations — copies the Rig_Medium sets the
// app needs into _lib/ and prints the clip inventory for curating clipAliases):
//   node scripts/import-characters.mjs <extracted-pack-dir> --anims
//
// Pack zips are free (CC0) on kaylousberg.itch.io; download manually (or ask Claude to
// drive it via chrome-devtools), extract, then run this.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const charactersDir = path.join(root, 'web/public/models/characters');
const libDir = path.join(charactersDir, '_lib');
const metaPath = path.join(root, 'scripts/catalog-meta.json');

const args = process.argv.slice(2);
const packDir = args.find((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

if (!packDir || !existsSync(packDir)) {
  console.error('usage: import-characters.mjs <pack-dir> --pack "Name" [--tags a,b] [--only X,Y] [--suffix _V2] [--force] | --anims');
  process.exit(1);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function glbJson(file) {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    readSync(fd, header, 0, 20, 0);
    if (header.readUInt32LE(0) !== 0x46546c67) return null;
    const len = header.readUInt32LE(12);
    const json = Buffer.alloc(len);
    readSync(fd, json, 0, len, 20);
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

if (has('anims')) {
  // Animation library: the app uses Idle (preview/thumbnails) and Sit_Chair_Idle (office),
  // both in the General + Simulation sets for Rig_Medium.
  const wanted = ['Rig_Medium_General.glb', 'Rig_Medium_Simulation.glb'];
  mkdirSync(libDir, { recursive: true });
  for (const file of walk(packDir)) {
    const base = path.basename(file);
    if (!wanted.includes(base)) continue;
    cpSync(file, path.join(libDir, base));
    const clips = (glbJson(path.join(libDir, base))?.animations ?? []).map((a) => a.name);
    console.log(`Installed _lib/${base} — clips: ${clips.join(', ')}`);
  }
  console.log('\nIf clip names differ from the canonical Idle / Sit_Chair_Idle, add them to');
  console.log('clipAliases in scripts/catalog-meta.json, then run: npm run catalog');
  process.exit(0);
}

const pack = opt('pack') ?? 'Unknown';
const tags = (opt('tags') ?? '').split(',').filter(Boolean);
const only = opt('only')?.split(',').filter(Boolean);
const suffix = opt('suffix') ?? '';

// Prefer the pack's Characters/gltf layout; skip weapons/props and rig templates.
const candidates = [...walk(packDir)].filter((f) => {
  if (!/\.(glb|gltf)$/i.test(f)) return false;
  if (!/characters[/\\]/i.test(f)) return false;
  if (/rig_|mannequin|template/i.test(path.basename(f))) return false;
  return true;
});

if (candidates.length === 0) {
  console.error('No character glb/gltf files found under a Characters/ directory.');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
let imported = 0;

for (const file of candidates) {
  const base = path.basename(file).replace(/\.(glb|gltf)$/i, '');
  if (only && !only.includes(base)) continue;
  const id = base + suffix;
  const dest = path.join(charactersDir, `${id}.glb`);
  if (existsSync(dest) && !has('force')) {
    console.log(`skip ${id} (exists; --force to overwrite)`);
    continue;
  }
  if (/\.gltf$/i.test(file)) {
    // convert external-resource gltf to a self-contained glb; run from the source dir
    // so relative texture/bin URIs resolve
    execSync(`npx --yes @gltf-transform/cli copy "${path.basename(file)}" "${dest}"`, {
      cwd: path.dirname(file),
      stdio: 'inherit',
    });
  } else {
    cpSync(file, dest);
  }
  const clips = (glbJson(dest)?.animations ?? []).map((a) => a.name);
  meta.characters[id] = {
    ...(meta.characters[id] ?? {}),
    pack,
    tags: meta.characters[id]?.tags?.length ? meta.characters[id].tags : tags,
    ...(suffix ? { displayName: `${base.replace(/_/g, ' ')} ${pack.split(' ').pop()}` } : {}),
  };
  console.log(`imported ${id} (${clips.length} embedded clips)`);
  imported++;
}

writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
console.log(`\n${imported} character(s) imported; regenerating catalog…`);
execSync(`node ${path.join(root, 'scripts/generate-catalog.mjs')}`, { stdio: 'inherit' });
console.log('Done. Eyeball each new character in the picker (preview + seated in the office).');
