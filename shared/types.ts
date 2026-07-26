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
  kind: 'boss' | 'done' | 'hire' | 'plan' | 'away' | 'session' | 'quiz' | 'ask';
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
  /** floor furniture keyed by stable id: couch, couch2, lampBack, lampCouch, lampCouch2, cactusSmall, catPerson */
  furniture?: Record<string, ItemPose>;
  /**
   * Wall-mounted items keyed by id: windowBack, windowLeft, wallArt, eotm, tv,
   * todoBoard, statusBoard.
   *
   * A bare `number` is the legacy shape — the along-wall offset only, on
   * whichever wall the item was hardcoded to before walls became movable. It is
   * still accepted and read as `{ wall: <default>, ox: value, oy: <default> }`,
   * so an office saved before this existed keeps its arrangement.
   */
  wallItems?: Record<string, WallPlacement | number>;
}

/** Where a wall-mounted item hangs: which wall, how far along it, how high. */
export interface WallPlacement {
  wall: WallSide;
  /** along-wall offset in the wall's local frame, measured from the wall's centre */
  ox: number;
  /** height above the floor, in world units (not the wall group's local frame) */
  oy: number;
}

/**
 * The four walls, in perimeter order: each one's `ox` picks up where the
 * previous one's leaves off, so dragging an item past a wall's end carries it
 * around the corner onto the next (see web/src/scene/walls.ts).
 */
export const WALL_SIDES = ['left', 'back', 'right', 'front'] as const;
export type WallSide = (typeof WALL_SIDES)[number];

/** Image formats accepted for the wall painting, and the extension each is stored under. */
export const WALL_ART_EXTS = ['png', 'jpg', 'webp'] as const;
export type WallArtExt = (typeof WALL_ART_EXTS)[number];

/**
 * A user-uploaded painting for the frame behind the boss. Absent = the built-in
 * artwork. Cleared along with the layout when the room is reset, since the
 * painting is a wall hanging like any other.
 */
export interface WallArtConfig {
  /** upload timestamp; doubles as the cache-buster on /api/decor/wallart */
  v: number;
  ext: WallArtExt;
  /** 1 = the image covers the frame exactly; >1 zooms in */
  zoom: number;
  /** -1..1 of the horizontal overflow; 0 = centred, +1 flush with the right edge */
  panX: number;
  /** -1..1 of the vertical overflow; 0 = centred, +1 flush with the top edge.
   *  Absent on paintings framed before vertical panning existed → treated as 0. */
  panY: number;
}

export const WALL_ART_ZOOM_MIN = 1;
export const WALL_ART_ZOOM_MAX = 6;

/** One resolved question in the current round. */
export interface QuizAnswer {
  question: string;
  answer: 'yes' | 'no';
  /** true when the asker was making an outright guess rather than narrowing down */
  guess: boolean;
  /**
   * Legacy, read-only: a question the office made up while Haiku was unreachable.
   * Nothing writes this any more — the office waits for a real question instead
   * of guessing blind — but rounds recorded before that change are still on disk
   * and mid-play, and a blind question's answer is not evidence about the secret
   * word, so `buildQuizPrompt` keeps flagged turns out of the history.
   */
  fallback?: boolean;
  askerName: string;
  at: string;
}

/**
 * The live speech bubble. Null while the office is thinking of its next
 * question, and while the game is disabled.
 */
export interface QuizQuestion {
  /** answers must echo this back; guards against two tabs answering one bubble */
  id: string;
  text: string;
  guess: boolean;
  /** 'boss' | 'catPerson' | an employee id */
  asker: string;
  askerName: string;
  /**
   * The asker's seat, captured when the question was asked: 0 for the boss, the
   * employee's seat number, `null` for Kat Person (furniture, not staff). The
   * game is player-paced, so a bubble can outlive its asker's eviction from the
   * roster (`Office.fireIfIdle`, 60 s by default) — carrying the seat here keeps
   * the bubble placeable and therefore answerable regardless of the live roster.
   */
  askerSeat: number | null;
  at: string;
}

export interface QuizWinner {
  name: string;
  variant: string;
  /** 'boss' | 'catPerson' | an employee id — durable, unlike a name lookup */
  asker: string;
  /** the winner's seat at win time; see `QuizQuestion.askerSeat` */
  seat: number | null;
  at: string;
}

/** Photo hanging in the Employee of the Month frame. Absent = empty frame. */
export interface EotmPhoto {
  /** capture timestamp; doubles as the cache-buster on /api/decor/eotm */
  v: number;
  name: string;
}

