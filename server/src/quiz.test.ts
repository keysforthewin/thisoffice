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
    expect(st.question).toBeNull();
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
