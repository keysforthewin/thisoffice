import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import type { Office } from './office.ts';
import { Transcripts } from './transcript.ts';

const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');

/**
 * Tails every *.jsonl under ~/.claude/projects. Existing files are seeded at
 * their current size so we only visualize NEW activity, not history.
 */
export function startWatcher(office: Office) {
  const transcripts = new Transcripts(office);
  const offsets = new Map<string, number>();

  const readNew = (file: string) => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const offset = offsets.get(file) ?? 0;
    if (size <= offset) {
      if (size < offset) offsets.set(file, size); // truncated/rotated
      return;
    }
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    // Only consume complete lines; leave a trailing partial line for next read.
    const text = buf.toString('utf-8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return;
    offsets.set(file, offset + Buffer.byteLength(text.slice(0, lastNewline + 1)));
    const lines = text.slice(0, lastNewline).split('\n').filter(Boolean);
    try {
      transcripts.handleLines(file, lines);
    } catch (err) {
      console.error('[watcher] failed handling lines from', file, err);
    }
  };

  const watcher = chokidar.watch(PROJECTS_DIR, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: false,
    depth: 6,
    // Bind mounts into Docker don't always propagate inotify events; poll there.
    usePolling: process.env.WATCH_POLL === '1',
    interval: 400,
  });

  const startTime = Date.now();

  watcher.on('add', (file, stats) => {
    if (!file.endsWith('.jsonl')) return;
    // Files that existed before we started: skip their history.
    const isNew = stats ? stats.mtimeMs > startTime - 5000 : false;
    offsets.set(file, isNew ? 0 : (stats?.size ?? 0));
    transcripts.fileAppeared(file);
    if (isNew) readNew(file);
  });

  watcher.on('change', (file) => {
    if (!file.endsWith('.jsonl')) return;
    readNew(file);
  });

  watcher.on('error', (err) => console.error('[watcher]', err));

  console.log(`[watcher] tailing ${PROJECTS_DIR}`);
  return watcher;
}
