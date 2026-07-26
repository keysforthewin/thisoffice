# 20 Questions Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in game where a random employee, the boss, or Kat Person asks the player yes/no questions to guess a secret word, and the winner's live in-scene photo hangs on the wall as Employee of the Month.

**Architecture:** A new server module (`quiz.ts`) owns a persisted state machine and drives question generation through an injected `AskFn` backed by `claude -p`. Quiz state reaches the client on its own `{ type: 'quiz' }` WebSocket message (never folded into `OfficeState`, which would defeat the `stableLayout` memoization). The client renders a drei `<Html>` speech bubble with YES/NO buttons, and on a win one designated client flies the camera, screenshots the WebGL canvas, and POSTs the PNG back.

**Tech Stack:** Node + tsx (server), Vite + React 19 + React Three Fiber 9 + drei 10 + three 0.185 + zustand 5 (web), vitest 3 (tests, run from repo root).

## Global Constraints

- **Off by default.** Zero `claude` invocations while `quiz.enabled` is false.
- **Model is exactly `claude-haiku-4-5`.** Invoked as `claude -p --no-session-persistence --model claude-haiku-4-5`. `--no-session-persistence` is mandatory — without it the summarizer's own transcripts get tailed and visualized (feedback loop).
- **Tests must never touch real data files.** Every data-file path is a constructor/option parameter with a default, and tests pass a `tmpdir` path. This mirrors `Office`'s `dataFile` injection (see `server/src/office.test.ts`).
- **No test may spawn a process.** The Haiku call is injected as `AskFn`; tests pass a stub.
- **Do not set `preserveDrawingBuffer: true` on the `<Canvas>`.** It costs every frame forever. Capture by calling `gl.render(...)` and `toDataURL()` in the same tick.
- **Never re-derive canvas content every frame.** New canvas surfaces gate on reference identity plus a slow poll, per `scene/redrawGate.ts`.
- **Raw-body uploads only.** There is no multipart parser server-side and none is wanted; follow the `/api/decor/wallart` POST pattern.
- Question hard limits: guessing is forced from question **15**, the office concedes at **20**.
- Run tests with `npx vitest run <file>` from the repo root (`/home/mulligan/code/thisoffice`).

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/src/quizPrompt.ts` | Pure: build the Haiku prompt, parse/repair the reply, canned fallbacks. |
| `server/src/quizPrompt.test.ts` | Tests for the above. |
| `server/src/haiku.ts` | The only process spawn. `haikuArgs()` (pure) + `askHaiku()`. |
| `server/src/haiku.test.ts` | Tests `haikuArgs()`. |
| `server/src/quiz.ts` | The state machine + `data/quiz.json` persistence. |
| `server/src/quiz.test.ts` | Tests for the above. |
| `web/src/quiz/quizApi.ts` | `fetch` helpers for the three quiz endpoints. |
| `web/src/quiz/askerAnchor.ts` | Pure: asker id → world anchor point. |
| `web/src/quiz/askerAnchor.test.ts` | Tests for the above. |
| `web/src/quiz/photoShot.ts` | Pure: camera framing for the group shot. |
| `web/src/quiz/photoShot.test.ts` | Tests for the above. |
| `web/src/quiz/capture.ts` | Render → `toDataURL` → `Blob`. |
| `web/src/quiz/SpeechBubble.tsx` | The in-world bubble with YES/NO buttons. |
| `web/src/scene/eotmTexture.ts` | Pure: caption wrapping + frame metrics. |
| `web/src/scene/eotmTexture.test.ts` | Tests for the above. |
| `web/src/scene/EotmFrame.tsx` | The wall photo + caption band. |

**Modified**

| File | Change |
|---|---|
| `shared/types.ts` | Quiz types, `ServerMsg` variant, `StatusItem` kind, `UsageStats.gameWins`. |
| `server/src/stats.ts` | `recordGameWin()`. |
| `server/src/stats.test.ts` | Test for the above. |
| `server/src/decor.ts` | `eotmPath()`, `clearEotm()`. |
| `server/src/index.ts` | Quiz routes, photo routes, `Quiz` wiring, capture assignment. |
| `web/src/store.ts` | `quiz` slice in `applyServerMsg`. |
| `web/src/store.test.ts` | Tests for the above. |
| `web/src/scene/tvContent.ts` | "Quiz champion" page. |
| `web/src/scene/tvContent.test.ts` | Tests for the above. |
| `web/src/scene/buildLayout.ts` | `eotm` wall item def + default offset. |
| `web/src/scene/buildLayout.test.ts` | Test for the above. |
| `web/src/scene/Office.tsx` | Mount `EotmFrame` + its `WallHandle`, mount `SpeechBubble`. |
| `web/src/scene/CameraRig.tsx` | `photo` camera mode. |
| `web/src/scene/Whiteboard.tsx` | Colour for the new `quiz` status kind. |
| `web/src/settings/SettingsPanel.tsx` | The 20 Questions section. |
| `CLAUDE.md` | Amend the "no speech bubbles" invariant; document the game. |

---

### Task 1: Protocol types, win tallies, and the TV champion page

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/src/stats.ts:91-110` (`emptyStats`), and add a method near `recordHeadcount` (`server/src/stats.ts:313`)
- Modify: `web/src/scene/tvContent.ts` (insert a page before the final "Tracking since" page at line 252)
- Test: `server/src/stats.test.ts`, `web/src/scene/tvContent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `QuizAnswer`, `QuizQuestion`, `QuizWinner`, `EotmPhoto`, `QuizState`, `QUIZ_GUESS_FROM`, `QUIZ_MAX_QUESTIONS`, `QUIZ_QUESTION_MAX_CHARS`, the `{ type: 'quiz'; quiz: QuizState; capture?: QuizWinner }` `ServerMsg` variant, `StatusItem['kind']` gaining `'quiz'`, `UsageStats.gameWins: Record<string, number>`, and `StatsAggregator.recordGameWin(name: string): void`.

- [ ] **Step 1: Add the quiz types to `shared/types.ts`**

Append after the `WALL_ART_ZOOM_MAX` export (line 91):

```ts
/** One resolved question in the current round. */
export interface QuizAnswer {
  question: string;
  answer: 'yes' | 'no';
  /** true when the asker was making an outright guess rather than narrowing down */
  guess: boolean;
  askerName: string;
  at: string;
}

/**
 * The live speech bubble. Null while the office is thinking of its next
 * question, and while the game is disabled.
 */
export interface QuizQuestion {
  /** answers must echo this back; guards against two tabs answering one bubble */
  id: string;
  text: string;
  guess: boolean;
  /** 'boss' | 'catPerson' | an employee id */
  asker: string;
  askerName: string;
  at: string;
}

export interface QuizWinner {
  name: string;
  variant: string;
  at: string;
}

/** Photo hanging in the Employee of the Month frame. Absent = empty frame. */
export interface EotmPhoto {
  /** capture timestamp; doubles as the cache-buster on /api/decor/eotm */
  v: number;
  name: string;
}

export interface QuizState {
  enabled: boolean;
  /** bumped every round; clients use it to drop bubbles from a finished round */
  roundId: string;
  askedCount: number;
  answers: QuizAnswer[];
  question: QuizQuestion | null;
  /** true while the server is waiting on a client to deliver the win photo (never persisted) */
  awaitingPhoto: boolean;
  winner: QuizWinner | null;
  photo?: EotmPhoto;
}

/** From this question number on, the asker must make an outright guess. */
export const QUIZ_GUESS_FROM = 15;
/** At this many questions the office concedes and a fresh round starts. */
export const QUIZ_MAX_QUESTIONS = 20;
/** Questions stay one short line; anything longer is truncated. */
export const QUIZ_QUESTION_MAX_CHARS = 120;
```

- [ ] **Step 2: Extend `StatusItem`, `ServerMsg` and `UsageStats`**

In `shared/types.ts`, change the `StatusItem.kind` union (line 42) to add `'quiz'`:

```ts
  kind: 'boss' | 'done' | 'hire' | 'plan' | 'away' | 'session' | 'quiz';
```

Add to the `ServerMsg` union (after the `stats` variant, line 174):

```ts
  | {
      type: 'quiz';
      quiz: QuizState;
      /**
       * Set only on the message sent to the single client asked to take the
       * winner's photo. Never present on the state sent to a new connection.
       */
      capture?: QuizWinner;
    }
```

Add to `UsageStats` (after `tokensByDowHour`, line 150):

```ts
  /** 20 Questions wins, keyed by employee name (a rehired name inherits its wins) */
  gameWins: Record<string, number>;
```

- [ ] **Step 3: Write the failing test for `recordGameWin`**

Append to `server/src/stats.test.ts` (match the file's existing `describe`/tmpdir style — read the top of the file first and reuse its helper for building an aggregator on a temp path):

```ts
  it('counts game wins per name and persists them', () => {
    const s = newStats(); // existing helper: StatsAggregator on a tmp file
    s.recordGameWin('Dana');
    s.recordGameWin('Dana');
    s.recordGameWin('Rey');
    expect(s.snapshot().gameWins).toEqual({ Dana: 2, Rey: 1 });
    expect(s.isDirty()).toBe(true);
    s.flush();
    expect(newStatsAt(s2File).snapshot().gameWins).toEqual({ Dana: 2, Rey: 1 });
  });

  it('ignores a blank winner name', () => {
    const s = newStats();
    s.recordGameWin('   ');
    expect(s.snapshot().gameWins).toEqual({});
  });
```

Adapt the two helper names to whatever the file already uses; the reload assertion must construct a second aggregator over the *same* temp path that was just flushed.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run server/src/stats.test.ts -t "game wins"`
Expected: FAIL — `s.recordGameWin is not a function`.

- [ ] **Step 5: Implement `recordGameWin` and the `gameWins` default**

In `server/src/stats.ts`, add `gameWins: {},` to the object returned by `emptyStats()` (line 92). The existing `return { ...emptyStats(), ...stats }` in `load()` already back-fills older files, so no migration code is needed.

Add the method after `recordHeadcount` (line 321):

```ts
  /** A 20 Questions round was won. Keyed by name so a rehired employee keeps her wins. */
  recordGameWin(name: string): void {
    const key = name.trim();
    if (!key) return;
    this.stats.gameWins[key] = (this.stats.gameWins[key] ?? 0) + 1;
    this.markDirty();
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run server/src/stats.test.ts`
Expected: PASS (all tests in the file, not just the new ones).

- [ ] **Step 7: Write the failing test for the TV champion page**

Append to `web/src/scene/tvContent.test.ts`. The file already has a helper that builds a `UsageStats`; note it will now also need `gameWins` — add `gameWins: {}` to that helper's base object as part of this step.

