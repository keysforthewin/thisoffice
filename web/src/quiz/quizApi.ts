/**
 * The quiz endpoints. Nothing here applies state locally — the server
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

/** Abandon the round in progress and open a fresh one. Works while switched off. */
export async function restartQuiz(): Promise<void> {
  await fetch('/api/quiz/restart', { method: 'POST' });
}

/** Raw-body POST, matching the wall-art and character uploads: no multipart parser server-side. */
export async function uploadEotmPhoto(blob: Blob): Promise<void> {
  await fetch('/api/decor/eotm', { method: 'POST', body: blob });
}