export interface QuizState {
  enabled: boolean;
  /**
   * Bumped every round. Informational only: round ids carry no ordering, so
   * clients cannot use one to decide whether a bubble is stale — the question
   * `id` echoed back on an answer is the only staleness guard.
   */
  roundId: string;
  askedCount: number;
  answers: QuizAnswer[];
  question: QuizQuestion | null;
  /** true while the server is waiting on a client to deliver the win photo (never persisted) */
  awaitingPhoto: boolean;
  winner: QuizWinner | null;
  photo?: EotmPhoto;
}

/**
 * A round has no question limit and no concession: it runs until the office
 * guesses right. It is ambient play while the agents work, and a deadline only
 * bought hopeless long-odds guessing (see server/src/quizPrompt.ts).
 */
/** Questions stay one short line; anything longer is truncated. */
export const QUIZ_QUESTION_MAX_CHARS = 120;

/**
 * A tool call that is unconditionally blocked on the user — plan approval or a
 * question menu — surfaced so the office can show *what* is being asked, not
 * just that something is. Informational only: the server tails transcripts and
 * has no channel back into the session, so the options are shown for you to
 * answer in your own terminal (see ASK_TOOLS in server/src/transcript.ts).
 */
export interface PendingAsk {
  /** the tool_use id — unique per transcript, and the dedupe key */
  id: string;
  kind: 'plan' | 'question';
  project: string;
  /** one line: the plan's headline, or the question text */
  summary: string;
  /** menu labels in CLI order; empty for a plain plan approval */
  options: string[];
  at: string;
}

/** Asks and quiz questions stay one short line; anything longer is truncated. */
export const ASK_SUMMARY_MAX_CHARS = 120;

export interface OfficeState {
  /** HUD title; user-editable, defaults to "This Office" */
  officeName: string;
  boss: BossConfig;
  bossStatus: WorkerStatus;
  employees: Employee[];
  inbox: InboxItem[];
  todos: { project: string; items: TodoItem[]; at?: string } | null;
  /** rolling status feed shown on the status whiteboard (newest last) */
  status: StatusItem[];
  staffing: StaffingSettings;
  /** show the office cat in the back corner; she is still pickable as a character when off */
  katPerson: boolean;
  /** true while any tailed session has ended its turn and is waiting on the user (ephemeral) */
  waitingForInput: boolean;
  /**
   * What the session is blocked on, when that is knowable (ephemeral). Never
   * outlives waitingForInput — Office clears it whenever the beacon goes dark.
   */
  pendingAsk?: PendingAsk;
  /** build-mode overrides; absent = default layout */
  layout?: OfficeLayout;
  /** uploaded painting behind the boss; absent = the built-in artwork */
  wallArt?: WallArtConfig;
}

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface DayStats {
  tokens: number; // input+output added that day (not cache)
  toolCalls: number;
  prompts: number;
}

export interface UsageStats {
  /** ISO date-time of the first ever launch (persisted; never resets) */
  trackingSince: string;
  tokensByModel: Record<string, ModelTokens>;
  toolCalls: Record<string, number>; // by tool name
  prompts: number;
  sessions: number;
  subagents: number; // Task|Agent tool launches
  webSearches: number;
  webFetches: number;
  turns: number;
  turnMsTotal: number;
  longestTurnMs: number;
  peakHeadcount: number;
  /** employees on staff right now; sampled server-side, so the TV needs no roster access */
  headcount: number;
  /** keyed YYYY-MM-DD, last ~30 days */
  byDay: Record<string, DayStats>;
  /** UTC hour-of-day 0-23 → prompt count (the client renders it in the viewer's local zone) */
  hourCounts: Record<string, number>;
  /**
   * `"<dow>-<hour>"` (dow 0=Sunday, both UTC) → input+output tokens, all time,
   * never pruned — 168 keys at most. UTC like hourCounts; the client shifts it
   * into the viewer's zone, which rolls the weekday when the hour wraps.
   */
  tokensByDowHour: Record<string, number>;
  /** 20 Questions wins, keyed by employee name (a rehired name inherits its wins) */
  gameWins: Record<string, number>;
  /**
   * Characters streamed onto each employee's monitor, all time, keyed by name for the
   * same reason gameWins is: an employee id is minted fresh on every rehire, while a
   * seat's remembered name carries across an idle eviction.
   */
  charsByEmployee: Record<string, number>;
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
  | { type: 'catalog'; catalog: CharacterCatalog }
  | { type: 'stats'; stats: UsageStats }
  | {
      type: 'quiz';
      quiz: QuizState;
      /**
       * Set only on the message sent to the single client asked to take the
       * winner's photo. Never present on the state sent to a new connection.
       */
      capture?: QuizWinner;
    };

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
  /** forward/back offset of the character alone along the desk axis (+ = toward the desk,
   *  − = back into the chair, for characters that perch on the front edge); absent = 0 */
  chairForward?: number;
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
