import type { OfficeState, TodoItem } from '../../../shared/types.ts';

/** An all-completed list older than this stops occupying the todo board. */
export const TODO_STALE_MS = 10 * 60_000;

export type BoardContent =
  | { mode: 'todos'; project: string; items: TodoItem[] }
  | { mode: 'empty' };

/**
 * Pure projection from server OfficeState to what the todo whiteboard shows.
 * Todos only — the live synopsis moved to the status board (statusBoardContent).
 * A fully-completed list goes stale after TODO_STALE_MS so the board doesn't
 * show last week's crossed-off plan while new work streams in.
 */
export function boardContent(office: OfficeState | null, now = Date.now()): BoardContent {
  const todos = office?.todos ?? null;
  if (todos && todos.items.length > 0) {
    const allDone = todos.items.every((i) => i.status === 'completed');
    // missing `at` (old server) counts as epoch — an all-done list is stale immediately
    const at = todos.at ? Date.parse(todos.at) : 0;
    if (!(allDone && now - at > TODO_STALE_MS)) {
      return { mode: 'todos', project: todos.project, items: todos.items };
    }
  }
  return { mode: 'empty' };
}
