#!/usr/bin/env -S npx tsx
// Moves an imported character out of data/characters (yours only, gitignored)
// and into the repo, so it ships with the office and can go up in a PR:
//   npm run promote -- KatPerson --pack Blender --tags cat,mascot
import { copyFileSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkRig } from '../shared/rigCheck.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const charactersDir = path.join(root, 'web/public/models/characters');
// data/ is root-owned when the server runs in Docker; DATA_DIR points the script
// at a readable copy (or at a mounted volume) without touching the app's paths
const dataDir = path.join(process.env.DATA_DIR ?? path.join(root, 'data'), 'characters');
const metaPath = path.join(root, 'scripts/catalog-meta.json');

const VALUE_FLAGS = ['pack', 'name', 'tags'];
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith('--')) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  flags[name] = VALUE_FLAGS.includes(name) ? (args[++i] ?? '') : 'true';
}
const flag = (name: string): string | undefined => flags[name] || undefined;
const has = (name: string) => flags[name] === 'true';
const id = positional[0];

if (!id) {
  console.error('usage: npm run promote -- <id> [--pack "Blender"] [--name "Display Name"] [--tags a,b] [--keep] [--force]');
  process.exit(2);
}

const source = path.join(dataDir, `${id}.glb`);
if (!existsSync(source)) {
  console.error(`no imported character called "${id}".`);
  const imported = readImported();
  if (imported.length) console.error(`imported characters: ${imported.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

const report = checkRig(readFileSync(source));
for (const issue of report.errors) console.error(`  ✗ ${issue.message}`);
for (const issue of report.warnings) console.warn(`  ⚠ ${issue.message}`);
if (!report.ok && !has('force')) {
  console.error('rig check failed — fix the export, or pass --force to promote it anyway.');
  process.exit(1);
}

const dest = path.join(charactersDir, `${id}.glb`);
if (existsSync(dest) && !has('force')) {
  console.error(`${path.relative(root, dest)} already exists — pass --force to overwrite it.`);
  process.exit(1);
}

copyFileSync(source, dest);

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const existingMeta = meta.characters[id] ?? {};
const tags = flag('tags')?.split(',').map((t) => t.trim()).filter(Boolean);
meta.characters[id] = {
  ...existingMeta,
  displayName: flag('name') ?? existingMeta.displayName ?? readImported().find((m) => m.id === id)?.displayName ?? id,
  pack: flag('pack') ?? existingMeta.pack ?? 'Blender',
  tags: tags ?? (existingMeta.tags?.length ? existingMeta.tags : ['custom']),
};
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

console.log(`copied to ${path.relative(root, dest)}; regenerating catalog…`);
execSync(`node ${path.join(root, 'scripts/generate-catalog.mjs')}`, { stdio: 'inherit' });

if (!has('keep')) {
  rmSync(source, { force: true });
  const imported = readImported().filter((m) => m.id !== id);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'imported.json'), JSON.stringify(imported, null, 2));
  console.log('removed the data/ copy — restart the server, which holds imported.json in memory.');
}

console.log(`\nDone. "${id}" now ships with the repo. Commit web/public/models/characters/${id}.glb,`);
console.log('scripts/catalog-meta.json and the regenerated catalog.json, and add a line to ATTRIBUTION.md.');

function readImported(): { id: string; displayName?: string }[] {
  try {
    const list = JSON.parse(readFileSync(path.join(dataDir, 'imported.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
