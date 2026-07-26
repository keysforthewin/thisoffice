import { describe, expect, it } from 'vitest';
import { quizKeyAnswer } from './QuestionBar.tsx';

describe('quizKeyAnswer', () => {
  it('maps y to yes and n to no', () => {
    expect(quizKeyAnswer('y')).toBe('yes');
    expect(quizKeyAnswer('n')).toBe('no');
  });

  it('accepts the shifted/caps forms', () => {
    expect(quizKeyAnswer('Y')).toBe('yes');
    expect(quizKeyAnswer('N')).toBe('no');
  });

  it('ignores every other key', () => {
    for (const k of ['a', 'Enter', 'Escape', ' ', 'b', 'm', 'p', 'v', 'ArrowLeft', 'Tab']) {
      expect(quizKeyAnswer(k)).toBeNull();
    }
  });

  it('stays inert while a text field has focus, so renaming the office cannot answer', () => {
    expect(quizKeyAnswer('y', { typing: true })).toBeNull();
    expect(quizKeyAnswer('n', { typing: true })).toBeNull();
  });

  it('drops held-key autorepeat', () => {
    expect(quizKeyAnswer('y', { repeat: true })).toBeNull();
  });

  it('leaves modified combos to the browser and OS', () => {
    expect(quizKeyAnswer('y', { modified: true })).toBeNull();
    expect(quizKeyAnswer('n', { modified: true })).toBeNull();
  });

  it('treats no guards as all-clear', () => {
    expect(quizKeyAnswer('y', {})).toBe('yes');
    expect(quizKeyAnswer('y', { typing: false, repeat: false, modified: false })).toBe('yes');
  });
});
