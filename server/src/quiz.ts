import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type QuizAnswer,
  type QuizQuestion,
  type QuizState,
  type QuizWinner,
  type ServerMsg,
} from '../../shared/types.ts';
import { buildQuizPrompt, parseQuizReply, type AskFn } from './quizPrompt.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(__dirname, '../../data/quiz.json');

/**
 * When Haiku cannot produce a question, the office waits for one. It never makes
 * a question up: a question chosen without reading the round is not a placeholder
 * that expires with the outage, it is a false fact the player answers in good
 * faith and that then sits in `answers` for the rest of the round.
 *
 * So there is no attempt limit and no giving up — just a retry that backs off
 * from `ASK_RETRY_MS` to `ASK_RETRY_MAX_MS`, because an outage lasting hours
 * should not mean a spawn every twenty seconds for hours. The bubble is simply
 * down until Haiku answers, which is the honest rendering of "the office has
 * nothing to ask yet".
 */
export const ASK_RETRY_MS = 20_000;
export const ASK_RETRY_MAX_MS = 5 * 60_000;

/** Exponential backoff on consecutive failures, capped. `failures` is 1-based. */
export function retryDelay(failures: number): number {
  return Math.min(ASK_RETRY_MS * 2 ** (failures - 1), ASK_RETRY_MAX_MS);
}

/** How long a client gets to deliver the winner's photo before we move on without one. */
export const PHOTO_TIMEOUT_MS = 20_000;
/** How long the winner's photo gets the room to itself before the next round opens. */
export const CELEBRATION_MS = 15_000;

/** A candidate questioner: an employee, the boss, or Kat Person. */
export interface QuizAsker {
  /** 'boss' | 'catPerson' | an employee id */
  id: string;
  name: string;
  variant: string;
  /** 0 for the boss, the employee's seat, null for Kat Person (furniture) */
  seat: number | null;
  /** idle askers are preferred, but a busy office still plays */
  idle: boolean;
}

export interface QuizDeps {
  ask: AskFn;
  /** broadcast to every client */
  emit: (msg: ServerMsg) => void;
  /** ask exactly one client to take the photo */
  requestCapture: (winner: QuizWinner) => void;
  status: (text: string) => void;
  recordWin: (name: string) => void;
  askers: () => QuizAsker[];
  dataFile?: string;
  now?: () => number;
}

