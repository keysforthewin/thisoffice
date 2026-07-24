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
    }
  | { type: 'catalog'; catalog: CharacterCatalog };

export interface CharacterEntry {
  /** GLB basename, doubles as the `variant` string persisted in office.json */
  id: string;
  displayName: string;
  pack: string;
  tags: string[];
  /** 'embedded' = full clip set in the GLB; 'shared' = needs the _lib animation library */
  rig: 'embedded' | 'shared';
  /** fetch path for the GLB when it isn't in the static /models/characters dir (user imports) */
  url?: string;
  /** import timestamp for user-imported characters; busts model + thumbnail caches on re-import */
  rev?: number;
  /** runtime size multiplier for imported characters (user-tuned); absent = 1 */
  scale?: number;
}

export interface CharacterCatalog {
  version: number;
  generatedAt: string;
  /** canonical clip name -> acceptable clip names, first match wins */
  clipAliases: Record<string, string[]>;
  characters: CharacterEntry[];
}

/** Fallback list used when catalog.json is unavailable */
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
