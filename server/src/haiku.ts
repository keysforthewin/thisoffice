import { spawn } from 'node:child_process';
import type { AskFn } from './quizPrompt.ts';

/** The cheapest model that can play this game. Do not "upgrade" it. */
export const HAIKU_MODEL = 'claude-haiku-4-5';

/** A slow round is fine; a hung one is not. */
const TIMEOUT_MS = 30_000;

/**
 * `--no-session-persistence` is load-bearing, not tidiness: without it the CLI
 * writes its own transcript into ~/.claude/projects, the watcher tails it, and
 * the office starts visualizing the office thinking about the office.
 */
export function haikuArgs(): string[] {
  return ['-p', '--no-session-persistence', '--model', HAIKU_MODEL];
}

/**
 * Shell out to the `claude` CLI. Rejects on a missing binary, a non-zero exit,
 * or a timeout — every caller is expected to fall back rather than surface it.
 */
export const askHaiku: AskFn = (prompt) =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', haikuArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