/** The persisted slice: everything except the ephemeral photo handshake and the live bubble. */
type Persisted = Omit<QuizState, 'awaitingPhoto' | 'winner' | 'question'>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export class Quiz {
  private state: QuizState;
  private dataFile: string;
  private now: () => number;
  /** set while a turn's Haiku call is in flight, so nothing double-asks */
  private asking = false;
  private photoTimer: NodeJS.Timeout | null = null;
  private roundTimer: NodeJS.Timeout | null = null;
  /** pending retry of a Haiku call that failed; see ASK_RETRY_MS */
  private askTimer: NodeJS.Timeout | null = null;
  /** consecutive failed Haiku calls for the current turn, reset by any success */
  private askFailures = 0;

  constructor(private deps: QuizDeps) {
    this.dataFile = deps.dataFile ?? DATA_FILE;
    this.now = deps.now ?? Date.now;
    this.state = this.load();
    if (this.state.enabled) void this.askNext();
  }

  private load(): QuizState {
    let persisted: Partial<Persisted> | null = null;
    try {
      persisted = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
    } catch {
      persisted = null;
    }
    const answers = Array.isArray(persisted?.answers) ? (persisted!.answers as QuizAnswer[]) : [];
    return {
      enabled: persisted?.enabled === true,
      roundId: typeof persisted?.roundId === 'string' ? persisted.roundId : nextId('r'),
      askedCount: Number.isInteger(persisted?.askedCount) ? (persisted!.askedCount as number) : answers.length,
      answers,
      // a bubble that predates a restart is dropped: the round resumes with a fresh question
      question: null,
      // the photo handshake is ephemeral, and safely so: `win()` credits the
      // tally and resets the round before either of these is set, so a restart
      // inside the photo window costs the photo and nothing else
      awaitingPhoto: false,
      winner: null,
      ...(persisted?.photo ? { photo: persisted.photo } : {}),
    };
  }

  save(): void {
    const persisted: Persisted = {
      enabled: this.state.enabled,
      roundId: this.state.roundId,
      askedCount: this.state.askedCount,
      answers: this.state.answers,
      ...(this.state.photo ? { photo: this.state.photo } : {}),
    };
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const tmp = this.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    fs.renameSync(tmp, this.dataFile);
  }

  getState(): QuizState {
    return JSON.parse(JSON.stringify(this.state));
  }

  isAwaitingPhoto(): boolean {
    return this.state.awaitingPhoto;
  }

  /** The photo is a wall hanging: resetting the room takes it down. */
  clearPhoto(): void {
    delete this.state.photo;
    this.publish();
  }

  private publish(): void {
    this.save();
    this.deps.emit({ type: 'quiz', quiz: this.getState() });
  }

  setEnabled(on: boolean): void {
    if (this.state.enabled === on) return;
    this.state.enabled = on;
    if (!on) {
      this.state.question = null;
      // abandoning a photo handshake costs the photo only — the win was credited
      // and the round closed in `win()`
      this.state.awaitingPhoto = false;
      this.state.winner = null;
      this.clearTimers();
      this.publish();
      return;
    }
    this.publish();
    void this.askNext();
  }

  /**
   * Abandon the round in progress and open a fresh one.
   *
   * The escape hatch for a round that has gone wrong in a way the state machine
   * cannot notice on its own: a question nobody wants to answer, an answer given
   * by mistake that has sent the guessing down a dead branch, or a photo
   * handshake whose client went away. Deliberately keeps the two things that are
   * *history* rather than round state — the wall photo and the win tally — since
   * those survive every normal round change too. Safe to call while switched
   * off, in which case no question is asked until the game is switched back on.
   */
  restart(): void {
    this.clearTimers();
    this.resetRound();
    this.state.winner = null;
    this.state.awaitingPhoto = false;
    this.deps.status('20 questions: starting a new round');
    this.publish();
    if (this.state.enabled) void this.askNext();
  }

  /** Stop every pending timer — used on shutdown and when the game is switched off. */
  stop(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.photoTimer) clearTimeout(this.photoTimer);
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.askTimer) clearTimeout(this.askTimer);
    this.photoTimer = null;
    this.roundTimer = null;
    this.askTimer = null;
    this.askFailures = 0;
  }

  private pickAsker(): QuizAsker | null {
    const all = this.deps.askers();
    if (all.length === 0) return null;
    const idle = all.filter((a) => a.idle);
    const pool = idle.length > 0 ? idle : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * At most one Haiku call in flight, and no way out of it but a real question.
   *
   * Every failure is the same failure as far as the round is concerned — a
   * missing CLI, a timeout, garbage JSON, or a repeat of a question already
   * asked all mean "no question yet" — and every one of them is handled by
   * waiting and asking again. Nothing here invents a question. A repeat is worth
   * re-asking rather than accepting because Haiku samples: the same prompt is
   * quite likely to come back with something new.
   *
   * The bubble stays down for the whole outage, and no state is touched, so a
   * round survives an outage of any length intact and resumes exactly where it
   * left off.
   */
  private async askNext(): Promise<void> {
    if (!this.state.enabled || this.asking || this.state.awaitingPhoto) return;
    const asker = this.pickAsker();
    if (!asker) return;
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    this.asking = true;
    let parsed: { text: string; guess: boolean } | null = null;
    // Why it failed, for the status board. Swallowing this entirely made a
    // 30 s timeout indistinguishable from a missing CLI, which is exactly the
    // distinction someone reading the board needs.
    let reason = 'unusable reply';
    try {
      parsed = parseQuizReply(await this.deps.ask(buildQuizPrompt(this.state.answers)));
    } catch (err) {
      parsed = null;
      reason = err instanceof Error ? err.message : String(err);
    } finally {
      this.asking = false;
    }
    // enabled may have flipped while the call was in flight
    if (!this.state.enabled) return;

    const asked = new Set(this.state.answers.map((a) => a.question.toLowerCase()));
    if (!parsed || asked.has(parsed.text.toLowerCase())) {
      // Say it once per outage: a status line per retry would push the round's
      // real history off the board for something the office is handling.
      const why = parsed ? 'repeated itself' : reason;
      if (++this.askFailures === 1) {
        this.deps.status(`⚠ Haiku unavailable (${why.slice(0, 60)}) — the office is waiting`);
      }
      this.askTimer = setTimeout(() => void this.askNext(), retryDelay(this.askFailures));
      this.askTimer.unref?.();
      return;
    }
    if (this.askFailures > 0) this.deps.status('20 questions: the office is thinking again');
    this.askFailures = 0;

    const question: QuizQuestion = {
      id: nextId('q'),
      text: parsed.text,
      guess: parsed.guess,
      asker: asker.id,
      askerName: asker.name,
      askerSeat: asker.seat,
      at: new Date(this.now()).toISOString(),
    };
    this.state.question = question;
    // idempotent under re-issue (e.g. a toggle-off discards an unanswered question and
    // re-enabling asks a fresh one): always derive from answers.length rather than
    // incrementing, so repeated disable/enable cycles can't inflate the count.
    this.state.askedCount = this.state.answers.length + 1;
    this.publish();
  }

  answer(id: string, answer: 'yes' | 'no'): 'ok' | 'stale' {
    const q = this.state.question;
    if (!this.state.enabled || !q || q.id !== id) return 'stale';
    this.state.answers.push({
      question: q.text,
      answer,
      guess: q.guess,
      askerName: q.askerName,
      at: new Date(this.now()).toISOString(),
    });
    this.state.question = null;

    if (q.guess && answer === 'yes') {
      this.win(q);
      return 'ok';
    }
    // No question cap and no concession: the round runs until it is guessed.
    // The game is ambient background play while the agents work, and a forced
    // deadline is exactly what pushed the office into naming celebrities at
    // random rather than narrowing (see buildQuizPrompt).
    this.publish();
    void this.askNext();
    return 'ok';
  }

  /**
   * The win is the fact; the photo is decoration. Both durable consequences —
   * crediting the tally and closing the round — happen here, synchronously, so
   * that nothing about them lives in a `setTimeout` or in the unpersisted
   * `winner`/`awaitingPhoto` fields. A restart, a disable, or a capture that
   * never arrives can therefore only cost the photo, never the win, and can
   * never resume a round that still holds the guessed word in `answers`.
   *
   * `recordWin` is called exactly once per win, from here and nowhere else.
   */
  private win(q: QuizQuestion): void {
    const asker = this.deps.askers().find((a) => a.id === q.asker);
    const winner: QuizWinner = {
      name: q.askerName,
      variant: asker?.variant ?? '',
      asker: q.asker,
      seat: q.askerSeat,
      at: new Date(this.now()).toISOString(),
    };
    this.deps.recordWin(winner.name);
    this.deps.status(`🏆 ${winner.name} is Employee of the Month`);
    // the round is over the moment the guess lands: reset it now (and persist),
    // leaving only the ephemeral photo handshake and the celebration pause
    this.resetRound();
    this.state.winner = winner;
    this.state.awaitingPhoto = true;
    this.publish();
    this.deps.requestCapture(winner);
    // nobody watching, or a capture that failed: only the photo is lost
    this.photoTimer = setTimeout(() => this.finishWin(false), PHOTO_TIMEOUT_MS);
    this.photoTimer.unref?.();
  }

  /**
   * A client delivered the photo. Returns false when we were not expecting one.
   * `commit` (if given) is what moves the staged upload into place: it runs
   * inside the awaiting-photo guard and before the new metadata is published, so
   * a late upload can never overwrite the hanging photo it is too late to claim.
   */
  attachPhoto(commit?: () => void): boolean {
    if (!this.state.awaitingPhoto || !this.state.winner) return false;
    commit?.();
    this.finishWin(true);
    return true;
  }

  /** Closes the photo handshake only. The win itself was already credited in `win`. */
  private finishWin(withPhoto: boolean): void {
    const winner = this.state.winner;
    if (!winner || !this.state.awaitingPhoto) return;
    if (this.photoTimer) clearTimeout(this.photoTimer);
    this.photoTimer = null;
    this.state.awaitingPhoto = false;
    if (withPhoto) this.state.photo = { v: this.now(), name: winner.name };
    this.publish();
    // the timer is now responsible for one thing only: not asking the next
    // question while the room admires the photo
    this.roundTimer = setTimeout(() => this.openNextRound(), CELEBRATION_MS);
    this.roundTimer.unref?.();
  }

  /** The durable half of a round change; the photo deliberately survives it. */
  private resetRound(): void {
    this.state.roundId = nextId('r');
    this.state.askedCount = 0;
    this.state.answers = [];
    this.state.question = null;
  }

  /** Celebration over: clear the winner and open the next round. */
  private openNextRound(): void {
    this.clearTimers();
    this.state.winner = null;
    this.state.awaitingPhoto = false;
    this.publish();
    void this.askNext();
  }
}