```ts
  it('shows a quiz champion page once someone has won', () => {
    const pages = tvPages(baseStats({ gameWins: { Dana: 3, Rey: 1 } }));
    const page = pages.find((p) => p.title === 'Quiz champion');
    expect(page).toBeDefined();
    expect(page!.value).toBe('Dana');
    expect(page!.sub).toBe('3 wins · 4 rounds won');
  });

  it('omits the champion page when nobody has won', () => {
    expect(tvPages(baseStats({ gameWins: {} })).some((p) => p.title === 'Quiz champion')).toBe(false);
  });

  it('pluralises a single win', () => {
    const page = tvPages(baseStats({ gameWins: { Rey: 1 } })).find((p) => p.title === 'Quiz champion');
    expect(page!.sub).toBe('1 win · 1 round won');
  });

  it('tolerates stats from a server without gameWins', () => {
    const stats = baseStats({});
    delete (stats as { gameWins?: unknown }).gameWins;
    expect(() => tvPages(stats)).not.toThrow();
  });
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run web/src/scene/tvContent.test.ts -t "champion"`
Expected: FAIL — no page titled "Quiz champion".

- [ ] **Step 9: Implement the champion page**

In `web/src/scene/tvContent.ts`, insert before the final "16. Tracking since" block (line 252):

```ts
  // 16. Quiz champion — only once someone has actually won a round
  const wins = Object.entries(stats.gameWins ?? {});
  if (wins.length > 0) {
    const [topName, topWins] = wins.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    const total = wins.reduce((a, [, n]) => a + n, 0);
    pages.push({
      title: 'Quiz champion',
      value: topName,
      sub: `${topWins} win${topWins === 1 ? '' : 's'} · ${total} round${total === 1 ? '' : 's'} won`,
    });
  }
```

Renumber the trailing "Tracking since" comment to 17.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run web/src/scene/tvContent.test.ts server/src/stats.test.ts`
Expected: PASS.

- [ ] **Step 11: Typecheck and commit**

```bash
npx tsc -b web --noEmit || npx tsc -p web/tsconfig.json --noEmit
git add shared/types.ts server/src/stats.ts server/src/stats.test.ts web/src/scene/tvContent.ts web/src/scene/tvContent.test.ts
git commit -m "feat: quiz protocol types, per-name win tallies, and the TV champion page"
```

---

### Task 2: Question generation — prompt, reply parsing, and the Haiku CLI

**Files:**
- Create: `server/src/quizPrompt.ts`, `server/src/quizPrompt.test.ts`, `server/src/haiku.ts`, `server/src/haiku.test.ts`
- Test: as above

**Interfaces:**
- Consumes: `QuizAnswer`, `QUIZ_GUESS_FROM`, `QUIZ_QUESTION_MAX_CHARS` from Task 1.
- Produces:
  - `buildQuizPrompt(answers: QuizAnswer[], mustGuess: boolean): string`
  - `parseQuizReply(raw: string, mustGuess: boolean): { text: string; guess: boolean } | null`
  - `fallbackQuestion(asked: number): string`
  - `type AskFn = (prompt: string) => Promise<string>`
  - `haikuArgs(): string[]`
  - `askHaiku: AskFn`

- [ ] **Step 1: Write the failing tests for the prompt builder and parser**

Create `server/src/quizPrompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildQuizPrompt, parseQuizReply, fallbackQuestion } from './quizPrompt.ts';
import type { QuizAnswer } from '../../shared/types.ts';

const a = (question: string, answer: 'yes' | 'no', guess = false): QuizAnswer => ({
  question,
  answer,
  guess,
  askerName: 'Dana',
  at: '2026-07-26T00:00:00.000Z',
});

describe('buildQuizPrompt', () => {
  it('states the rules and asks for JSON on an empty history', () => {
    const p = buildQuizPrompt([], false);
    expect(p).toContain('yes/no');
    expect(p).toContain('JSON');
    expect(p.toLowerCase()).toContain('first question');
  });

  it('includes every prior question and its answer, in order', () => {
    const p = buildQuizPrompt([a('Is it alive?', 'yes'), a('Is it a mammal?', 'no')], false);
    expect(p).toContain('Is it alive?');
    expect(p).toContain('Is it a mammal?');
    expect(p.indexOf('Is it alive?')).toBeLessThan(p.indexOf('Is it a mammal?'));
    expect(p).toMatch(/Is it alive\?[\s\S]*YES/i);
    expect(p).toMatch(/Is it a mammal\?[\s\S]*NO/i);
  });

  it('demands an outright guess when mustGuess is set', () => {
    expect(buildQuizPrompt([a('Is it alive?', 'yes')], true)).toMatch(/must.*guess/i);
  });

  it('does not demand a guess otherwise', () => {
    expect(buildQuizPrompt([a('Is it alive?', 'yes')], false)).not.toMatch(/must.*guess/i);
  });
});

describe('parseQuizReply', () => {
  it('parses clean JSON', () => {
    expect(parseQuizReply('{"question":"Is it alive?","guess":false}', false)).toEqual({
      text: 'Is it alive?',
      guess: false,
    });
  });

  it('extracts JSON wrapped in prose', () => {
    const raw = 'Sure! Here you go:\n```json\n{"question": "Is it a cat?", "guess": true}\n```\nHope that helps.';
    expect(parseQuizReply(raw, false)).toEqual({ text: 'Is it a cat?', guess: true });
  });

  it('defaults a missing guess field to false', () => {
    expect(parseQuizReply('{"question":"Is it red?"}', false)).toEqual({ text: 'Is it red?', guess: false });
  });

  it('forces guess=true when mustGuess is set and the model said otherwise', () => {
    expect(parseQuizReply('{"question":"Is it a cat?","guess":false}', true)).toEqual({
      text: 'Is it a cat?',
      guess: true,
    });
  });

  it('trims whitespace and collapses newlines in the question', () => {
    expect(parseQuizReply('{"question":"  Is it\\n alive?  "}', false)).toEqual({
      text: 'Is it alive?',
      guess: false,
    });
  });

  it('truncates an over-long question', () => {
    const long = 'x'.repeat(400);
    const out = parseQuizReply(JSON.stringify({ question: long }), false);
    expect(out!.text.length).toBeLessThanOrEqual(120);
  });

  it('returns null for garbage, empty output, and a blank question', () => {
    expect(parseQuizReply('I refuse to play.', false)).toBeNull();
    expect(parseQuizReply('', false)).toBeNull();
    expect(parseQuizReply('{"question":"   "}', false)).toBeNull();
    expect(parseQuizReply('{"question": 42}', false)).toBeNull();
  });
});

