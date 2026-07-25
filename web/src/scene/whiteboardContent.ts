import type { OfficeState, TodoItem } from '../../../shared/types.ts';

export interface Worker {
  name: string;
  task: string;
}

export type BoardContent =
  | { mode: 'todos'; project: string; items: TodoItem[] }
  | { mode: 'synopsis'; project: string; summary: string; workers: Worker[] }
  | { mode: 'empty' };

/**
 * Pure projection from server OfficeState to what the whiteboard should show.
 * Real todos always win (TodoWrite is the ground truth for "what's the plan").
 * Absent real todos, fall back to a synopsis of the latest inbox prompt plus
 * whoever's currently working, so the board isn't blank between TodoWrite calls.
 */
export function boardContent(office: OfficeState | null): BoardContent {
  const todos = office?.todos ?? null;
  if (todos && todos.items.length > 0) {
    return { mode: 'todos', project: todos.project, items: todos.items };
  }

  const latestInbox = office?.inbox.at(-1) ?? null;
  const workers: Worker[] = (office?.employees ?? [])
    .filter((e) => e.status === 'working' && e.task)
    .sort((a, b) => a.seat - b.seat)
    .map((e) => ({ name: e.name, task: e.task as string }));

  if (latestInbox || workers.length > 0) {
    return {
      mode: 'synopsis',
      project: latestInbox?.project ?? '',
      summary: latestInbox?.text ?? '',
      workers,
    };
  }

  return { mode: 'empty' };
}
