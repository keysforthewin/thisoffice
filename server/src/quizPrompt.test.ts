import { describe, it, expect } from 'vitest';
import { buildQuizPrompt, parseQuizReply } from './quizPrompt.ts';
import type { QuizAnswer } from '../../shared/types.ts';
import { QUIZ_QUESTION_MAX_CHARS } from '../../shared/types.ts';

const a = (question: string, answer: 'yes' | 'no', guess = false): QuizAnswer => ({
  question,
  answer,
  guess,
  askerName: 'Dana',
  at: '2026-07-26T00:00:00.000Z',
});

describe('buildQuizPrompt', () => {
  it('states the rules and asks for JSON on an empty history', () => {
    const p = buildQuizPrompt([]);
    expect(p).toContain('yes/no');
    expect(p).toContain('JSON');
    expect(p.toLowerCase()).toContain('first question');
  });

  it('includes every prior question and its answer, in order', () => {
    const p = buildQuizPrompt([a('Is it alive?', 'yes'), a('Is it a mammal?', 'no')]);
    expect(p).toContain('Is it alive?');
    expect(p).toContain('Is it a mammal?');
    expect(p.indexOf('Is it alive?')).toBeLessThan(p.indexOf('Is it a mammal?'));
    expect(p).toMatch(/Is it alive\?[\s\S]*YES/i);
    expect(p).toMatch(/Is it a mammal\?[\s\S]*NO/i);
  });

  it('leaves a legacy blind turn out of the evidence', () => {
    // Nothing writes `fallback` any more, but rounds recorded before blind
    // guessing was removed are still on disk: the answer says nothing about the
    // secret word, and reads as a contradiction of what is established.
    const canned: QuizAnswer = { ...a('Is it bigger than a microwave?', 'no'), fallback: true };
    const p = buildQuizPrompt([a('Is she known for acting?', 'yes'), canned]);
    expect(p).toContain('Is she known for acting?');
    expect(p).not.toContain('Is it bigger than a microwave?');
  });

  it('numbers the surviving history contiguously', () => {
    const canned: QuizAnswer = { ...a('Is it man-made?', 'no'), fallback: true };
    const p = buildQuizPrompt([a('Is it alive?', 'yes'), canned, a('Is it a person?', 'yes')]);
    expect(p).toContain('1. Is it alive?');
    expect(p).toContain('2. Is it a person?');
    expect(p).not.toMatch(/^3\./m);
  });

  it('never demands a guess — narrowing always beats a long-odds name', () => {
    const p = buildQuizPrompt([a('Is it alive?', 'yes')]);
    expect(p).not.toMatch(/must.*guess/i);
    expect(p).toMatch(/no limit/i);
  });

  it('holds the model off naming a person until the field is narrow', () => {
    const p = buildQuizPrompt([a('Is it a person?', 'yes')]);
    expect(p).toMatch(/never guess a named person/i);
    expect(p).toMatch(/handful of candidates/i);
  });

  it('asks the model to size the remaining field before it commits to a question', () => {
    const p = buildQuizPrompt([a('Is it a person?', 'yes')]);
    // the reasoning fields must come before "question" so they actually inform it
    expect(p.indexOf('"established"')).toBeLessThan(p.indexOf('"question"'));
    expect(p.indexOf('"field"')).toBeLessThan(p.indexOf('"question"'));
  });
});

describe('parseQuizReply', () => {
  it('parses clean JSON', () => {
    expect(parseQuizReply('{"question":"Is it alive?","guess":false}')).toEqual({
      text: 'Is it alive?',
      guess: false,
    });
  });

  it('extracts JSON wrapped in prose', () => {
    const raw = 'Sure! Here you go:\n```json\n{"question": "Is it a cat?", "guess": true}\n```\nHope that helps.';
    expect(parseQuizReply(raw)).toEqual({ text: 'Is it a cat?', guess: true });
  });

  it('defaults a missing guess field to false', () => {
    expect(parseQuizReply('{"question":"Is it red?"}')).toEqual({ text: 'Is it red?', guess: false });
  });

  it('takes the model at its word on guess — nothing can force one', () => {
    expect(parseQuizReply('{"question":"Is it a cat?","guess":false}')).toEqual({
      text: 'Is it a cat?',
      guess: false,
    });
  });

  it('ignores the reasoning fields it asked the model to fill in', () => {
    const raw = '{"established":"a living animal","field":"thousands","question":"Is it a mammal?","guess":false}';
    expect(parseQuizReply(raw)).toEqual({ text: 'Is it a mammal?', guess: false });
  });

  it('trims whitespace and collapses newlines in the question', () => {
    expect(parseQuizReply('{"question":"  Is it\\n alive?  "}')).toEqual({
      text: 'Is it alive?',
      guess: false,
    });
  });

  it('truncates an over-long question', () => {
    const long = 'x'.repeat(400);
    const out = parseQuizReply(JSON.stringify({ question: long }));
    expect(out!.text.length).toBeLessThanOrEqual(QUIZ_QUESTION_MAX_CHARS);
  });

  it('returns null for garbage, empty output, and a blank question', () => {
    expect(parseQuizReply('I refuse to play.')).toBeNull();
    expect(parseQuizReply('')).toBeNull();
    expect(parseQuizReply('{"question":"   "}')).toBeNull();
    expect(parseQuizReply('{"question": 42}')).toBeNull();
  });
});