describe('fallbackQuestion', () => {
  it('returns a non-empty question for any count', () => {
    for (const n of [0, 1, 7, 19, 200]) expect(fallbackQuestion(n).length).toBeGreaterThan(0);
  });

  it('varies across consecutive counts so the office does not repeat itself', () => {
    expect(fallbackQuestion(0)).not.toBe(fallbackQuestion(1));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/quizPrompt.test.ts`
Expected: FAIL — cannot resolve `./quizPrompt.ts`.

- [ ] **Step 3: Implement `quizPrompt.ts`**

Create `server/src/quizPrompt.ts`:

```ts
import { QUIZ_GUESS_FROM, QUIZ_QUESTION_MAX_CHARS, type QuizAnswer } from '../../shared/types.ts';

/** A Haiku call: takes a prompt, resolves with the raw stdout text. */
export type AskFn = (prompt: string) => Promise<string>;

/**
 * The office is playing 20 Questions against the human upstairs, who never tells
 * the server the secret word — the only signal is the YES/NO history. The prompt
 * is deliberately small: it is rebuilt and re-sent on every turn.
 */
export function buildQuizPrompt(answers: QuizAnswer[], mustGuess: boolean): string {
  const history = answers
    .map((r, i) => `${i + 1}. ${r.question} → ${r.answer.toUpperCase()}`)
    .join('\n');
  const lines = [
    'We are playing 20 questions. A person is thinking of a single thing (an object, animal, place, person or concept).',
    'You are trying to work out what it is by asking yes/no questions.',
    '',
    answers.length === 0
      ? 'No questions have been asked yet. Ask a broad first question that splits the possibilities roughly in half.'
      : `Questions asked so far, with the answers:\n${history}`,
    '',
    'Rules:',
    '- Ask ONE question, 12 words or fewer, answerable with a plain YES or NO.',
    '- Never repeat a question already asked, and never contradict an answer above.',
    mustGuess
      ? `- You have asked ${answers.length} questions. You must now make an outright guess at the specific thing, e.g. "Is it a bicycle?". Set "guess" to true.`
      : '- Prefer a question that narrows things down. Only make an outright guess if the answers already point at one specific thing.',
    '',
    'Reply with nothing but a JSON object:',
    '{"question": "...", "guess": true or false}',
    '"guess" is true only when the question names one specific thing.',
  ];
  return lines.join('\n');
}

/** The first balanced `{...}` span in `raw`, or null. Tolerates code fences and chatter. */
function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse Haiku's reply defensively. Returns null when nothing usable came back —
 * the caller falls through to `fallbackQuestion` rather than retrying, so one
 * bad turn costs one call, not an unbounded loop.
 */
export function parseQuizReply(raw: string, mustGuess: boolean): { text: string; guess: boolean } | null {
  const json = firstJsonObject(raw ?? '');
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const obj = parsed as { question?: unknown; guess?: unknown };
  if (typeof obj?.question !== 'string') return null;
  const text = obj.question.replace(/\s+/g, ' ').trim().slice(0, QUIZ_QUESTION_MAX_CHARS);
  if (!text) return null;
  return { text, guess: mustGuess || obj.guess === true };
}

/**
 * Used when the CLI is missing, times out, or returns something unusable. These
 * are deliberately generic — they keep a round moving without pretending to know
 * anything about the answers so far.
 */
const FALLBACKS = [
  'Is it a physical object?',
  'Is it alive?',
  'Is it bigger than a microwave?',
  'Would I find one indoors?',
  'Is it man-made?',
  'Could I hold it in one hand?',
  'Is it something you can eat?',
  'Does it need electricity?',
];

export function fallbackQuestion(asked: number): string {
  return FALLBACKS[Math.abs(Math.trunc(asked)) % FALLBACKS.length];
}

/** Should the asker be forced to make an outright guess at this point? */
export function mustGuessAt(asked: number): boolean {
  return asked + 1 >= QUIZ_GUESS_FROM;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/src/quizPrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `haikuArgs`**

Create `server/src/haiku.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { haikuArgs, HAIKU_MODEL } from './haiku.ts';

describe('haikuArgs', () => {
  it('pins the cheapest Haiku model', () => {
    expect(HAIKU_MODEL).toBe('claude-haiku-4-5');
    expect(haikuArgs()).toContain('claude-haiku-4-5');
  });

  it('passes --no-session-persistence so our own calls are not tailed and visualized', () => {
    expect(haikuArgs()).toContain('--no-session-persistence');
  });

  it('runs in print mode', () => {
    expect(haikuArgs()).toContain('-p');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run server/src/haiku.test.ts`
Expected: FAIL — cannot resolve `./haiku.ts`.

- [ ] **Step 7: Implement `haiku.ts`**

Create `server/src/haiku.ts`. The prompt goes in on **stdin**, not argv, so a long history can't blow the argument limit:

```ts
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
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run server/src/haiku.test.ts server/src/quizPrompt.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/quizPrompt.ts server/src/quizPrompt.test.ts server/src/haiku.ts server/src/haiku.test.ts
git commit -m "feat: 20 Questions prompt builder, reply parser, and Haiku CLI wrapper"
```

---

### Task 3: The quiz state machine

**Files:**
- Create: `server/src/quiz.ts`, `server/src/quiz.test.ts`
- Test: `server/src/quiz.test.ts`

**Interfaces:**
- Consumes: `AskFn`, `buildQuizPrompt`, `parseQuizReply`, `fallbackQuestion`, `mustGuessAt` (Task 2); all quiz types and constants (Task 1).
- Produces:
  - `interface QuizAsker { id: string; name: string; variant: string; idle: boolean }`
  - `interface QuizDeps { ask: AskFn; emit(msg: ServerMsg): void; requestCapture(winner: QuizWinner): void; status(text: string): void; recordWin(name: string): void; askers(): QuizAsker[]; dataFile?: string; now?: () => number }`
  - `class Quiz` with `getState(): QuizState`, `setEnabled(on: boolean): void`, `answer(id: string, answer: 'yes' | 'no'): 'ok' | 'stale'`, `attachPhoto(): boolean`, `isAwaitingPhoto(): boolean`, `save(): void`, `stop(): void`
  - `const PHOTO_TIMEOUT_MS = 20_000`, `const CELEBRATION_MS = 15_000`

- [ ] **Step 1: Write the failing tests**

Create `server/src/quiz.test.ts`. Note the shape of the harness: fake timers plus a controllable `ask`, and a `dataFile` in `os.tmpdir()` so no real data file is touched.

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Quiz, type QuizAsker, type QuizDeps } from './quiz.ts';
import type { ServerMsg } from '../../shared/types.ts';

function harness(over: Partial<QuizDeps> = {}) {
  const emitted: ServerMsg[] = [];
  const statuses: string[] = [];
  const wins: string[] = [];
  const captures: string[] = [];
  const askers: QuizAsker[] = [
    { id: 'boss', name: 'Boss', variant: 'Knight', idle: true },
    { id: 'e1', name: 'Dana', variant: 'Mage', idle: true },
    { id: 'catPerson', name: 'Kat Person', variant: 'CatPerson', idle: true },
  ];
  let reply = '{"question":"Is it alive?","guess":false}';
  const deps: QuizDeps = {
    ask: vi.fn(async () => reply),
    emit: (m) => emitted.push(m),
    requestCapture: (w) => captures.push(w.name),
    status: (t) => statuses.push(t),
    recordWin: (n) => wins.push(n),
    askers: () => askers,
    dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'quiz.json'),
    ...over,
  };
  const quiz = new Quiz(deps);
  return {
    quiz,
    deps,
    emitted,
    statuses,
    wins,
    captures,
    askers,
    setReply: (r: string) => (reply = r),
    /** answer whatever bubble is currently up */
    answerCurrent: (a: 'yes' | 'no') => quiz.answer(quiz.getState().question!.id, a),
  };
}

/** let the in-flight ask() promise settle */
const settle = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Quiz', () => {
  it('starts disabled, with no question and no Haiku call', () => {
    const h = harness();
    expect(h.quiz.getState().enabled).toBe(false);
    expect(h.quiz.getState().question).toBeNull();
    expect(h.deps.ask).not.toHaveBeenCalled();
  });

  it('asks a first question when enabled, and broadcasts it', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    const q = h.quiz.getState().question!;
    expect(q.text).toBe('Is it alive?');
    expect(q.guess).toBe(false);
    expect(h.askers.map((a) => a.id)).toContain(q.asker);
    expect(h.emitted.some((m) => m.type === 'quiz')).toBe(true);
  });

  it('makes no Haiku call at all while disabled', () => {
    const h = harness();
    h.quiz.answer('nope', 'yes');
    expect(h.deps.ask).not.toHaveBeenCalled();
  });

  it('records an answer and asks the next question', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    h.setReply('{"question":"Is it a mammal?","guess":false}');
    expect(h.answerCurrent('yes')).toBe('ok');
    await settle();
    const st = h.quiz.getState();
    expect(st.answers).toEqual([expect.objectContaining({ question: 'Is it alive?', answer: 'yes', guess: false })]);
    expect(st.askedCount).toBe(2);
    expect(st.question!.text).toBe('Is it a mammal?');
  });

  it('rejects an answer whose id does not match the live bubble', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.answer('stale-id', 'yes')).toBe('stale');
    expect(h.quiz.getState().answers).toHaveLength(0);
  });

  it('rejects a second answer to the same bubble', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    const id = h.quiz.getState().question!.id;
    expect(h.quiz.answer(id, 'yes')).toBe('ok');
    expect(h.quiz.answer(id, 'no')).toBe('stale');
  });

  it('keeps playing when a guess is answered NO', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('no');
    await settle();
    expect(h.quiz.getState().winner).toBeNull();
    expect(h.quiz.getState().question).not.toBeNull();
  });

  it('crowns a winner when a guess is answered YES, and asks for a photo', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const askerName = h.quiz.getState().question!.askerName;
    h.answerCurrent('yes');
    await settle();
    const st = h.quiz.getState();
    expect(st.winner!.name).toBe(askerName);
    expect(st.awaitingPhoto).toBe(true);
    expect(st.question).toBeNull();
    expect(h.captures).toEqual([askerName]);
    expect(h.wins).toEqual([]); // not credited until the photo resolves
  });

  it('credits the win, hangs the photo, and starts a new round after the celebration', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const askerName = h.quiz.getState().question!.askerName;
    h.answerCurrent('yes');
    await settle();
    const roundId = h.quiz.getState().roundId;

    expect(h.quiz.attachPhoto()).toBe(true);
    expect(h.wins).toEqual([askerName]);
    expect(h.quiz.getState().photo!.name).toBe(askerName);
    expect(h.quiz.getState().awaitingPhoto).toBe(false);
    expect(h.statuses.some((s) => s.includes(askerName))).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    const st = h.quiz.getState();
    expect(st.roundId).not.toBe(roundId);
    expect(st.answers).toHaveLength(0);
    expect(st.winner).toBeNull();
    expect(st.question).not.toBeNull();
    expect(st.photo!.name).toBe(askerName); // the photo outlives the round
  });

  it('still credits the win when no photo ever arrives', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const askerName = h.quiz.getState().question!.askerName;
    h.answerCurrent('yes');
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(h.wins).toEqual([askerName]);
    expect(h.quiz.getState().awaitingPhoto).toBe(false);
    expect(h.quiz.getState().photo).toBeUndefined(); // previous photo, if any, is untouched
  });

  it('rejects a photo when it is not waiting for one', () => {
    const h = harness();
    expect(h.quiz.attachPhoto()).toBe(false);
  });

  it('forces an outright guess from question 15', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    // answer 13 narrowing questions; the 15th question asked must be a guess
    for (let i = 0; i < 13; i++) {
      h.setReply(`{"question":"Narrow ${i}?","guess":false}`);
      h.answerCurrent('no');
      await settle();
    }
    expect(h.quiz.getState().askedCount).toBe(14);
    h.setReply('{"question":"Still narrowing?","guess":false}');
    h.answerCurrent('no');
    await settle();
    expect(h.quiz.getState().askedCount).toBe(15);
    expect(h.quiz.getState().question!.guess).toBe(true);
  });

  it('concedes at 20 questions and starts a fresh round', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    const roundId = h.quiz.getState().roundId;
    for (let i = 0; i < 20; i++) {
      h.setReply(`{"question":"Q${i}?","guess":false}`);
      h.answerCurrent('no');
      await settle();
    }
    expect(h.statuses.some((s) => s.startsWith('⚠'))).toBe(true);
    const st = h.quiz.getState();
    expect(st.roundId).not.toBe(roundId);
    expect(st.answers).toHaveLength(0);
    expect(st.winner).toBeNull();
  });

  it('falls back to a canned question when Haiku rejects, and says so', async () => {
    const h = harness({ ask: vi.fn(async () => { throw new Error('spawn claude ENOENT'); }) });
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.getState().question!.text.length).toBeGreaterThan(0);
    expect(h.statuses.some((s) => s.startsWith('⚠'))).toBe(true);
  });

  it('falls back to a canned question when the reply is unparseable', async () => {
    const h = harness({ ask: vi.fn(async () => 'I would rather not.') });
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.getState().question!.text.length).toBeGreaterThan(0);
  });

  it('falls back rather than re-prompting when Haiku repeats itself', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    const first = h.quiz.getState().question!.text;
    h.answerCurrent('yes'); // reply is unchanged, so the same question comes back
    await settle();
    expect(h.quiz.getState().question!.text).not.toBe(first);
    expect(h.deps.ask).toHaveBeenCalledTimes(2); // one call per turn, no retry loop
  });

  it('prefers idle employees but still plays when everyone is busy', async () => {
    const askers: QuizAsker[] = [
      { id: 'e1', name: 'Busy', variant: 'Mage', idle: false },
      { id: 'e2', name: 'Free', variant: 'Rogue', idle: true },
    ];
    const h = harness({ askers: () => askers });
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.getState().question!.asker).toBe('e2');

    const busy: QuizAsker[] = [{ id: 'e1', name: 'Busy', variant: 'Mage', idle: false }];
    const h2 = harness({ askers: () => busy });
    h2.quiz.setEnabled(true);
    await settle();
    expect(h2.quiz.getState().question!.asker).toBe('e1');
  });

  it('does not ask when there is nobody to ask', async () => {
    const h = harness({ askers: () => [] });
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.getState().question).toBeNull();
  });

  it('clears the bubble and stops calling when disabled mid-round', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    const calls = (h.deps.ask as ReturnType<typeof vi.fn>).mock.calls.length;
    h.quiz.setEnabled(false);
    expect(h.quiz.getState().question).toBeNull();
    expect(h.quiz.getState().answers).toHaveLength(1); // the round is preserved
    await vi.advanceTimersByTimeAsync(60_000);
    expect((h.deps.ask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('resumes the same round when re-enabled', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    const roundId = h.quiz.getState().roundId;
    h.quiz.setEnabled(false);
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.getState().roundId).toBe(roundId);
    expect(h.quiz.getState().answers).toHaveLength(1);
  });

  it('round-trips through the data file, dropping awaitingPhoto', async () => {
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'quiz.json');
    const h = harness({ dataFile, ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    h.quiz.save();

    const h2 = harness({ dataFile });
    const st = h2.quiz.getState();
    expect(st.enabled).toBe(true);
    expect(st.answers).toHaveLength(1);
    expect(st.awaitingPhoto).toBe(false);
    expect(st.winner).toBeNull();
  });

  it('starts fresh on a corrupt data file', () => {
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'quiz.json');
    fs.writeFileSync(dataFile, '{ not json');
    const h = harness({ dataFile });
    expect(h.quiz.getState().enabled).toBe(false);
    expect(h.quiz.getState().answers).toHaveLength(0);
  });

  it('never puts a capture flag on the broadcast state', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    for (const m of h.emitted) {
      if (m.type === 'quiz') expect(m.capture).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/quiz.test.ts`
Expected: FAIL — cannot resolve `./quiz.ts`.

- [ ] **Step 3: Implement `quiz.ts`**

Create `server/src/quiz.ts`:

```ts
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

/** The persisted slice: everything except the ephemeral photo handshake. */
type Persisted = Omit<QuizState, 'awaitingPhoto' | 'winner'>;

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
      question: this.state.question,
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
    } catch (err) {
      this.deps.status(`⚠ Haiku unavailable — the office is guessing blind`);
      parsed = null;
    } finally {
      this.asking = false;
    }
    // enabled may have flipped while the call was in flight
    if (!this.state.enabled) return;
    const asked = new Set(this.state.answers.map((a) => a.question.toLowerCase()));
    if (!parsed || asked.has(parsed.text.toLowerCase())) {
      parsed = { text: fallbackQuestion(this.state.askedCount), guess: mustGuess };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/src/quiz.test.ts`
Expected: PASS. If the `settle()` helper isn't draining enough microtasks for a given test, add another `await Promise.resolve()` inside `settle` rather than adding timer advances — the ask chain is promise-based, not timer-based.

- [ ] **Step 5: Commit**

```bash
git add server/src/quiz.ts server/src/quiz.test.ts
git commit -m "feat: 20 Questions state machine with persistence and photo handshake"
```

---

### Task 4: Server wiring — decor storage, HTTP routes, capture assignment

**Files:**
- Modify: `server/src/decor.ts`
- Modify: `server/src/index.ts`
- Test: `server/src/decor.test.ts` (create if absent — check first; `server/src/characters.test.ts` shows the style)

**Interfaces:**
- Consumes: `Quiz`, `QuizAsker` (Task 3); `askHaiku` (Task 2); `recordGameWin` (Task 1).
- Produces: `DecorStore.eotmPath(): string`, `DecorStore.clearEotm(): void`; the routes `PUT /api/quiz`, `POST /api/quiz/answer`, `GET|POST /api/decor/eotm`.

- [ ] **Step 1: Write the failing test for the decor paths**

Add to `server/src/decor.test.ts` (create the file with the imports mirroring `characters.test.ts` if it does not exist):

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecorStore } from './decor.ts';

describe('DecorStore eotm', () => {
  it('stores the photo as a png beside the painting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const store = new DecorStore(dir);
    expect(store.eotmPath()).toBe(path.join(dir, 'eotm.png'));
  });

  it('clearEotm removes the file and tolerates it being absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const store = new DecorStore(dir);
    fs.writeFileSync(store.eotmPath(), 'x');
    store.clearEotm();
    expect(fs.existsSync(store.eotmPath())).toBe(false);
    expect(() => store.clearEotm()).not.toThrow();
  });

  it('clearing the painting does not clear the photo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const store = new DecorStore(dir);
    fs.writeFileSync(store.eotmPath(), 'x');
    fs.writeFileSync(store.wallArtPath('png'), 'y');
    store.clearWallArt();
    expect(fs.existsSync(store.eotmPath())).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/src/decor.test.ts`
Expected: FAIL — `store.eotmPath is not a function`.

- [ ] **Step 3: Implement the decor paths**

In `server/src/decor.ts`, add to the `DecorStore` class after `clearWallArt`:

```ts
  /**
   * The Employee of the Month photo. Always PNG — it comes from a canvas
   * capture, not a user upload, so there is no format to negotiate.
   */
  eotmPath(): string {
    return path.join(this.dir, 'eotm.png');
  }

  clearEotm(): void {
    fs.rmSync(this.eotmPath(), { force: true });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/src/decor.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the `Quiz` instance in `index.ts`**

In `server/src/index.ts`, add imports beside the existing ones (line 9):

```ts
import { Quiz, type QuizAsker } from './quiz.ts';
import { askHaiku } from './haiku.ts';
```

After the `stats` construction (line 23), add — `broadcast` and `wss` are declared further down the file, so these read them lazily inside callbacks rather than capturing them at construction time:

```ts
/**
 * Candidate questioners for the 20 Questions game: every employee, the boss, and
 * Kat Person (who is furniture, not staff — she has no roster entry, so she is
 * named here). Idle staff are preferred by the Quiz itself.
 */
const quizAskers = (): QuizAsker[] => {
  const st = office.getState();
  return [
    { id: 'boss', name: st.boss.name, variant: st.boss.variant, idle: st.bossStatus === 'idle' },
    ...st.employees.map((e) => ({ id: e.id, name: e.name, variant: e.variant, idle: e.status === 'idle' })),
    { id: 'catPerson', name: 'Kat Person', variant: 'CatPerson', idle: true },
  ];
};

const quiz = new Quiz({
  ask: askHaiku,
  emit: (msg) => broadcast(msg),
  requestCapture: (winner) => requestPhotoCapture(winner),
  status: (text) => office.pushStatus('quiz', text),
  recordWin: (name) => {
    stats.recordGameWin(name);
    stats.flush();
    broadcast({ type: 'stats', stats: stats.snapshot() });
  },
  askers: quizAskers,
});
```

- [ ] **Step 6: Implement capture assignment**

Add below the `broadcast` helper (after line 228 in `index.ts`):

```ts
/**
 * Ask exactly ONE client to photograph the winner. Assigned rather than elected:
 * a dozen open tabs would otherwise each fly their camera and upload a shot.
 * If that client is gone or its capture fails, the Quiz's photo timeout takes
 * over and the win is credited without a new photo.
 */
const requestPhotoCapture = (winner: QuizWinner) => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(JSON.stringify({ type: 'quiz', quiz: quiz.getState(), capture: winner }));
    return;
  }
};
```

Add `QuizWinner` to the type-only import from `../../shared/types.ts` — if `index.ts` has no such import yet, add:

```ts
import type { QuizWinner } from '../../shared/types.ts';
```

- [ ] **Step 7: Send quiz state on connect**

In the `wss.on('connection')` handler (line 230), add after the stats send:

```ts
  ws.send(JSON.stringify({ type: 'quiz', quiz: quiz.getState() }));
```

Note the absence of `capture` here — deliberate, and asserted by a Task 3 test. A client that connects mid-photo-window is never asked to shoot.

- [ ] **Step 8: Add the quiz routes**

In the request handler in `server/src/index.ts`, add before the final `send(404, ...)` (line 217):

```ts
    if (url.pathname === '/api/quiz' && req.method === 'PUT') {
      const body = await readBody();
      if (typeof body.enabled !== 'boolean') return send(400, { error: 'enabled must be a boolean' });
      quiz.setEnabled(body.enabled);
      return send(200, { ok: true, quiz: quiz.getState() });
    }
    if (url.pathname === '/api/quiz/answer' && req.method === 'POST') {
      const body = await readBody();
      if (typeof body.id !== 'string' || (body.answer !== 'yes' && body.answer !== 'no')) {
        return send(400, { error: 'need { id: string, answer: "yes" | "no" }' });
      }
      const result = quiz.answer(body.id, body.answer);
      // a stale id means another tab already answered this bubble
      return result === 'ok' ? send(200, { ok: true }) : send(409, { error: 'that question is no longer open' });
    }
```

- [ ] **Step 9: Add the photo routes**

Add immediately after the quiz routes:

```ts
    if (url.pathname === '/api/decor/eotm') {
      if (req.method === 'GET') {
        const photo = quiz.getState().photo;
        if (!photo || !streamFile(decor.eotmPath(), res, 'image/png', 'public, max-age=31536000, immutable')) {
          return send(404, { error: 'no employee of the month yet' });
        }
        return;
      }
      if (req.method === 'POST') {
        // only accepted during the handshake window, so a stray POST can't hang a photo
        if (!quiz.isAwaitingPhoto()) return send(409, { error: 'not waiting for a photo' });
        const result = await saveUpload(req, decor.eotmPath(), 'image');
        if (!result.ok) return send(400, { error: result.error });
        return quiz.attachPhoto() ? send(200, { ok: true }) : send(409, { error: 'not waiting for a photo' });
      }
    }
```

- [ ] **Step 10: Clear the photo with the layout**

In the `DELETE /api/layout` handler (line 166), add `decor.clearEotm();` beside the existing `decor.clearWallArt();`, and extend the comment to say the Employee of the Month photo is a wall hanging too. The `quiz` state's `photo` field must also be cleared — add a `clearPhoto()` method to `Quiz`:

```ts
  /** The photo is a wall hanging: resetting the room takes it down. */
  clearPhoto(): void {
    delete this.state.photo;
    this.publish();
  }
```

and call `quiz.clearPhoto();` in the same handler.

- [ ] **Step 11: Add the status colour for the new kind**

In `web/src/scene/Whiteboard.tsx:220`, the status board colours only `kind === 'boss'`. Give quiz lines their own colour so a win reads as a win:

```ts
    ctx.fillStyle = item.kind === 'boss' ? '#a33' : item.kind === 'quiz' ? '#7a5c12' : '#22262b';
```

- [ ] **Step 12: Run the full server suite and typecheck**

Run: `npx vitest run server/ && npx tsc -p server/tsconfig.json --noEmit`
Expected: PASS with no type errors. (If `server/` has no `tsconfig.json`, skip the typecheck — the server runs under `tsx`; run `npx vitest run` instead.)

- [ ] **Step 13: Start the app and smoke-test the routes**

```bash
docker compose up -d
curl -sX PUT localhost:4680/api/quiz -H 'Content-Type: application/json' -d '{"enabled":true}' | head -c 400
```
Expected: JSON with `"ok":true` and a `quiz` object. Within a few seconds a second call to `curl -s localhost:4680/api/state` still works, and `curl -sX PUT localhost:4680/api/quiz -d '{"enabled":false}' -H 'Content-Type: application/json'` disables it. If `claude` is unavailable in the container the question falls back to a canned one — that is the designed behaviour, not a failure.

- [ ] **Step 14: Commit**

```bash
git add server/src/decor.ts server/src/decor.test.ts server/src/index.ts server/src/quiz.ts web/src/scene/Whiteboard.tsx
git commit -m "feat: quiz HTTP routes, EOTM photo storage, and single-client capture assignment"
```

---

### Task 5: Client store slice and API helpers

**Files:**
- Modify: `web/src/store.ts`
- Create: `web/src/quiz/quizApi.ts`
- Test: `web/src/store.test.ts`

**Interfaces:**
- Consumes: `QuizState`, `QuizWinner`, the `quiz` `ServerMsg` variant (Task 1).
- Produces:
  - store fields `quiz: QuizState | null`, `pendingCapture: QuizWinner | null`, `clearPendingCapture(): void`
  - `setQuizEnabled(enabled: boolean): Promise<void>`
  - `answerQuiz(id: string, answer: 'yes' | 'no'): Promise<void>`
  - `uploadEotmPhoto(blob: Blob): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/store.test.ts` (reuse the file's existing import of `useStore` and its pattern for building state messages):

```ts
import type { QuizState } from '../../shared/types.ts';

const quizState = (over: Partial<QuizState> = {}): QuizState => ({
  enabled: true,
  roundId: 'r1',
  askedCount: 1,
  answers: [],
  question: { id: 'q1', text: 'Is it alive?', guess: false, asker: 'e1', askerName: 'Dana', at: '2026-07-26T00:00:00.000Z' },
  awaitingPhoto: false,
  winner: null,
  ...over,
});

describe('quiz messages', () => {
  it('stores quiz state', () => {
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState() });
    expect(useStore.getState().quiz!.question!.text).toBe('Is it alive?');
  });

  it('records a capture request only when one is addressed to this client', () => {
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true }) });
    expect(useStore.getState().pendingCapture).toBeNull();

    const winner = { name: 'Dana', variant: 'Mage', at: '2026-07-26T00:00:00.000Z' };
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true, winner }), capture: winner });
    expect(useStore.getState().pendingCapture).toEqual(winner);

    useStore.getState().clearPendingCapture();
    expect(useStore.getState().pendingCapture).toBeNull();
  });

  it('drops a pending capture when the server stops waiting for a photo', () => {
    const winner = { name: 'Dana', variant: 'Mage', at: '2026-07-26T00:00:00.000Z' };
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: true, winner }), capture: winner });
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ awaitingPhoto: false }) });
    expect(useStore.getState().pendingCapture).toBeNull();
  });

  it('does not resurrect a bubble from a superseded round', () => {
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ roundId: 'r2' }) });
    useStore.getState().applyServerMsg({ type: 'quiz', quiz: quizState({ roundId: 'r1' }) });
    expect(useStore.getState().quiz!.roundId).toBe('r2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/store.test.ts -t quiz`
Expected: FAIL — `quiz` is undefined on the store.

- [ ] **Step 3: Implement the store slice**

In `web/src/store.ts`, add `QuizState` and `QuizWinner` to the type-only import on line 2. Add to the `AppStore` interface (after `stats`, line 139):

```ts
  quiz: QuizState | null;
  /**
   * Set only when THIS client was the one asked to photograph the winner. The
   * server assigns one client, so this stays null in every other tab.
   */
  pendingCapture: QuizWinner | null;
  clearPendingCapture: () => void;
```

Add the initial values beside `stats: null` (line 225):

```ts
  quiz: null,
  pendingCapture: null,
```

Add the handler in `applyServerMsg`, after the `stats` branch (line 272):

```ts
    if (msg.type === 'quiz') {
      // rounds only ever move forward; a message from a finished round (a
      // reconnect replay racing a live broadcast) must not resurrect its bubble
      const prev = get().quiz;
      if (prev && prev.roundId !== msg.quiz.roundId && quizRoundSeen.has(msg.quiz.roundId)) return;
      quizRoundSeen.add(msg.quiz.roundId);
      set({
        quiz: msg.quiz,
        // the assignment is per-message; drop it as soon as the server stops waiting
        pendingCapture: msg.capture ?? (msg.quiz.awaitingPhoto ? get().pendingCapture : null),
      });
      return;
    }
```

Add near the other module-level keys (line 190):

```ts
/** round ids already seen, so a replayed message from a finished round is ignored */
const quizRoundSeen = new Set<string>();
```

Add the action beside `setSettingsOpen` (line 326):

```ts
  clearPendingCapture: () => set({ pendingCapture: null }),
```

And a test reset helper beside the others at the end of the file:

```ts
/** test-only: forget seen round ids so each test starts clean */
export function resetQuizRoundsForTest() {
  quizRoundSeen.clear();
}
```

Call `resetQuizRoundsForTest()` in a `beforeEach` in the new `describe` block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/store.test.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Create the API helpers**

Create `web/src/quiz/quizApi.ts`:

```ts
/**
 * The three quiz endpoints. Nothing here applies state locally — the server
 * broadcasts the new quiz state, so the UI updates from the socket like
 * everything else in the office does.
 */

export async function setQuizEnabled(enabled: boolean): Promise<void> {
  await fetch('/api/quiz', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/**
 * A 409 means the bubble was already answered (another tab got there first) —
 * expected, not an error worth surfacing.
 */
export async function answerQuiz(id: string, answer: 'yes' | 'no'): Promise<void> {
  await fetch('/api/quiz/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, answer }),
  }).catch(() => {});
}

/** Raw-body POST, matching the wall-art and character uploads: no multipart parser server-side. */
export async function uploadEotmPhoto(blob: Blob): Promise<void> {
  await fetch('/api/decor/eotm', { method: 'POST', body: blob });
}
```

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc -p web/tsconfig.json --noEmit
git add web/src/store.ts web/src/store.test.ts web/src/quiz/quizApi.ts
git commit -m "feat: quiz store slice and API helpers"
```

---

### Task 6: The speech bubble

**Files:**
- Create: `web/src/quiz/askerAnchor.ts`, `web/src/quiz/askerAnchor.test.ts`, `web/src/quiz/SpeechBubble.tsx`
- Modify: `web/src/scene/Office.tsx`
- Test: `web/src/quiz/askerAnchor.test.ts`

**Interfaces:**
- Consumes: store `quiz` slice (Task 5), `answerQuiz` (Task 5), `seatTransform`/`roomDims` from `web/src/scene/layout.ts`, `resolveFurniture` from `web/src/scene/buildLayout.ts`.
- Produces: `askerAnchor(asker: string, office: OfficeState | null, maxSeat: number): [number, number, number] | null`, and the `<SpeechBubble />` component (no props — it reads the store).

- [ ] **Step 1: Write the failing tests for the anchor**

Create `web/src/quiz/askerAnchor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { askerAnchor } from './askerAnchor.ts';
import { seatTransform, roomDims } from '../scene/layout.ts';
import type { OfficeState } from '../../../shared/types.ts';

const office = (): OfficeState => ({
  officeName: 'This Office',
  boss: { name: 'Boss', variant: 'Knight' },
  bossStatus: 'idle',
  employees: [
    { id: 'e1', name: 'Dana', seat: 1, variant: 'Mage', hiredAt: '', status: 'idle', task: null },
    { id: 'e2', name: 'Rey', seat: 5, variant: 'Rogue', hiredAt: '', status: 'idle', task: null },
  ],
  inbox: [],
  todos: null,
  status: [],
  staffing: { minEmployees: 3, maxEmployees: 12, idleTimeoutSec: 60 },
  waitingForInput: false,
});

describe('askerAnchor', () => {
  it('anchors the boss above seat 0', () => {
    const [x, y, z] = askerAnchor('boss', office(), 5)!;
    expect(x).toBeCloseTo(seatTransform(0).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(0).position.z, 5);
    // above a ~2.3-unit character in a 1.35x-scale world, not at head height
    expect(y).toBeGreaterThan(2.3);
    expect(y).toBeLessThan(4);
  });

  it('anchors an employee above their own seat', () => {
    const [x, , z] = askerAnchor('e2', office(), 5)!;
    expect(x).toBeCloseTo(seatTransform(5).position.x, 5);
    expect(z).toBeCloseTo(seatTransform(5).position.z, 5);
  });

  it('follows a desk moved in build mode', () => {
    const withLayout = { ...office(), layout: { seats: { 1: { x: 2.5, z: 3.5, rotY: 0 } } } };
    const [x, , z] = askerAnchor('e1', withLayout, 5)!;
    expect(x).toBeCloseTo(2.5, 5);
    expect(z).toBeCloseTo(3.5, 5);
  });

  it('anchors Kat Person over her furniture slot, inside the room', () => {
    const [x, , z] = askerAnchor('catPerson', office(), 5)!;
    const { width, depth, centerZ } = roomDims(5);
    expect(Math.abs(x)).toBeLessThan(width / 2);
    expect(z).toBeGreaterThan(centerZ - depth / 2);
    expect(z).toBeLessThan(centerZ + depth / 2);
  });

  it('returns null for an unknown asker and for no office', () => {
    expect(askerAnchor('ghost', office(), 5)).toBeNull();
    expect(askerAnchor('boss', null, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/quiz/askerAnchor.test.ts`
Expected: FAIL — cannot resolve `./askerAnchor.ts`.

- [ ] **Step 3: Implement `askerAnchor.ts`**

Create `web/src/quiz/askerAnchor.ts`. Note this resolves through `resolveSeat`/`resolveFurniture` (not the raw `seatTransform`) so the bubble follows anything the user has dragged in build mode, and that `resolveFurniture` returns items whose position lives under a nested `pose`:

```ts
import type { OfficeState } from '../../../shared/types.ts';
import { resolveFurniture, resolveSeat } from '../scene/buildLayout.ts';

/**
 * World scale is ~1.35x human: characters are ~2.3 units tall, so the bubble
 * hangs above that rather than at the ~1.1 look-at height the cameras use.
 */
const BUBBLE_Y = 3.0;

/**
 * Where the speech bubble hangs for a given asker id. Kat Person is furniture,
 * not staff, so her anchor comes from the layout rather than a seat.
 */
export function askerAnchor(
  asker: string,
  office: OfficeState | null,
  maxSeat: number,
): [number, number, number] | null {
  if (!office) return null;
  if (asker === 'catPerson') {
    // Kat Person is furniture, not staff: her spot comes from the layout, and
    // `resolveFurniture` nests it under `pose`
    const item = resolveFurniture(office.layout, maxSeat).find((f) => f.id === 'catPerson');
    return item ? [item.pose.x, BUBBLE_Y, item.pose.z] : null;
  }
  const seat = asker === 'boss' ? 0 : office.employees.find((e) => e.id === asker)?.seat;
  if (seat === undefined) return null;
  const { position } = resolveSeat(office.layout, seat, maxSeat);
  return [position.x, BUBBLE_Y, position.z];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/quiz/askerAnchor.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `SpeechBubble.tsx`**

Create `web/src/quiz/SpeechBubble.tsx`. drei's `<Html>` gives real DOM buttons, so YES/NO need no raycast picking:

```tsx
import { Html } from '@react-three/drei';
import { useStore } from '../store.ts';
import { askerAnchor } from './askerAnchor.ts';
import { answerQuiz } from './quizApi.ts';

/**
 * The office's 20 Questions prompt, above whoever is asking.
 *
 * This is the one speech bubble in the scene, and a deliberate exception to the
 * "all activity renders on monitors" rule: it is game UI needing two clickable
 * targets, not activity telemetry. Only ever one is mounted.
 */
export function SpeechBubble({ maxSeat }: { maxSeat: number }) {
  const question = useStore((s) => s.quiz?.question ?? null);
  const office = useStore((s) => s.office);
  const buildMode = useStore((s) => s.buildMode);

  // build mode is for rearranging the room; a click-through bubble is in the way
  if (!question || buildMode) return null;
  const anchor = askerAnchor(question.asker, office, maxSeat);
  if (!anchor) return null;

  return (
    <Html position={anchor} center distanceFactor={9} zIndexRange={[10, 0]}>
      <div style={styles.bubble}>
        <div style={styles.who}>{question.askerName}</div>
        <div style={styles.text}>{question.text}</div>
        <div style={styles.row}>
          <button style={{ ...styles.btn, ...styles.yes }} onClick={() => answerQuiz(question.id, 'yes')}>
            ✓ YES
          </button>
          <button style={{ ...styles.btn, ...styles.no }} onClick={() => answerQuiz(question.id, 'no')}>
            ✗ NO
          </button>
        </div>
      </div>
      <div style={styles.tail} />
    </Html>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bubble: {
    width: 240,
    boxSizing: 'border-box',
    background: '#f7f4ec',
    color: '#1b1f24',
    border: '2px solid #2c333d',
    borderRadius: 14,
    padding: '10px 12px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    userSelect: 'none',
  },
  who: { fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#6b7280', marginBottom: 4 },
  text: { fontSize: 15, lineHeight: 1.3, marginBottom: 10 },
  row: { display: 'flex', gap: 8 },
  btn: {
    flex: 1,
    border: 'none',
    borderRadius: 8,
    padding: '7px 0',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    color: '#fff',
  },
  yes: { background: '#2e7d43' },
  no: { background: '#a33a33' },
  tail: {
    width: 0,
    height: 0,
    margin: '0 auto',
    borderLeft: '9px solid transparent',
    borderRight: '9px solid transparent',
    borderTop: '12px solid #2c333d',
  },
};
```

- [ ] **Step 6: Mount it in the scene**

In `web/src/scene/Office.tsx`, import it beside the other scene imports and render it inside the room group next to `<WallArt .../>` (line 285), passing the `maxSeat` the component already has in scope:

```tsx
      <SpeechBubble maxSeat={maxSeat} />
```

- [ ] **Step 7: Verify in the running app**

```bash
docker compose up -d
curl -sX PUT localhost:4680/api/quiz -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
```
Open http://localhost:5173, confirm a bubble appears above someone within a few seconds, click YES, and confirm the bubble is replaced by a new question. Press **P** and check the fps/draw-call readout is unchanged from the ~119 calls / 60 fps baseline — one `<Html>` overlay must not move it.

- [ ] **Step 8: Commit**

```bash
git add web/src/quiz/askerAnchor.ts web/src/quiz/askerAnchor.test.ts web/src/quiz/SpeechBubble.tsx web/src/scene/Office.tsx
git commit -m "feat: 20 Questions speech bubble with YES/NO buttons"
```

---

### Task 7: The winner's photo — framing, capture, camera mode

**Files:**
- Create: `web/src/quiz/photoShot.ts`, `web/src/quiz/photoShot.test.ts`, `web/src/quiz/capture.ts`
- Modify: `web/src/scene/CameraRig.tsx`
- Test: `web/src/quiz/photoShot.test.ts`

**Interfaces:**
- Consumes: `askerAnchor` (Task 6), `uploadEotmPhoto` + `pendingCapture`/`clearPendingCapture` (Task 5), `roomDims` from `web/src/scene/layout.ts`.
- Produces:
  - `photoShot(subject: THREE.Vector3, maxSeat: number): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number }`
  - `captureCanvas(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<Blob>`
  - `PHOTO_FLY_MS`, `PHOTO_HOLD_MS`

- [ ] **Step 1: Write the failing tests for the framing**

Create `web/src/quiz/photoShot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { photoShot } from './photoShot.ts';
import { roomDims, seatTransform, ROOM_HEIGHT } from '../scene/layout.ts';

const SEATS = [0, 1, 2, 3, 5, 9, 12];

describe('photoShot', () => {
  it('keeps the camera inside the room for every seat', () => {
    for (const maxSeat of [3, 6, 12]) {
      const { width, depth, centerZ } = roomDims(maxSeat);
      for (const seat of SEATS) {
        const subject = seatTransform(seat).position;
        const { position } = photoShot(subject, maxSeat);
        expect(Math.abs(position.x)).toBeLessThan(width / 2);
        expect(position.z).toBeGreaterThan(centerZ - depth / 2);
        expect(position.z).toBeLessThan(centerZ + depth / 2);
        expect(position.y).toBeGreaterThan(0.5);
        expect(position.y).toBeLessThan(ROOM_HEIGHT);
      }
    }
  });

  it('frames the subject within the shot', () => {
    const subject = seatTransform(2).position;
    const { position, lookAt, fov } = photoShot(subject, 6);
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
    camera.position.copy(position);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const ndc = subject.clone().setY(1.4).project(camera);
    expect(Math.abs(ndc.x)).toBeLessThan(1);
    expect(Math.abs(ndc.y)).toBeLessThan(1);
    expect(ndc.z).toBeGreaterThan(-1);
    expect(ndc.z).toBeLessThan(1);
  });

  it('places the subject off-centre so colleagues fill the rest of the frame', () => {
    const subject = seatTransform(2).position;
    const { position, lookAt, fov } = photoShot(subject, 6);
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 100);
    camera.position.copy(position);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const ndcX = subject.clone().setY(1.4).project(camera).x;
    expect(Math.abs(ndcX)).toBeGreaterThan(0.08);
  });

  it('stands far enough back to catch more than just the subject', () => {
    const subject = seatTransform(2).position;
    const { position } = photoShot(subject, 6);
    expect(position.distanceTo(subject)).toBeGreaterThan(3);
  });

  it('is deterministic', () => {
    const subject = seatTransform(4).position;
    const a = photoShot(subject, 6);
    const b = photoShot(subject, 6);
    expect(a.position.toArray()).toEqual(b.position.toArray());
    expect(a.fov).toBe(b.fov);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/quiz/photoShot.test.ts`
Expected: FAIL — cannot resolve `./photoShot.ts`.

- [ ] **Step 3: Implement `photoShot.ts`**

Create `web/src/quiz/photoShot.ts`. If `ROOM_HEIGHT` is not already exported from `layout.ts` it is (line 13) — use it:

```ts
import * as THREE from 'three';
import { roomDims, ROOM_HEIGHT } from '../scene/layout.ts';

/** Eye height of the shot: chest-high on a ~2.3-unit character, so faces read. */
const CAMERA_Y = 1.9;
/** What the lens is pointed at, slightly above the desk tops (y=1.0). */
const LOOK_Y = 1.4;
/** Back far enough that neighbours land in frame behind the winner. */
const STANDOFF = 5.2;
/** Wide enough for a group shot without fisheye. */
const PHOTO_FOV = 46;
/**
 * The look-at is nudged sideways from the subject, which pushes the winner off
 * centre — they stay the subject, but the frame is a group photo, not a mugshot.
 */
const OFFSET = 1.15;
/** Keep the camera off the walls even in the smallest room. */
const WALL_MARGIN = 0.8;

/**
 * A "live picture" of the winner: shot from in front of and slightly to the side
 * of them, low enough to catch faces, wide enough that whoever else is nearby
 * ends up in it too. Deterministic, so the same winner always gets the same
 * composition, and clamped so the camera never ends up behind a wall.
 */
export function photoShot(
  subject: THREE.Vector3,
  maxSeat: number,
): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
  const { width, depth, centerZ } = roomDims(maxSeat);
  const halfW = width / 2 - WALL_MARGIN;
  const frontZ = centerZ + depth / 2 - WALL_MARGIN;
  const backZ = centerZ - depth / 2 + WALL_MARGIN;

  // stand on the room-centre side of the subject, so the shot looks back across the office
  const towardCentre = Math.sign(centerZ - subject.z) || 1;
  const position = new THREE.Vector3(
    THREE.MathUtils.clamp(subject.x + OFFSET * 1.6, -halfW, halfW),
    THREE.MathUtils.clamp(CAMERA_Y, 0.6, ROOM_HEIGHT - 0.5),
    THREE.MathUtils.clamp(subject.z + towardCentre * STANDOFF, backZ, frontZ),
  );
  const lookAt = new THREE.Vector3(
    THREE.MathUtils.clamp(subject.x - OFFSET, -halfW, halfW),
    LOOK_Y,
    subject.z,
  );
  return { position, lookAt, fov: PHOTO_FOV };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/quiz/photoShot.test.ts`
Expected: PASS. If the off-centre or in-frame assertion fails, tune `OFFSET` and `STANDOFF` — do not weaken the assertions; they are the point of the module.

- [ ] **Step 5: Implement `capture.ts`**

Create `web/src/quiz/capture.ts`:

```ts
import type * as THREE from 'three';

/** Camera fly-in and the beat it holds before the shutter. */
export const PHOTO_FLY_MS = 1200;
export const PHOTO_HOLD_MS = 400;

/**
 * Read the scene out of the WebGL canvas.
 *
 * The render and the read MUST happen in the same tick: the drawing buffer is
 * cleared after a normal frame, so `toDataURL` on its own returns a blank image.
 * The alternative — `preserveDrawingBuffer: true` on the Canvas — taxes every
 * frame forever for one screenshot per game, so it stays off.
 */
export async function captureCanvas(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<Blob> {
  gl.render(scene, camera);
  const dataUrl = gl.domElement.toDataURL('image/png');
  const res = await fetch(dataUrl);
  return res.blob();
}
```

- [ ] **Step 6: Add the photo camera mode**

In `web/src/scene/CameraRig.tsx`, add a `PhotoControls` component and mount it from `CameraRig` (near the `{wallArtHover && <WallArtControls />}` line, 363). Read the surrounding `CameraRig` body first so the new component matches how `FocusControls` acquires `camera`, `gl` and `scene`:

```tsx
/**
 * Runs only when the server asked THIS client for the winner's photo: fly to the
 * group shot, hold a beat, shoot, upload, fly back. Failure is silent by design —
 * the server's photo timeout credits the win regardless.
 */
function PhotoControls({ winner, maxSeat }: { winner: QuizWinner; maxSeat: number }) {
  const { camera, gl, scene } = useThree();
  const office = useStore((s) => s.office);
  const quiz = useStore((s) => s.quiz);

  useEffect(() => {
    const askerId =
      quiz?.question?.asker ??
      office?.employees.find((e) => e.name === winner.name)?.id ??
      (office?.boss.name === winner.name ? 'boss' : 'catPerson');
    const anchor = askerAnchor(askerId, office, maxSeat);
    if (!anchor) {
      useStore.getState().clearPendingCapture();
      return;
    }
    const subject = new THREE.Vector3(anchor[0], 0, anchor[2]);
    const shot = photoShot(subject, maxSeat);
    const from = camera.position.clone();
    const fromQuat = camera.quaternion.clone();
    const perspective = camera as THREE.PerspectiveCamera;
    const baseFov = perspective.fov;

    // target orientation, computed once by parking a scratch camera at the shot
    const scratch = perspective.clone();
    scratch.position.copy(shot.position);
    scratch.lookAt(shot.lookAt);
    const toQuat = scratch.quaternion.clone();

    let raf = 0;
    const t0 = performance.now();
    let shooting = false;

    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / PHOTO_FLY_MS);
      const e = t * t * (3 - 2 * t); // smoothstep
      camera.position.lerpVectors(from, shot.position, e);
      camera.quaternion.slerpQuaternions(fromQuat, toQuat, e);
      perspective.fov = THREE.MathUtils.lerp(baseFov, shot.fov, e);
      perspective.updateProjectionMatrix();
      if (t < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (shooting) return;
      shooting = true;
      setTimeout(() => {
        void captureCanvas(gl, scene, camera)
          .then(uploadEotmPhoto)
          .catch(() => {})
          .finally(() => {
            camera.position.copy(from);
            camera.quaternion.copy(fromQuat);
            perspective.fov = baseFov;
            perspective.updateProjectionMatrix();
            useStore.getState().clearPendingCapture();
          });
      }, PHOTO_HOLD_MS);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      perspective.fov = baseFov;
      perspective.updateProjectionMatrix();
    };
    // one effect per capture request; `winner` identity is the trigger
  }, [winner, maxSeat, camera, gl, scene, office, quiz?.question?.asker]);

  return null;
}
```

Mount it from `CameraRig`:

```tsx
  const pendingCapture = useStore((s) => s.pendingCapture);
  ...
      {pendingCapture && <PhotoControls winner={pendingCapture} maxSeat={maxSeat} />}
```

`CameraRig` has no `maxSeat` in scope; derive it exactly as `buildPovList` does at `web/src/scene/CameraRig.tsx:46`:

```tsx
  const office = useStore((s) => s.office);
  const maxSeat = Math.max(3, ...(office?.employees.map((e) => e.seat) ?? []));
```

Add the imports for `THREE`, `askerAnchor`, `photoShot`, `captureCanvas`, `PHOTO_FLY_MS`, `PHOTO_HOLD_MS`, `uploadEotmPhoto`, and `type QuizWinner`.

- [ ] **Step 7: Verify end to end in the running app**

```bash
docker compose up -d
curl -sX PUT localhost:4680/api/quiz -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
```
Open http://localhost:5173. Answer questions with NO until a guess appears (or answer YES repeatedly to reach the forced-guess phase faster), then answer YES to a guess. Expected: the camera flies to a group shot, holds, returns; the server logs a successful POST; and

```bash
curl -sI localhost:4680/api/decor/eotm | head -1
```
returns `200`. If it returns 404, check the browser console for a `toDataURL` security error — that indicates the render-and-read fell out of the same tick.

- [ ] **Step 8: Commit**

```bash
git add web/src/quiz/photoShot.ts web/src/quiz/photoShot.test.ts web/src/quiz/capture.ts web/src/scene/CameraRig.tsx
git commit -m "feat: winner photo framing, canvas capture, and the photo camera mode"
```

---

### Task 8: The Employee of the Month frame

**Files:**
- Create: `web/src/scene/eotmTexture.ts`, `web/src/scene/eotmTexture.test.ts`, `web/src/scene/EotmFrame.tsx`
- Modify: `web/src/scene/buildLayout.ts:264-296`, `web/src/scene/buildLayout.test.ts`, `web/src/scene/Office.tsx`
- Test: `web/src/scene/eotmTexture.test.ts`, `web/src/scene/buildLayout.test.ts`

**Interfaces:**
- Consumes: `EotmPhoto` (Task 1), store `quiz` slice (Task 5), `wallArtTransform` from `web/src/scene/wallArtTexture.ts`, `WALL_ITEMS`/`defaultWallOffset`/`useWallOffset`/`WallHandle`.
- Produces: `captionLines(name: string): string[]`, `EOTM_W`, `EOTM_H`, and the `<EotmFrame position rotationY? />` component; a new `eotm` entry in `WALL_ITEMS`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/scene/eotmTexture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { captionLines } from './eotmTexture.ts';

describe('captionLines', () => {
  it('always leads with the title', () => {
    expect(captionLines('Dana')[0]).toBe('EMPLOYEE OF THE MONTH');
  });

  it('names the winner on the second line', () => {
    expect(captionLines('Dana')[1]).toBe('Dana');
  });

  it('truncates an absurd name rather than overflowing the plaque', () => {
    const line = captionLines('x'.repeat(200))[1];
    expect(line.length).toBeLessThanOrEqual(24);
  });

  it('falls back to a placeholder for an empty name', () => {
    expect(captionLines('   ')[1]).toBe('—');
  });
});
```

Add to `web/src/scene/buildLayout.test.ts`:

```ts
  it('places the employee-of-the-month frame on the back wall without overlapping', () => {
    for (const maxSeat of [3, 6, 12]) {
      const ox = defaultWallOffset('eotm', maxSeat);
      expect(isWallPlacementValid(undefined, 'eotm', ox, maxSeat)).toBe(true);
    }
  });

  it('keeps every default back-wall item mutually valid', () => {
    for (const id of ['windowBack', 'wallArt', 'eotm']) {
      expect(isWallPlacementValid(undefined, id, defaultWallOffset(id, 6), 6)).toBe(true);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/scene/eotmTexture.test.ts web/src/scene/buildLayout.test.ts`
Expected: FAIL — cannot resolve `./eotmTexture.ts`; the `eotm` placement test fails because the item does not exist.

- [ ] **Step 3: Register the wall item**

In `web/src/scene/buildLayout.ts`, add to `WALL_ITEMS` (line 264):

```ts
  { id: 'eotm', wall: 'back', halfW: 0.8 },
```

and to `defaultWallOffset` (line 277), before `default`:

```ts
    case 'eotm':
      // dead centre of the back wall, directly behind the boss. windowBack sits at
      // -width/4 and wallArt at width/4 + 0.5, so 0 clears both half-widths at every
      // room size (width is constant as the room grows).
      return 0;
```

- [ ] **Step 4: Implement `eotmTexture.ts`**

Create `web/src/scene/eotmTexture.ts`:

```ts
/** Frame aperture, in world units. Landscape, matching a 16:9 canvas capture. */
export const EOTM_W = 1.42;
export const EOTM_H = 0.8;

/** Room for the plaque under the photo. */
export const EOTM_CAPTION_H = 0.26;

const NAME_MAX = 24;

/**
 * The two lines on the plaque. The name is truncated rather than wrapped — the
 * plaque is one line tall, and a hand-edited roster name could be any length.
 */
export function captionLines(name: string): string[] {
  const trimmed = name.trim();
  return ['EMPLOYEE OF THE MONTH', trimmed ? trimmed.slice(0, NAME_MAX) : '—'];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run web/src/scene/eotmTexture.test.ts web/src/scene/buildLayout.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement `EotmFrame.tsx`**

Create `web/src/scene/EotmFrame.tsx`. The caption is a `CanvasTexture` drawn once per winner — gated on the name, so it never redraws per frame (`redrawGate.ts`'s rule, satisfied here by drawing in an effect rather than `useFrame`):

```tsx
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { useStore } from '../store.ts';
import { wallArtTransform } from './wallArtTexture.ts';
import { captionLines, EOTM_W, EOTM_H, EOTM_CAPTION_H } from './eotmTexture.ts';

const CAPTION_PX_W = 512;
const CAPTION_PX_H = 96;

/** The plaque under the photo: repainted only when the winner's name changes. */
function useCaptionTexture(name: string): THREE.CanvasTexture {
  const ref = useRef<{ canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } | null>(null);
  if (!ref.current) {
    const canvas = document.createElement('canvas');
    canvas.width = CAPTION_PX_W;
    canvas.height = CAPTION_PX_H;
    ref.current = { canvas, texture: new THREE.CanvasTexture(canvas) };
  }
  const { canvas, texture } = ref.current;

  useEffect(() => {
    const ctx = canvas.getContext('2d')!;
    const [title, who] = captionLines(name);
    ctx.fillStyle = '#1a1408';
    ctx.fillRect(0, 0, CAPTION_PX_W, CAPTION_PX_H);
    ctx.fillStyle = '#d8b45a';
    ctx.textAlign = 'center';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(title, CAPTION_PX_W / 2, 32);
    ctx.font = 'bold 38px system-ui, sans-serif';
    ctx.fillText(who, CAPTION_PX_W / 2, 76);
    texture.needsUpdate = true;
  }, [canvas, texture, name]);

  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/**
 * The Employee of the Month photo behind the boss: a live screenshot of the
 * winner taken the moment they won, replaced by the next winner. Unlike the
 * painting beside it this is not clickable — it is earned, not uploaded.
 */
export function EotmFrame({ position }: { position: [number, number, number] }) {
  const photo = useStore((s) => s.quiz?.photo);
  // primitives, not the object: the quiz state arrives as a fresh object on every broadcast
  const v = photo?.v;
  const name = photo?.name ?? '';
  const caption = useCaptionTexture(name);

  if (!v) {
    // no winner yet: an empty frame, so the wall doesn't have a hole in it
    return (
      <group position={position}>
        <mesh castShadow>
          <boxGeometry args={[EOTM_W + 0.16, EOTM_H + EOTM_CAPTION_H + 0.16, 0.06]} />
          <meshStandardMaterial color="#2b2418" roughness={0.5} />
        </mesh>
        <mesh position={[0, -(EOTM_H + EOTM_CAPTION_H) / 2 + EOTM_CAPTION_H / 2, 0.035]}>
          <planeGeometry args={[EOTM_W, EOTM_CAPTION_H]} />
          <meshStandardMaterial map={caption} roughness={0.8} />
        </mesh>
      </group>
    );
  }
  return <EotmPhotoFrame position={position} v={v} caption={caption} />;
}

/** Split out so `useTexture` (which suspends) never mounts without a photo to load. */
function EotmPhotoFrame({
  position,
  v,
  caption,
}: {
  position: [number, number, number];
  v: number;
  caption: THREE.CanvasTexture;
}) {
  const texture = useTexture(`/api/decor/eotm?v=${v}`);

  useEffect(() => {
    const img = texture.image as { width?: number; height?: number } | undefined;
    if (!img?.width || !img?.height) return;
    // cover-fit, same maths as the painting: a screenshot is never the frame's aspect
    const { repeat, offset } = wallArtTransform(img.width / img.height, EOTM_W / EOTM_H, 1, 0);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
    texture.offset.set(offset[0], offset[1]);
    texture.needsUpdate = true;
  }, [texture]);

  const framePos = useMemo(
    () => [0, (EOTM_H + EOTM_CAPTION_H) / 2 - EOTM_H / 2, 0.035] as [number, number, number],
    [],
  );

  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[EOTM_W + 0.16, EOTM_H + EOTM_CAPTION_H + 0.16, 0.06]} />
        <meshStandardMaterial color="#2b2418" roughness={0.5} />
      </mesh>
      <mesh position={framePos}>
        <planeGeometry args={[EOTM_W, EOTM_H]} />
        <meshStandardMaterial map={texture} roughness={0.9} />
      </mesh>
      <mesh position={[0, -(EOTM_H + EOTM_CAPTION_H) / 2 + EOTM_CAPTION_H / 2, 0.035]}>
        <planeGeometry args={[EOTM_W, EOTM_CAPTION_H]} />
        <meshStandardMaterial map={caption} roughness={0.8} />
      </mesh>
    </group>
  );
}
```

- [ ] **Step 7: Mount the frame and its build handle**

In `web/src/scene/Office.tsx`, import `EotmFrame`, resolve its offset beside `artOx` (line 194):

```tsx
  const eotmOx = useWallOffset('eotm', maxSeat);
```

render it beside `<WallArt .../>` (line 285):

```tsx
      <EotmFrame position={[eotmOx, 2.15, backZ + 0.05]} />
```

and add its handle beside the `wallArt` handle (line 288), matching the surrounding build-mode conditional (`wallItem` is a local helper already defined at `Office.tsx:196`, so it is in scope):

```tsx
          <WallHandle id="eotm" wall="back" ox={eotmOx} oy={2.15} w={wallItem('eotm').halfW * 2} h={1.3} />
```

- [ ] **Step 8: Verify in the running app**

With a photo already captured from Task 7, reload http://localhost:5173. Expected: the frame hangs centred on the back wall behind the boss with the photo and a gold "EMPLOYEE OF THE MONTH / <name>" plaque. Press **B** and confirm the frame can be dragged along the back wall and cannot be dropped overlapping the window or the painting. Press **P** and confirm draw calls rose by only a handful.

- [ ] **Step 9: Run the whole suite and commit**

```bash
npx vitest run
git add web/src/scene/eotmTexture.ts web/src/scene/eotmTexture.test.ts web/src/scene/EotmFrame.tsx web/src/scene/buildLayout.ts web/src/scene/buildLayout.test.ts web/src/scene/Office.tsx
git commit -m "feat: Employee of the Month frame with the winner's live photo"
```

---

### Task 9: Settings panel section

**Files:**
- Modify: `web/src/settings/SettingsPanel.tsx`

**Interfaces:**
- Consumes: store `quiz` slice (Task 5), `setQuizEnabled` (Task 5).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the section**

In `web/src/settings/SettingsPanel.tsx`, import the store field and the helper, then insert a section between "Staffing" and "Layout" (before line 75). Wire the checkbox to the server state so it reflects what the server actually has, not local optimism:

```tsx
        <h3 style={styles.sectionTitle}>20 Questions</h3>
        <label style={{ ...styles.row, cursor: 'pointer', alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={quizEnabled}
            onChange={(e) => setQuizEnabled(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span style={{ fontSize: 13, lineHeight: 1.4 }}>
            Enable 20 questions game
            <span style={{ display: 'block', fontSize: 12, color: '#9aa4b0', marginTop: 4 }}>
              An employee, the boss or Kat Person asks you yes/no questions to guess what you're thinking of.
              Answer with the buttons above their head; whoever guesses right gets their picture on the wall.
            </span>
            <span style={{ display: 'block', fontSize: 12, color: '#c9a227', marginTop: 6 }}>
              ⚠ Uses tokens. Each answer you give costs one Claude Haiku 4.5 call (up to 20 per round). Nothing is
              called while this is unchecked.
            </span>
          </span>
        </label>
```

Add near the top of the component, beside the other `useStore` calls (line 13):

```tsx
  const quizEnabled = useStore((s) => s.quiz?.enabled ?? false);
```

and import `setQuizEnabled` from `../quiz/quizApi.ts`.

- [ ] **Step 2: Verify in the running app**

Reload http://localhost:5173, open settings. Expected: the section renders with the cost warning; the checkbox reflects the current server state; ticking it makes a bubble appear within seconds; unticking it makes the bubble disappear immediately and no further questions arrive. Reload the page with it enabled and confirm the checkbox is still ticked (state came from the server, not localStorage).

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc -p web/tsconfig.json --noEmit
git add web/src/settings/SettingsPanel.tsx
git commit -m "feat: 20 Questions settings section with cost disclosure"
```

---

### Task 10: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Amend the speech-bubble invariant**

In `CLAUDE.md`, find the Web section's line reading *"No speech bubbles by design — all activity renders on monitors."* and replace that clause with:

```
monitor text lives in the store, rendered as in-world CanvasTextures
(`scene/MonitorScreen.tsx`). All *activity* renders on monitors — the sole
speech bubble in the scene is the 20 Questions prompt (`quiz/SpeechBubble.tsx`),
which is game UI needing two clickable targets, not activity telemetry.
```

Keep the surrounding sentence structure intact; only the invariant's wording changes.

- [ ] **Step 2: Document the game in the architecture section**

Add a paragraph after the wall-art paragraph in `CLAUDE.md`:

```
The optional **20 Questions** game (settings checkbox, off by default, zero LLM
calls while off) lives in `server/src/quiz.ts` — a persisted state machine
(`data/quiz.json`) that asks Claude Haiku 4.5 for one question per answered turn
via `haiku.ts` (`claude -p --no-session-persistence`, the same feedback-loop guard
the old summarizer needed). Quiz state rides its own `{type:'quiz'}` message
rather than `OfficeState`, so a question every turn doesn't rebroadcast the whole
office and defeat `stableLayout`. A random employee/boss/Kat Person asks; the
player answers YES/NO on a drei `<Html>` bubble; a YES to a guess wins.
Guessing is forced from Q15 and the office concedes at Q20. On a win the server
asks exactly ONE client (assigned, not elected) to fly the camera to a group shot
and POST a canvas capture to `/api/decor/eotm`; that photo hangs in the `eotm`
wall frame with a plaque until the next winner. Failure of any kind still credits
the win — `gameWins` on `UsageStats` drives a TV champion page. Screenshots
render-then-`toDataURL` in one tick precisely so `preserveDrawingBuffer` can stay
off.
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, with no pre-existing tests broken. Every new test file appears in the run.

- [ ] **Step 4: Full manual pass**

```bash
docker compose up -d
```

Walk the whole feature and confirm each of these:

1. Settings shows the section, unchecked, with the cost warning.
2. `data/quiz.json` does not exist, or has `"enabled": false`, and the server log shows no `claude` invocation.
3. Tick the box → a bubble appears above someone within ~10 s.
4. Click YES → the bubble is replaced by a different question; the questions visibly narrow.
5. Open a second tab → the same bubble appears in both; answering in one updates the other.
6. Restart the server (`docker compose restart server`) mid-round → the round resumes with the answers intact (`data/quiz.json` shows them).
7. Reach a guess and answer YES → the camera flies, shoots, returns; the frame behind the boss shows the photo with the winner's name.
8. The status board shows the 🏆 line; the TV rotation includes a "Quiz champion" page.
9. Press **P**: fps/draw calls/triangles are within noise of the ~119 / 230k / 60 baseline for the same headcount.
10. Press **B**: the new frame drags along the back wall and refuses overlapping drops.
11. Settings → Reset layout → the photo comes down along with the painting.
12. Untick the box → the bubble vanishes and no further questions arrive.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the 20 Questions game and amend the speech-bubble invariant"
```

---

## Self-review notes

Checked against the spec:

- **Spec coverage** — every spec section maps to a task: data model + protocol + win tallies → Task 1; question generation and rules → Task 2; round lifecycle, asker selection, failure table, persistence → Task 3; HTTP API, capture assignment, `DELETE /api/layout` clearing the photo → Task 4; store slice → Task 5; bubble → Task 6; screenshot and camera → Task 7; frame + wall item → Task 8; cost disclosure → Task 9; `CLAUDE.md` amendment and the known trade-off's documentation → Task 10.
- **One addition beyond the spec** — `Quiz.clearPhoto()` (Task 4, Step 10). The spec says resetting the layout clears the photo but only described deleting the file; the metadata on `QuizState` has to go too or the frame would point at a missing image.
- **Naming consistency** — `askerAnchor`, `photoShot`, `captureCanvas`, `captionLines`, `recordGameWin`, `attachPhoto`, `isAwaitingPhoto`, `clearPendingCapture` are each defined once and referenced under exactly that name in later tasks.
- **Signatures verified against the codebase**, so Tasks 6–8 carry no guesswork: `resolveFurniture(layout, maxSeat)` returns items with a nested `pose` (`buildLayout.ts:233`); `askerAnchor` therefore resolves through `resolveSeat`/`resolveFurniture` rather than raw `seatTransform`, which also makes the bubble follow desks moved in build mode; `maxSeat` is `Math.max(3, ...seats)` (`CameraRig.tsx:46`); `wallItem` is a local helper already in scope in `Office.tsx:196`.
- **Two remaining adaptation points**, each with an instruction to read the file and match it rather than a placeholder: the existing test-helper names in `stats.test.ts` and the `UsageStats` builder in `tvContent.test.ts` (which needs `gameWins: {}` added to its base object).
