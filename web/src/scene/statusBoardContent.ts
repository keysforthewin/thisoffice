import type { OfficeState, StatusItem } from '../../../shared/types.ts';

export interface Worker {
  name: string;
  task: string;
}

export interface StatusBoardContent {
  /** newest first, capped to what fits on the board */
  items: Array<{ text: string; kind: StatusItem['kind'] }>;
  workers: Worker[];
}

export const STATUS_BOARD_MAX_ITEMS = 7;

/**
 * Pure projection for the status whiteboard: the rolling server status feed
 * (newest first) plus whoever's working right now. Always renders — an empty
 * feed draws as "(all quiet)".
 */
export function statusBoardContent(office: OfficeState | null): StatusBoardContent {
  const items = (office?.status ?? [])
    .slice(-STATUS_BOARD_MAX_ITEMS)
    .map(({ text, kind }) => ({ text, kind }))
    .reverse();
  const workers: Worker[] = (office?.employees ?? [])
    .filter((e) => e.status === 'working' && e.task)
    .sort((a, b) => a.seat - b.seat)
    .map((e) => ({ name: e.name, task: e.task as string }));
  return { items, workers };
}
