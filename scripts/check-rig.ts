#!/usr/bin/env -S npx tsx
// Validates a character GLB against the canonical Rig_Medium skeleton before it
// is imported or committed. Run it on anything exported from Blender:
//   npm run check-rig -- path/to/Character.glb
import { readFileSync } from 'node:fs';
import { checkRig, parseGlbJson } from '../shared/rigCheck.ts';
import { CANONICAL_BONES } from '../shared/rigCanonical.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const printCanonical = args.includes('--print-canonical');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('usage: npm run check-rig -- <character.glb> [more.glb…] [--json] [--print-canonical]');
  process.exit(2);
}

if (printCanonical) {
  // Regenerates the CANONICAL_BONES table from a known-good rig, for the day
  // KayKit ships a new one. Paste the output into shared/rigCanonical.ts.
  printCanonicalTable(files[0]);
  process.exit(0);
}

let failed = false;
const reports = files.map((file) => {
  const result = checkRig(readFileSync(file));
  if (!result.ok) failed = true;
  return { file, ...result };
});

if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const report of reports) {
    const summary = `${report.jointCount} bones, rig=${report.rig}, height ${report.height.toFixed(2)}`;
    console.log(`${report.ok ? '✓' : '✗'} ${report.file} — ${summary}`);
    for (const issue of report.errors) console.log(`    ✗ ${issue.message}`);
    for (const issue of report.warnings) console.log(`    ⚠ ${issue.message}`);
    if (report.suggestedScale) {
      console.log(`    → import will set scale ${report.suggestedScale.toFixed(3)} to reach the office's 2.2-unit height`);
    }
  }
}

process.exit(failed ? 1 : 0);

function printCanonicalTable(file: string): void {
  const gltf: any = parseGlbJson(readFileSync(file));
  const parentOf = new Map<number, number>();
  gltf.nodes.forEach((n: any, i: number) => {
    for (const c of n.children ?? []) parentOf.set(c, i);
  });
  const joints: number[] = gltf.skins[0].joints;
  const round = (n: number) => Number((Math.abs(n) < 1e-6 ? 0 : n).toFixed(7));
  // canonical order, so the table stays diffable against the committed one
  for (const bone of CANONICAL_BONES) {
    const index = joints.find((j) => gltf.nodes[j].name === bone.name);
    if (index === undefined) {
      console.log(`  // missing: ${bone.name}`);
      continue;
    }
    const node = gltf.nodes[index];
    const parentIndex = parentOf.get(index);
    const parent = parentIndex !== undefined && joints.includes(parentIndex) ? gltf.nodes[parentIndex].name : null;
    const t = (node.translation ?? [0, 0, 0]).map(round).join(', ');
    const r = (node.rotation ?? [0, 0, 0, 1]).map(round).join(', ');
    console.log(`  { name: '${bone.name}', parent: ${parent ? `'${parent}'` : 'null'}, t: [${t}], r: [${r}] },`);
  }
}
