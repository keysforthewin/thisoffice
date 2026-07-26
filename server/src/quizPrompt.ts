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
