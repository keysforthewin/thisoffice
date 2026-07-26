import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUIZ_MAX_QUESTIONS,
  type QuizAnswer,
  type QuizQuestion,
  type QuizState,
  type QuizWinner,
  type ServerMsg,
} from '../../shared/types.ts';
import { buildQuizPrompt, fallbackQuestion, mustGuessAt, parseQuizReply, type AskFn } from './quizPrompt.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(__dirname, '../../data/quiz.json');

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

  private publish(): void {
    this.save();
    this.deps.emit({ type: 'quiz', quiz: this.getState() });
  }

  setEnabled(on: boolean): void {
    if (this.state.enabled === on) return;
    this.state.enabled = on;
    if (!on) {
      this.state.question = null;
      this.state.awaitingPhoto = false;
      this.state.winner = null;
      this.clearTimers();
      this.publish();
      return;
    }
    this.publish();
    void this.askNext();
  }

  /** Stop every pending timer — used on shutdown and when the game is switched off. */
  stop(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.photoTimer) clearTimeout(this.photoTimer);
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.photoTimer = null;
    this.roundTimer = null;
  }

  /**
   * A canned question that hasn't been asked yet this round. Cycles the fallback
   * list locally — no extra `ask` calls — since the list is short and finite.
   */
  private freshFallback(asked: Set<string>): string {
    for (let i = 0; i < 32; i++) {
      const candidate = fallbackQuestion(this.state.askedCount + i);
      if (!asked.has(candidate.toLowerCase())) return candidate;
    }
    return fallbackQuestion(this.state.askedCount);
  }

  private pickAsker(): QuizAsker | null {
    const all = this.deps.askers();
    if (all.length === 0) return null;
    const idle = all.filter((a) => a.idle);
    const pool = idle.length > 0 ? idle : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * One Haiku call per turn, never a retry loop: an unusable reply (missing CLI,
   * garbage, or a repeat of a question already asked) falls through to a canned
   * question so the round keeps moving at a bounded cost.
   */
  private async askNext(): Promise<void> {
    if (!this.state.enabled || this.asking || this.state.awaitingPhoto) return;
    const asker = this.pickAsker();
    if (!asker) return;
    const mustGuess = mustGuessAt(this.state.askedCount);
    this.asking = true;
    let parsed: { text: string; guess: boolean } | null = null;
    try {
      parsed = parseQuizReply(await this.deps.ask(buildQuizPrompt(this.state.answers, mustGuess)), mustGuess);
    } catch {
      this.deps.status('⚠ Haiku unavailable — the office is guessing blind');
      parsed = null;
    } finally {
      this.asking = false;
    }
    // enabled may have flipped while the call was in flight
    if (!this.state.enabled) return;
    const asked = new Set(this.state.answers.map((a) => a.question.toLowerCase()));
    if (!parsed || asked.has(parsed.text.toLowerCase())) {
      parsed = { text: this.freshFallback(asked), guess: mustGuess };
    }
    const question: QuizQuestion = {
      id: nextId('q'),
      text: parsed.text,
      guess: parsed.guess,
      asker: asker.id,
      askerName: asker.name,
      at: new Date(this.now()).toISOString(),
    };
    this.state.question = question;
    this.state.askedCount++;
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
    if (this.state.askedCount >= QUIZ_MAX_QUESTIONS) {
      this.deps.status(`⚠ The office gave up after ${QUIZ_MAX_QUESTIONS} questions`);
      this.newRound();
      return 'ok';
    }
    this.publish();
    void this.askNext();
    return 'ok';
  }

  private win(q: QuizQuestion): void {
    const asker = this.deps.askers().find((a) => a.id === q.asker);
    const winner: QuizWinner = {
      name: q.askerName,
      variant: asker?.variant ?? '',
      at: new Date(this.now()).toISOString(),
    };
    this.state.winner = winner;
    this.state.awaitingPhoto = true;
    this.publish();
    this.deps.requestCapture(winner);
    // nobody watching, or a capture that failed: the win still counts
    this.photoTimer = setTimeout(() => this.finishWin(false), PHOTO_TIMEOUT_MS);
    this.photoTimer.unref?.();
  }

  /** A client delivered the photo. Returns false when we were not expecting one. */
  attachPhoto(): boolean {
    if (!this.state.awaitingPhoto || !this.state.winner) return false;
    this.finishWin(true);
    return true;
  }

  private finishWin(withPhoto: boolean): void {
    const winner = this.state.winner;
    if (!winner || !this.state.awaitingPhoto) return;
    if (this.photoTimer) clearTimeout(this.photoTimer);
    this.photoTimer = null;
    this.state.awaitingPhoto = false;
    if (withPhoto) this.state.photo = { v: this.now(), name: winner.name };
    this.deps.recordWin(winner.name);
    this.deps.status(`🏆 ${winner.name} is Employee of the Month`);
    this.publish();
    this.roundTimer = setTimeout(() => this.newRound(), CELEBRATION_MS);
    this.roundTimer.unref?.();
  }

  /** Fresh round: the photo deliberately survives until the next winner replaces it. */
  private newRound(): void {
    this.clearTimers();
    this.state.roundId = nextId('r');
    this.state.askedCount = 0;
    this.state.answers = [];
    this.state.question = null;
    this.state.winner = null;
    this.state.awaitingPhoto = false;
    this.publish();
    void this.askNext();
  }
}
