import { QUIZ_QUESTION_MAX_CHARS, type QuizAnswer } from '../../shared/types.ts';

/** A Haiku call: takes a prompt, resolves with the raw stdout text. */
export type AskFn = (prompt: string) => Promise<string>;

/**
 * The office is playing a yes/no guessing game against the human upstairs, who
 * never tells the server the secret word — the only signal is the YES/NO
 * history. The prompt is rebuilt and re-sent on every turn.
 *
 * The whole history goes in every time, uncompacted. A NO is as much of a fact
 * as a YES ("is it alive?" → NO rules out most of the world), so summarising the
 * tail would throw away exactly what the model needs to keep bisecting. A very
 * long round is a few KB of prompt — not worth the information.
 *
 * The prompt's job is to stop the model reaching for a name too early. Its
 * natural failure mode, once the category is known, is to start reeling off
 * candidates — "is it Taylor Swift?", "is it Beyoncé?" — which is hopeless in a
 * field of thousands. Hence the explicit ordering below: state what is
 * established, size the remaining field, and only name something once that field
 * is small. There is no question limit, so halving again always beats a
 * long-odds guess.
 */
export function buildQuizPrompt(answers: QuizAnswer[]): string {
  const history = answers
    .map((r, i) => `${i + 1}. ${r.question} → ${r.answer.toUpperCase()}`)
    .join('\n');
  const lines = [
    'The office is playing a yes/no guessing game against a person upstairs.',
    'They are thinking of one specific thing: an object, animal, place, person, work of fiction or concept.',
    'You work out what it is by asking yes/no questions. There is NO limit on how many you may ask.',
    '',
    answers.length === 0
      ? 'No questions have been asked yet. Ask a broad first question that splits the possibilities roughly in half.'
      : `Questions asked so far, with the answers:\n${history}`,
    '',
    'How to choose the next question:',
    '- Work out what the answers already establish, and roughly how many things still fit.',
    '- Ask the question that splits that remaining field closest to in half. A question whose answer you could already predict is a wasted turn.',
    '- Narrow the category before the individual: kind of thing → broad class → subclass → specific.',
    '- Do NOT name a specific thing until only a handful of candidates remain. Naming one out of hundreds is a wasted turn; halving the field again is always better.',
    '- In particular, never guess a named person until era, field, nationality and gender are all pinned down.',
    '- Ask ONE question, 12 words or fewer, answerable with a plain YES or NO.',
    '- Never repeat a question already asked, and never ask something an earlier answer has already settled.',
    '',
    'Reply with nothing but a JSON object, filling the fields in this order:',
    '{"established": "one line: what the answers so far pin down",',
    ' "field": "roughly how many things still fit, e.g. \'thousands of living musicians\'",',
    ' "question": "your next question",',
    ' "guess": true or false}',
    '"guess" is true only when "question" names one specific thing — set it only once "field" is down to a few candidates.',
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
export function parseQuizReply(raw: string): { text: string; guess: boolean } | null {
  const json = firstJsonObject(raw ?? '');
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  // `established` and `field` are the model's own narrowing, asked for so it
  // reasons before it commits; nothing downstream reads them.
  const obj = parsed as { question?: unknown; guess?: unknown };
  if (typeof obj?.question !== 'string') return null;
  const text = obj.question.replace(/\s+/g, ' ').trim().slice(0, QUIZ_QUESTION_MAX_CHARS);
  if (!text) return null;
  return { text, guess: obj.guess === true };
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
