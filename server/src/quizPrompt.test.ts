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
