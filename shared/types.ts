export type WorkerStatus = 'idle' | 'working';

export interface Employee {
  id: string;
  name: string;
  seat: number; // 1-based; seat 0 is the boss
  variant: string; // character GLB basename, e.g. "Knight"
  hiredAt: string;
  status: WorkerStatus;
  /** short label of what they're doing right now, e.g. "Bash" or "Explore agent" */
  task: string | null;
}

export interface BossConfig {
  name: string;
  variant: string;
}

export interface InboxItem {
  id: string;
  project: string;
  text: string;
  at: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface OfficeState {
  boss: BossConfig;
  bossStatus: WorkerStatus;
  employees: Employee[];
  inbox: InboxItem[];
  todos: { project: string; items: TodoItem[] } | null;
}

/** Messages from server to client */
export type ServerMsg =
  | { type: 'state'; state: OfficeState }
  | {
      type: 'monitor';
      /** 'boss' or an employee id */
      target: string;
      title?: string;
      append?: string;
      clear?: boolean;
    };

export const CHARACTER_VARIANTS = [
  'Knight',
  'Mage',
  'Rogue',
  'Barbarian',
  'Rogue_Hooded',
  'Skeleton_Warrior',
  'Skeleton_Mage',
  'Skeleton_Rogue',
  'Skeleton_Minion',
] as const;
