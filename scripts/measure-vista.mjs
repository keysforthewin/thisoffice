#!/usr/bin/env node
/**
 * Measure the per-column base row of every vista layer image and write it next
 * to the image as `<name>.skirt.json`.
 *
 * Why per-column: a skyline's buildings do not stand on a common ground line.
 * The old single-row skirt (`trimBottom`) repeated ONE row of the image — the
 * lowest opaque row in the whole picture — straight down. That row is only
 * inside the tallest/nearest buildings; for every column whose building ends
 * higher up, the repeated pixel is sky, so the skirt is transparent and the
 * building floats. Measured on the shipped art, that is 73% of back-skyline's
 * columns and 85% of left-mid's.
 *
 * Output per run of equal-base columns: [x0, x1, base, top]
 *   x0..x1  inclusive column range
 *   base    lowest opaque row of those columns
 *   top     top of the contiguous opaque span that ends at `base` — the skirt's
 *           hold row is inset upward from `base` but must not escape this span,
 *           or a thin spire's skirt samples sky and the building floats again.
 * Columns with no opaque pixel produce no run: that is sky, and it stays sky.
 *
 * Run `npm run vista` after adding or re-exporting any image in web/public/vista.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VISTA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'vista');

/** Opaque means "survives the material's alphaTest of 0.5". */
const ALPHA_CUTOFF = 128;
/** Hold the skirt a few rows inside the building, not on its alpha edge. */
const INSET_PX = 3;

/**
 * Minimal PNG reader: 8-bit RGBA, non-interlaced — which is what every vista
 * image is (checked in the loader below). Returns the alpha plane only.
 */
function readAlpha(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      const interlace = data[12];
      if (depth !== 8 || color !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace}) — expected 8-bit RGBA, non-interlaced`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const alpha = new Uint8Array(width * height);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    for (let i = 0; i < stride; i++) {
      const x = raw[off + i];
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      line[i] = v & 0xff;
    }
    off += stride;
    for (let x = 0; x < width; x++) alpha[y * width + x] = line[x * bpp + 3];
    prev.set(line);
  }
  return { width, height, alpha };
}

/** Per column: the lowest opaque row, and the top of the opaque span it belongs to. */
function columnBases({ width, height, alpha }) {
  const out = new Array(width).fill(null);
  for (let x = 0; x < width; x++) {
    let base = -1;
    for (let y = height - 1; y >= 0; y--) {
      if (alpha[y * width + x] >= ALPHA_CUTOFF) { base = y; break; }
    }
    if (base < 0) continue;
    let top = base;
    while (top - 1 >= 0 && alpha[(top - 1) * width + x] >= ALPHA_CUTOFF) top--;
    out[x] = { base, top };
  }
  return out;
}

/** Collapse equal-base neighbours into runs: one skirt quad each. */
function toRuns(cols) {
  const runs = [];
  let start = -1;
  let cur = null;
  const flush = (end) => {
    if (cur) runs.push([start, end, cur.base, cur.top]);
    cur = null;
  };
  for (let x = 0; x < cols.length; x++) {
    const c = cols[x];
    if (!c) { flush(x - 1); continue; }
    if (!cur || c.base !== cur.base || c.top !== cur.top) {
      flush(x - 1);
      start = x;
      cur = c;
    }
  }
  flush(cols.length - 1);
  return runs;
}

const files = readdirSync(VISTA_DIR).filter((f) => f.endsWith('.png')).sort();
if (files.length === 0) {
  console.error(`no PNGs in ${VISTA_DIR}`);
  process.exit(1);
}
for (const file of files) {
  const img = readAlpha(readFileSync(join(VISTA_DIR, file)));
  const cols = columnBases(img);
  const runs = toRuns(cols);
  const covered = cols.filter(Boolean).length;
  const out = { width: img.width, height: img.height, insetPx: INSET_PX, runs };
  writeFileSync(join(VISTA_DIR, `${file.replace(/\.png$/, '')}.skirt.json`), JSON.stringify(out));
  const lows = cols.filter(Boolean).map((c) => c.base);
  console.log(
    `${file.padEnd(18)} ${img.width}x${img.height}  runs=${String(runs.length).padStart(4)}  ` +
    `opaque cols=${covered}/${img.width}  base rows ${Math.min(...lows)}..${Math.max(...lows)}`,
  );
}
