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

export interface StaffingSettings {
  minEmployees: number;
  maxEmployees: number;
  /** seconds an employee may sit idle before being let go; 0 = they never leave */
  idleTimeoutSec: number;
}

export interface InboxItem {
  id: string;
  project: string;
  /** short preview/summary shown on the whiteboard synopsis */
  text: string;
  /** untruncated prompt (capped server-side); absent on items persisted before this field existed */
  fullText?: string;
  at: string;
}

/** One line on the status whiteboard — a curated feed of office happenings. */
export interface StatusItem {
  id: string;
  at: string;
  /** one readable line, capped server-side */
  text: string;
  kind: 'boss' | 'done' | 'hire' | 'plan' | 'away' | 'session';
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Floor pose of a movable object; y is fixed per item kind (everything sits on the floor). */
export interface ItemPose {
  x: number;
  z: number;
  rotY: number;
}

/**
 * User overrides from build mode. Absent maps/keys mean "use the built-in
 * room-relative default". Overridden items become absolute world coordinates
 * (clamped into the room client-side when the room grows/shrinks).
 */
export interface OfficeLayout {
  /** desk-unit overrides keyed by seat number (0 = boss) */
  seats?: Record<number, ItemPose>;
  /** floor furniture keyed by stable id: couch, couch2, lampBack, lampCouch, lampCouch2, cactusBig, cactusSmall */
  furniture?: Record<string, ItemPose>;
  /** wall-mounted items keyed by id: windowBack, windowLeft, wallArt, pictureFrame → along-wall offset (the wall's local `ox` frame) */
  wallItems?: Record<string, number>;
}

export interface OfficeState {
  boss: BossConfig;
  bossStatus: WorkerStatus;
  employees: Employee[];
  inbox: InboxItem[];
  todos: { project: string; items: TodoItem[]; at?: string } | null;
  /** rolling status feed shown on the status whiteboard (newest last) */
  status: StatusItem[];
  staffing: StaffingSettings;
  /** true while any tailed session has ended its turn and is waiting on the user (ephemeral) */
  waitingForInput: boolean;
  /** build-mode overrides; absent = default layout */
  layout?: OfficeLayout;
}

/**
 * Prefix for a monitor stream line that carries an image payload instead of
 * text (e.g. a PNG an agent Read) — either a data-URL or a plain http(s) URL
 * for URL-sourced image blocks. Travels through the normal streamer queue
 * so it stays ordered with the surrounding text; the client store intercepts
 * it and shows the image on that monitor instead of appending a line.
 */
export const MONITOR_IMAGE_MARKER = '⟦IMG⟧';

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
  /** vertical offset of the character alone (plants them on the chair seat); absent = 0 */
  seatOffset?: number;
  /** vertical offset of chair + character as a unit (lines hands up with the desk); absent = 0 */
  chairHeight?: number;
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
