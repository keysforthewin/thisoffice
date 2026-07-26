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
    { id: 'boss', name: 'Boss', variant: 'Knight', seat: 0, idle: true },
    { id: 'e1', name: 'Dana', variant: 'Mage', seat: 1, idle: true },
    { id: 'catPerson', name: 'Kat Person', variant: 'CatPerson', seat: null, idle: true },
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

  describe('restart', () => {
    it('drops the round in progress and opens a fresh one', async () => {
      const h = harness();
      h.quiz.setEnabled(true);
      await settle();
      h.answerCurrent('yes');
      await settle();
      const stale = h.quiz.getState();
      expect(stale.answers).toHaveLength(1);
      expect(stale.askedCount).toBe(2);

      h.quiz.restart();
      await settle();
      const st = h.quiz.getState();
      expect(st.answers).toEqual([]);
      // the counter reset, then the fresh round's opening question landed
      expect(st.askedCount).toBe(1);
      expect(st.roundId).not.toBe(stale.roundId);
      // a new question is up, so the office carries on playing
      expect(st.question).not.toBeNull();
      expect(st.question!.id).not.toBe(stale.question?.id);
      expect(h.statuses).toContain('20 questions: starting a new round');
    });

    it('frees a winner still waiting on a photo', async () => {
      const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
      h.quiz.setEnabled(true);
      await settle();
      h.answerCurrent('yes');
      await settle();
      expect(h.quiz.getState().awaitingPhoto).toBe(true);

      h.quiz.restart();
      await settle();
      const st = h.quiz.getState();
      expect(st.awaitingPhoto).toBe(false);
      expect(st.winner).toBeNull();
      // the win was already banked when the guess landed — restarting is not a
      // way to take it back
      expect(h.wins).toHaveLength(1);
    });

    it('keeps the wall photo, which outlives every round', async () => {
      const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
      h.quiz.setEnabled(true);
      await settle();
      h.answerCurrent('yes');
      await settle();
      h.quiz.attachPhoto(() => true);
      const photo = h.quiz.getState().photo;
      expect(photo).toBeTruthy();

      h.quiz.restart();
      await settle();
      expect(h.quiz.getState().photo).toEqual(photo);
    });

    it('asks nothing while the game is switched off', async () => {
      const h = harness();
      h.quiz.restart();
      await settle();
      expect(h.deps.ask).not.toHaveBeenCalled();
      expect(h.quiz.getState().question).toBeNull();
    });
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
    // the win is the fact, the photo is decoration: credited the moment the
    // guess lands, so nothing downstream of here can cost the player the win
    expect(h.wins).toEqual([askerName]);
  });

  it('credits the win, hangs the photo, and starts a new round after the celebration', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const askerName = h.quiz.getState().question!.askerName;
    const roundId = h.quiz.getState().roundId;
    h.answerCurrent('yes');
    await settle();

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

  it('never forces a guess, however long the round runs', async () => {
    // the old rule turned Q15+ into blind naming — hopeless in a field of
    // thousands, and the reason a round used to end in random celebrities
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    for (let i = 0; i < 24; i++) {
      h.setReply(`{"question":"Narrow ${i}?","guess":false}`);
      h.answerCurrent('no');
      await settle();
      expect(h.quiz.getState().question!.guess).toBe(false);
    }
  });

  it('runs past 20 questions without conceding or resetting the round', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    const roundId = h.quiz.getState().roundId;
    for (let i = 0; i < 30; i++) {
      h.setReply(`{"question":"Q${i}?","guess":false}`);
      h.answerCurrent('no');
      await settle();
    }
    const st = h.quiz.getState();
    expect(st.roundId).toBe(roundId);
    expect(st.answers).toHaveLength(30);
    expect(st.askedCount).toBe(31);
    expect(h.statuses.some((s) => s.includes('gave up'))).toBe(false);
  });

  it('still wins whenever the model volunteers a guess that lands', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    for (let i = 0; i < 3; i++) {
      h.setReply(`{"question":"Narrow ${i}?","guess":false}`);
      h.answerCurrent('no');
      await settle();
    }
    h.setReply('{"question":"Is it a bicycle?","guess":true}');
    h.answerCurrent('no');
    await settle();
    expect(h.quiz.getState().question!.guess).toBe(true);
    h.answerCurrent('yes');
    expect(h.quiz.getState().winner).not.toBeNull();
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
      { id: 'e1', name: 'Busy', variant: 'Mage', seat: 1, idle: false },
      { id: 'e2', name: 'Free', variant: 'Rogue', seat: 2, idle: true },
    ];
    const h = harness({ askers: () => askers });
    h.quiz.setEnabled(true);
    await settle();
    expect(h.quiz.getState().question!.asker).toBe('e2');

    const busy: QuizAsker[] = [{ id: 'e1', name: 'Busy', variant: 'Mage', seat: 1, idle: false }];
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

  it('keeps askedCount consistent with history across repeated toggling', async () => {
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    expect(h.quiz.getState().answers).toHaveLength(1);

    // toggling off and on repeatedly discards the unanswered bubble and re-asks;
    // askedCount must not inflate on each re-issue
    for (let i = 0; i < 14; i++) {
      h.quiz.setEnabled(false);
      h.quiz.setEnabled(true);
      await settle();
    }
    const st = h.quiz.getState();
    expect(st.answers).toHaveLength(1);
    expect(st.askedCount).toBe(st.answers.length + 1);
    expect(st.question!.guess).toBe(false); // nowhere near a forced guess with only 1 answer
  });

  it('round-trips through the data file, dropping awaitingPhoto', async () => {
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'quiz.json');
    const h = harness({ dataFile });
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

  it('records exactly one win per victory, whichever way the photo resolves', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    expect(h.wins).toHaveLength(1);
    expect(h.quiz.attachPhoto()).toBe(true); // the photo arrives
    expect(h.quiz.attachPhoto()).toBe(false); // a second, late upload
    await vi.advanceTimersByTimeAsync(20_000); // and the timeout fires anyway
    await settle();
    expect(h.wins).toHaveLength(1);

    // the other order: timeout first, photo afterwards
    const h2 = harness({ ask: vi.fn(async () => '{"question":"Is it a dog?","guess":true}') });
    h2.quiz.setEnabled(true);
    await settle();
    h2.answerCurrent('yes');
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(h2.quiz.attachPhoto()).toBe(false);
    expect(h2.wins).toHaveLength(1);
  });

  it('keeps the win when the server restarts inside the photo window', async () => {
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'quiz.json');
    const h = harness({ dataFile, ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const askerName = h.quiz.getState().question!.askerName;
    h.answerCurrent('yes');
    await settle();
    expect(h.wins).toEqual([askerName]); // credited before the photo, and persisted-safe
    h.quiz.stop(); // process exits mid-window: no finishWin, no newRound

    // the resumed round must not re-interrogate the already-guessed word
    const h2 = harness({ dataFile });
    await settle();
    const st = h2.quiz.getState();
    expect(st.answers).toHaveLength(0);
    expect(st.awaitingPhoto).toBe(false);
    expect(st.winner).toBeNull();
    expect(h2.wins).toEqual([]); // and the win is not double-counted on resume
  });

  it('keeps the win when the game is disabled inside the photo window', async () => {
    const h = harness({ ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const askerName = h.quiz.getState().question!.askerName;
    h.answerCurrent('yes');
    await settle();
    h.quiz.setEnabled(false);
    expect(h.wins).toEqual([askerName]);
    expect(h.quiz.getState().answers).toHaveLength(0); // round already closed
  });

  it('keeps the celebration durable: a restart during it resumes a clean round', async () => {
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-')), 'quiz.json');
    const h = harness({ dataFile, ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    h.answerCurrent('yes');
    await settle();
    h.quiz.attachPhoto();
    h.quiz.stop(); // restart during the 15 s celebration

    const h2 = harness({ dataFile });
    await settle();
    expect(h2.quiz.getState().answers).toHaveLength(0);
    expect(h2.quiz.getState().question).not.toBeNull();
  });

  it('never flags a canned fallback as an outright guess', async () => {
    // Haiku is down: a canned narrowing question must not be winnable, or a
    // YES would credit a win for a question that named nothing.
    const h = harness();
    h.quiz.setEnabled(true);
    await settle();
    (h.deps.ask as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('spawn claude ENOENT');
    });
    h.answerCurrent('no');
    await settle();
    const q = h.quiz.getState().question!;
    expect(q.text.length).toBeGreaterThan(0);
    expect(q.guess).toBe(false);
    expect(h.quiz.answer(q.id, 'yes')).toBe('ok');
    expect(h.quiz.getState().winner).toBeNull();
    expect(h.wins).toEqual([]);
  });

  it('does not publish a question when the game is disabled while the call is in flight', async () => {
    // the inertness guarantee: "zero LLM-driven state while disabled" has to
    // survive a disable that lands between the ask and its reply
    let release: (reply: string) => void = () => {};
    const ask = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const h = harness({ ask });
    h.quiz.setEnabled(true);
    expect(h.deps.ask).toHaveBeenCalledTimes(1);
    h.quiz.setEnabled(false);
    release('{"question":"Is it alive?","guess":false}');
    await settle();
    expect(h.quiz.getState().question).toBeNull();
    expect(h.quiz.getState().askedCount).toBe(0);
    expect(h.emitted.every((m) => m.type !== 'quiz' || m.quiz.question === null)).toBe(true);
  });

  it('carries the asker seat on the question and the winner, for the roster-independent bubble', async () => {
    const askers: QuizAsker[] = [{ id: 'e9', name: 'Rey', variant: 'Mage', seat: 5, idle: true }];
    const h = harness({ askers: () => askers, ask: vi.fn(async () => '{"question":"Is it a cat?","guess":true}') });
    h.quiz.setEnabled(true);
    await settle();
    const q = h.quiz.getState().question!;
    expect(q.askerSeat).toBe(5);

    // the asker is evicted mid-question: the bubble must stay answerable, and
    // the winner must still identify the right person
    askers.length = 0;
    expect(h.quiz.answer(q.id, 'yes')).toBe('ok');
    const winner = h.quiz.getState().winner!;
    expect(winner.asker).toBe('e9');
    expect(winner.seat).toBe(5);
    expect(winner.name).toBe('Rey');
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
