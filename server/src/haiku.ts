import { spawn } from 'node:child_process';
import type { AskFn } from './quizPrompt.ts';

/** The cheapest model that can play this game. Do not "upgrade" it. */
export const HAIKU_MODEL = 'claude-haiku-4-5';

/**
 * A slow round is fine; a hung one is not — and this is set to catch only the
 * hung case. It used to be 30 s, which quietly became the round's real failure
 * mode: the prompt carries the whole history and asks for reasoning before the
 * question, so a turn that took ~8 s early in a round takes ~22 s by question 14,
 * and turns started timing out exactly as the round got interesting. The office
 * would rather wait a minute for the right question than lose the round, and
 * nothing downstream is blocking on this call.
 */
const TIMEOUT_MS = 120_000;

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
