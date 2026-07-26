import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import type { Office } from './office.ts';
import { Transcripts } from './transcript.ts';
import { ScreenStreamer } from './streamer.ts';
import type { StatsAggregator } from './stats.ts';
import { MONITOR_IMAGE_MARKER } from '../../shared/types.ts';

const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');

/**
 * Text volume for the "busiest desks" stat. The streamer's emit hook is the only path
 * text takes to an employee monitor after pacing, so it counts what actually appeared
 * on screen — but a screenshot line is a base64 data URL tens of thousands of
 * characters long, which would swamp everyone else's typing, so images count as zero.
 */
export function countVisibleChars(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(MONITOR_IMAGE_MARKER)) continue;
    n += line.length;
  }
  return n;
}

/** The streamer only ever addresses employees (the boss screen bypasses it), so an
 *  unresolved id is a just-evicted desk, not the boss. */
function employeeName(office: Office, id: string): string {
  return office.getState().employees.find((e) => e.id === id)?.name ?? '';
}

/**
 * Tails every *.jsonl under ~/.claude/projects. Existing files are seeded at
 * their current size so we only visualize NEW activity, not history.
 */
export function startWatcher(office: Office, stats?: StatsAggregator) {
  const streamer = new ScreenStreamer({
    emit: (id, text) => {
      office.monitor(id, { append: text });
      stats?.recordChars(employeeName(office, id), countVisibleChars(text));
    },
    drained: (id) => office.notifyDrained(id),
  });
  office.attachStreamer(streamer);
  const transcripts = new Transcripts(office, streamer, stats);
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
    // Files that existed before we started: skip their history, and don't
    // announce them — pre-existing subagent files must not poison the
    // unmatchedAgentFiles pool for a session that's already past that Task.
    const isNew = stats ? stats.mtimeMs > startTime - 5000 : false;
    offsets.set(file, isNew ? 0 : (stats?.size ?? 0));
    if (isNew) {
      transcripts.fileAppeared(file);
      readNew(file);
    }
  });

  watcher.on('change', (file) => {
    if (!file.endsWith('.jsonl')) return;
    readNew(file);
  });

  watcher.on('error', (err) => console.error('[watcher]', err));

  console.log(`[watcher] tailing ${PROJECTS_DIR}`);
  return watcher;
}
